'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { AppError } = require('../automation/errors');

/**
 * Saves a generated image to disk from either a blob:/https:/data: URL.
 *
 * Primary strategy: fetch the bytes from the page context (cookies included)
 * and write them from the main process. Fallback: Electron's session download
 * pipeline via will-download (AGENT.md 5.4).
 */
class DownloadManager {
  constructor(webContents, logger = null) {
    this.wc = webContents;
    this.logger = logger;
  }

  async saveImage(src, outputPath, timeoutMs = 60000) {
    if (!src || typeof src !== 'string') {
      throw new AppError('DOWNLOAD_FAILED', 'No generated image source was found.', { retryable: true });
    }
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });

    if (src.startsWith('data:')) {
      const base64 = src.slice(src.indexOf(',') + 1);
      await this.writeBase64(base64, outputPath);
      return outputPath;
    }

    try {
      const base64 = await this.fetchAsBase64(src, timeoutMs);
      if (base64) {
        await this.writeBase64(base64, outputPath);
        return outputPath;
      }
    } catch (err) {
      if (this.logger) this.logger.warn({ err: err.message, url: src.slice(0, 120) }, 'page-context download failed, falling back to session download');
    }

    await this.downloadViaSession(src, outputPath, timeoutMs);
    return outputPath;
  }

  async writeBase64(base64, outputPath) {
    const buffer = Buffer.from(String(base64), 'base64');
    if (!buffer.length) throw new AppError('DOWNLOAD_FAILED', 'Downloaded image was empty.', { retryable: true });
    await fsp.writeFile(outputPath, buffer);
  }

  async fetchAsBase64(src, timeoutMs) {
    if (!this.wc || this.wc.isDestroyed()) {
      throw new AppError('DOWNLOAD_FAILED', 'The Gemini view is no longer available.', { retryable: true });
    }
    const script = `
      (async () => {
        try {
          const response = await fetch(${JSON.stringify(src)}, { credentials: 'include' });
          if (!response.ok) return { error: 'HTTP ' + response.status };
          const buffer = await response.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          if (!bytes.length) return { error: 'Empty body' };
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          return { data: btoa(binary) };
        } catch (err) {
          return { error: String(err && err.message ? err.message : err) };
        }
      })()
    `;

    const result = await Promise.race([
      this.wc.executeJavaScript(script, true),
      new Promise((_resolve, reject) => setTimeout(
        () => reject(new AppError('DOWNLOAD_FAILED', `Download timed out after ${timeoutMs}ms`, { retryable: true })),
        timeoutMs
      ))
    ]);

    if (!result || typeof result !== 'object') {
      throw new AppError('DOWNLOAD_FAILED', 'Unexpected download result from page.', { retryable: true });
    }
    if (result.error) {
      throw new AppError('DOWNLOAD_FAILED', `Page download failed: ${result.error}`, { retryable: true });
    }
    return result.data;
  }

  downloadViaSession(src, outputPath, timeoutMs) {
    return new Promise((resolve, reject) => {
      const session = this.wc.session;
      let settled = false;
      let timer = null;

      const cleanup = () => {
        session.removeListener('will-download', onWillDownload);
        if (timer) clearTimeout(timer);
      };

      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(outputPath);
      };

      const onWillDownload = (_event, item) => {
        if (settled) return;
        try {
          item.setSavePath(outputPath);
        } catch (err) {
          finish(new AppError('DOWNLOAD_FAILED', `Could not set download path: ${err.message}`, { retryable: true }));
          return;
        }
        item.once('done', (_doneEvent, state) => {
          if (state === 'completed') finish(null);
          else finish(new AppError('DOWNLOAD_FAILED', `Session download ${state}`, { retryable: true }));
        });
      };

      timer = setTimeout(() => finish(new AppError('DOWNLOAD_FAILED', `Download timed out after ${timeoutMs}ms`, { retryable: true })), timeoutMs);
      session.once('will-download', onWillDownload);

      try {
        this.wc.downloadURL(src);
      } catch (err) {
        finish(new AppError('DOWNLOAD_FAILED', `Could not start download: ${err.message}`, { retryable: true }));
      }
    });
  }
}

module.exports = { DownloadManager };
