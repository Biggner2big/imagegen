'use strict';

const selectors = require('../../config/selectors.json');
const { SelectorResolver } = require('./selector-resolver');
const {
  AppError,
  RecoverableError,
  SelectorNotFoundError,
  SkipSignal,
  StopSignal
} = require('./errors');

const GEMINI_URL = 'https://gemini.google.com/app';
const ATTACH_PROTOCOL = '1.3';
const MIN_GENERATED_SIZE = 512;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * This function is serialised and evaluated inside the Gemini page. It must not
 * reference anything from Node. It installs `window.__gbs`, a tiny DOM helper
 * that understands the selector chains from config/selectors.json, including
 * the non-standard `:has-text("...")` pseudo used by the config file.
 */
function pageHelper() {
  if (window.__gbs && window.__gbs.version === 2) return true;

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const enabled = (el) => {
    if (!el) return false;
    if (el.disabled) return false;
    return el.getAttribute('aria-disabled') !== 'true';
  };

  const parseSelector = (raw) => {
    let css = String(raw);
    let text = null;
    const re = /:has-text\(\s*(["'])([\s\S]*?)\1\s*\)/g;
    const match = re.exec(raw);
    if (match) {
      text = match[2];
      css = String(raw).replace(match[0], '');
    }
    return { css: css.trim(), text };
  };

  const collect = (chain) => {
    const out = [];
    for (const raw of chain || []) {
      const parsed = parseSelector(raw);
      let elements;
      try {
        elements = Array.from(document.querySelectorAll(parsed.css));
      } catch (err) {
        continue;
      }
      let filtered = elements;
      if (parsed.text) {
        const needle = parsed.text.toLowerCase();
        filtered = filtered.filter((el) => ((el.innerText || el.textContent || '') + '').toLowerCase().includes(needle));
      }
      for (const el of filtered) if (!out.includes(el)) out.push(el);
    }
    return out;
  };

  window.__gbs = {
    version: 2,
    visible,
    enabled,
    collect,

    findByChain(chain, opts) {
      const options = opts || {};
      for (const el of collect(chain)) {
        if (!visible(el)) continue;
        if (options.enabled && !enabled(el)) continue;
        return el;
      }
      return null;
    },

    findIncludingHidden(chain) {
      for (const el of collect(chain)) return el;
      return null;
    },

    existsByChain(chain, opts) {
      return !!this.findByChain(chain, opts);
    },

    countByChain(chain, opts) {
      const options = opts || {};
      return collect(chain).filter((el) => visible(el) && (!options.enabled || enabled(el))).length;
    },

    countIncludingHidden(chain) {
      return collect(chain).length;
    },

    visitAllByChain(chain, visit) {
      for (const el of collect(chain)) {
        if (visible(el)) visit(el);
      }
    },

    bigImages(chain) {
      return collect(chain)
        .map((el) => {
          const src = el.currentSrc || el.src || '';
          return {
            src,
            w: el.naturalWidth || el.width || 0,
            h: el.naturalHeight || el.height || 0,
            complete: !!el.complete
          };
        })
        .filter((img) => !!img.src && img.w > 0 && img.h > 0);
    },

    setPromptText(chain, text) {
      const el = this.findByChain(chain);
      if (!el) return false;
      el.focus();
      const tag = el.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('insertText', false, text);
      } catch (err) {
        el.textContent = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },

    getPromptText(chain) {
      const el = this.findByChain(chain);
      if (!el) return '';
      if ((el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && typeof el.value === 'string') return el.value;
      return el.innerText || el.textContent || '';
    },

    textByChain(chain) {
      const el = this.findByChain(chain);
      if (!el) return '';
      return (el.innerText || el.textContent || '').trim();
    },

    pageInfo() {
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        visibility: document.visibilityState
      };
    }
  };

  return true;
}

/**
 * Wraps every interaction with the real gemini.google.com page. All DOM access
 * goes through Electron's webContents.debugger (CDP) so no runtime automation
 * dependency is required.
 */
class GeminiAdapter {
  constructor(webContents, logger) {
    this.wc = webContents;
    this.logger = logger;
    this.resolver = new SelectorResolver(selectors, logger);
    this.attached = false;
    this.helperReady = false;

    const reset = () => {
      this.helperReady = false;
      this.resolver.clearCache();
    };
    if (this.wc && typeof this.wc.on === 'function') {
      this.wc.on('did-finish-load', reset);
      this.wc.on('did-navigate', reset);
      this.wc.on('did-navigate-in-page', reset);
    }
    if (this.wc && this.wc.debugger && typeof this.wc.debugger.on === 'function') {
      this.wc.debugger.on('detach', () => {
        this.attached = false;
        this.helperReady = false;
      });
    }
  }

  getPageUrl() {
    try {
      return this.wc && !this.wc.isDestroyed() ? (this.wc.getURL() || '') : '';
    } catch (err) {
      return '';
    }
  }

  /* ---------------------------------------------------------------- */
  /* CDP plumbing                                                     */
  /* ---------------------------------------------------------------- */

  async attach() {
    if (!this.wc || this.wc.isDestroyed()) {
      throw new AppError('VIEW_DESTROYED', 'The Gemini view is not available.', { retryable: true });
    }
    if (this.attached) return;

    try {
      this.wc.debugger.attach(ATTACH_PROTOCOL);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (/already attached/i.test(message)) {
        try {
          this.attached = this.wc.debugger.isAttached();
        } catch (inner) {
          this.attached = false;
        }
        if (!this.attached) {
          throw new AppError('DEBUGGER_UNAVAILABLE', 'Cannot attach to the Gemini page. Close DevTools (Ctrl+Shift+I) and try again.', { retryable: true });
        }
      } else {
        throw new AppError('DEBUGGER_UNAVAILABLE', `Cannot attach to the Gemini page: ${message}`, { retryable: true });
      }
    }

    try {
      await this.wc.debugger.sendCommand('Page.enable');
      await this.wc.debugger.sendCommand('Runtime.enable');
      await this.wc.debugger.sendCommand('DOM.enable');
      await this.wc.debugger.sendCommand('Network.enable');
    } catch (err) {
      throw new AppError('DEBUGGER_UNAVAILABLE', `Could not initialise the Gemini page debugger: ${err.message}`, { retryable: true });
    }

    this.attached = true;
    this.helperReady = false;
    await this.ensureHelper(true);
  }

  detach() {
    try {
      if (this.wc && !this.wc.isDestroyed() && this.wc.debugger.isAttached()) this.wc.debugger.detach();
    } catch (err) { /* best effort */ }
    this.attached = false;
    this.helperReady = false;
  }

  async ensureHelper(force = false) {
    if (this.helperReady && !force) return;
    if (!this.attached) await this.attach();
    try {
      await this.execRaw(`(${pageHelper.toString()})()`);
      this.helperReady = true;
    } catch (err) {
      if (force) throw err;
    }
  }

  async execRaw(expression) {
    if (!this.attached) await this.attach();
    const params = {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    };
    let response;
    try {
      response = await this.wc.debugger.sendCommand('Runtime.evaluate', params);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (/Execution context was destroyed|Cannot find context|Target closed|Session closed/i.test(message)) {
        this.helperReady = false;
        await sleep(600);
        if (!this.wc || this.wc.isDestroyed()) {
          throw new AppError('VIEW_DESTROYED', 'The Gemini view was closed.', { retryable: true });
        }
        response = await this.wc.debugger.sendCommand('Runtime.evaluate', params);
      } else {
        throw err;
      }
    }

    if (response && response.exceptionDetails) {
      const exception = response.exceptionDetails.exception || {};
      const message = exception.description || response.exceptionDetails.text || 'Page script error';
      throw new AppError('PAGE_SCRIPT_ERROR', message, { retryable: true });
    }
    return response && response.result ? response.result.value : undefined;
  }

  async exec(expression) {
    await this.ensureHelper();
    return this.execRaw(expression);
  }

  async evaluateObject(expression) {
    if (!this.attached) await this.attach();
    const response = await this.wc.debugger.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: false,
      awaitPromise: false,
      userGesture: true
    });
    if (response && response.exceptionDetails) return null;
    return response && response.result ? response.result.objectId : null;
  }

  async probe(exec, key) {
    return this.resolver.probeAll(exec);
  }

  /* ---------------------------------------------------------------- */
  /* Selector helpers                                                 */
  /* ---------------------------------------------------------------- */

  chainOf(key) {
    const chain = selectors[key];
    if (!Array.isArray(chain) || chain.length === 0) throw new SelectorNotFoundError(key, []);
    return chain;
  }

  async findSelector(key, options = {}) {
    await this.ensureHelper();
    return this.resolver.find((expression) => this.exec(expression), key, options);
  }

  async exists(key, options = {}) {
    try {
      await this.ensureHelper();
      const chain = this.chainOf(key);
      return !!(await this.exec(`__gbs.existsByChain(${JSON.stringify(chain)}, ${JSON.stringify(options)})`));
    } catch (err) {
      return false;
    }
  }

  async count(key, options = {}) {
    try {
      await this.ensureHelper();
      const chain = this.chainOf(key);
      return Number(await this.exec(`__gbs.countByChain(${JSON.stringify(chain)}, ${JSON.stringify(options)})`)) || 0;
    } catch (err) {
      return 0;
    }
  }

  async clickKey(key) {
    await this.ensureHelper();
    const chain = this.chainOf(key);
    const clicked = await this.exec(`
      (() => {
        const el = __gbs.findByChain(${JSON.stringify(chain)}, { enabled: true });
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
        el.click();
        return true;
      })()
    `);
    if (!clicked) throw new SelectorNotFoundError(key, chain);
    return true;
  }

  async textOf(key) {
    await this.ensureHelper();
    const chain = this.chainOf(key);
    return String(await this.exec(`__gbs.textByChain(${JSON.stringify(chain)})`) || '');
  }

  /* ---------------------------------------------------------------- */
  /* Page state                                                       */
  /* ---------------------------------------------------------------- */

  async checkLoginStatus() {
    try {
      const url = this.getPageUrl();
      if (!url || url === 'about:blank') return 'unknown';
      if (url.includes('accounts.google.com')) return 'needs_login';
      await this.ensureHelper();
      if (await this.exists('loginIndicator')) return 'logged_in';
      if (await this.exists('signInButton')) return 'needs_login';
      return 'unknown';
    } catch (err) {
      if (this.logger) this.logger.warn({ err: err.message }, 'login status check failed');
      return 'unknown';
    }
  }

  async pageInfo() {
    await this.ensureHelper();
    return this.exec('__gbs.pageInfo()');
  }

  async isCaptchaVisible() {
    return this.exists('captchaIndicator');
  }

  async isUsageLimitVisible() {
    return this.exists('usageLimitBanner');
  }

  async readErrorCard() {
    try {
      await this.ensureHelper();
      const chain = this.selectors.errorCard ? this.chainOf('errorCard') : [];
      if (!chain.length) return '';
      return String(await this.exec(`
        (() => {
          const el = __gbs.findByChain(${JSON.stringify(chain)});
          if (!el) return '';
          const text = (el.innerText || el.textContent || '').trim();
          return text.length > 3 ? text.slice(0, 300) : '';
        })()
      `) || '');
    } catch (err) {
      return '';
    }
  }

  /* ---------------------------------------------------------------- */
  /* Chat / upload / prompt                                           */
  /* ---------------------------------------------------------------- */

  async waitForEditor(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.exists('promptEditor');
      if (ready) return true;
      await sleep(700);
    }
    throw new AppError(
      'NEEDS_LOGIN',
      'The Gemini prompt editor did not appear. Sign in to Gemini in the right-hand panel and wait for the page to load.',
      { pause: true }
    );
  }

  /**
   * Starts a fresh conversation before every job so a previous image or prompt
   * cannot leak into the next generation. Falls back to reloading /app.
   */
  async beginNewChat() {
    try {
      const clicked = await this.exec(`
        (() => {
          const el = __gbs.findByChain(${JSON.stringify(this.selectors.newChatButton || [])});
          if (!el) return false;
          try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
          el.click();
          return true;
        })()
      `);
      if (clicked) {
        await sleep(1200);
        await this.waitForEditor(20000);
        return true;
      }
    } catch (err) {
      if (this.logger) this.logger.warn({ err: err.message }, 'new chat button failed, reloading Gemini');
    }

    this.helperReady = false;
    try {
      await this.wc.loadURL(GEMINI_URL);
    } catch (err) {
      throw new AppError('NETWORK_ERROR', `Could not load Gemini: ${err.message}`, { retryable: true });
    }
    await sleep(800);
    await this.waitForEditor(30000);
    return true;
  }

  async attachmentCount() {
    return this.count('uploadedAttachment');
  }

  async snapshotImages() {
    try {
      await this.ensureHelper();
      const chain = this.chainOf('generatedImage');
      const images = await this.exec(`__gbs.bigImages(${JSON.stringify(chain)})`);
      return Array.isArray(images) ? images : [];
    } catch (err) {
      return [];
    }
  }

  async countGeneratedImages() {
    const images = await this.snapshotImages();
    return images.filter((img) => img.w >= MIN_GENERATED_SIZE && img.h >= MIN_GENERATED_SIZE).length;
  }

  async trySetFilesOnInput(filePath) {
    try {
      const chain = this.chainOf('fileInput');
      const objectId = await this.evaluateObject(`__gbs.findIncludingHidden(${JSON.stringify(chain)})`);
      if (!objectId) return false;
      await this.wc.debugger.sendCommand('DOM.setFileInputFiles', { objectId, files: [filePath] });
      await sleep(300);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Uploads one image through Gemini's own file chooser. The chooser is
   * intercepted with Page.setInterceptFileChooserDialog and fed via
   * DOM.setFileInputFiles (AGENT.md 8.1).
   */
  async uploadFile(filePath, timeoutMs = 45000) {
    await this.ensureHelper();

    if (await this.trySetFilesOnInput(filePath)) {
      await this.verifyUploadComplete(0, timeoutMs);
      return true;
    }

    await this.wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    let chooserParams = null;
    const onMessage = (_event, method, params) => {
      if (method === 'Page.fileChooserOpened') chooserParams = params;
    };
    this.wc.debugger.on('message', onMessage);

    try {
      await this.clickKey('uploadButton');
      const deadline = Date.now() + 20000;
      let handled = false;
      while (Date.now() < deadline) {
        if (chooserParams && chooserParams.backendNodeId) {
          await this.wc.debugger.sendCommand('DOM.setFileInputFiles', {
            backendNodeId: chooserParams.backendNodeId,
            files: [filePath]
          });
          handled = true;
          break;
        }
        if (await this.trySetFilesOnInput(filePath)) {
          handled = true;
          break;
        }
        await sleep(400);
      }
      if (!handled) {
        throw new RecoverableError('UPLOAD_TIMEOUT', 'Gemini did not open a file chooser after clicking upload.');
      }
    } finally {
      this.wc.debugger.removeListener('message', onMessage);
      try {
        await this.wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false });
      } catch (err) { /* page may be mid-navigation */ }
    }

    await this.verifyUploadComplete(0, timeoutMs);
    return true;
  }

  async verifyUploadComplete(baselineCount = 0, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = await this.attachmentCount();
      if (count > baselineCount) return true;
      await sleep(500);
    }
    throw new RecoverableError('UPLOAD_TIMEOUT', 'The image did not finish attaching in Gemini.');
  }

  async enterPrompt(promptText) {
    await this.ensureHelper();
    const text = String(promptText == null ? '' : promptText);
    if (!text.trim()) throw new AppError('PROMPT_EMPTY', 'The master prompt is empty.', { fatal: true });

    const chain = this.chainOf('promptEditor');
    const applied = await this.exec(`__gbs.setPromptText(${JSON.stringify(chain)}, ${JSON.stringify(text)})`);
    if (!applied) throw new SelectorNotFoundError('promptEditor', chain);

    await sleep(250);
    const actual = String(await this.exec(`__gbs.getPromptText(${JSON.stringify(chain)})`) || '');
    const required = Math.min(10, text.trim().length);
    if (actual.trim().length < required) {
      throw new RecoverableError('PROMPT_REJECTED', 'The prompt text did not land in the Gemini editor.');
    }
    return true;
  }

  async submitPrompt() {
    await this.ensureHelper();
    const editorChain = this.chainOf('promptEditor');
    const sendChain = this.chainOf('sendButton');

    const clicked = await this.exec(`
      (() => {
        const el = __gbs.findByChain(${JSON.stringify(sendChain)}, { enabled: true });
        if (!el) return false;
        el.click();
        return true;
      })()
    `);

    if (!clicked) {
      await this.exec(`
        (() => {
          const el = __gbs.findByChain(${JSON.stringify(editorChain)});
          if (el) el.focus();
          return !!el;
        })()
      `);
      try {
        this.wc.focus();
        this.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        this.wc.sendInputEvent({ type: 'char', keyCode: '\r' });
        this.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      } catch (err) { /* fall through to verification */ }
    }

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const text = String(await this.exec(`__gbs.getPromptText(${JSON.stringify(editorChain)})`) || '').trim();
      if (text.length === 0) return true;
      if (await this.exists('generatingIndicator')) return true;
      await sleep(500);
    }
    throw new RecoverableError('PROMPT_REJECTED', 'Gemini did not accept the prompt (the editor was not cleared).');
  }

  /**
   * Waits until the page contains a generated image that was not present in the
   * baseline snapshot, and that has fully loaded and stayed stable.
   */
  async waitForNewImage(beforeSrcs, timeoutMs = 180000, options = {}) {
    const shouldAbort = options.shouldAbort || null;
    const before = new Set(beforeSrcs || []);
    const deadline = Date.now() + timeoutMs;
    let candidate = null;
    let stableTicks = 0;
    let lastErrorCheck = 0;

    while (Date.now() < deadline) {
      if (shouldAbort) {
        const action = shouldAbort();
        if (action === 'stop') throw new StopSignal();
        if (action === 'skip') throw new SkipSignal();
      }

      if (await this.isCaptchaVisible()) {
        throw new AppError('CAPTCHA', 'Gemini is asking for a CAPTCHA. Solve it in the Gemini panel, then press RESUME.', { pause: true });
      }
      if (await this.isUsageLimitVisible()) {
        throw new AppError('USAGE_LIMIT', 'Gemini usage limit reached. The batch has been stopped.', { fatal: true });
      }

      const images = await this.snapshotImages();
      const fresh = images.filter((img) =>
        !before.has(img.src) && img.complete && img.w >= MIN_GENERATED_SIZE && img.h >= MIN_GENERATED_SIZE);

      if (fresh.length > 0) {
        const src = fresh[fresh.length - 1].src;
        if (src === candidate) {
          stableTicks += 1;
        } else {
          candidate = src;
          stableTicks = 0;
        }
        if (stableTicks >= 2) return src;
      } else if (Date.now() - lastErrorCheck > 4000) {
        lastErrorCheck = Date.now();
        const errorText = await this.readErrorCard();
        if (errorText) {
          throw new RecoverableError('GENERATION_ERROR', `Gemini returned an error: ${errorText}`);
        }
      }

      await sleep(1500);
    }

    if (candidate) return candidate;
    throw new RecoverableError('GENERATION_TIMEOUT', 'Gemini did not produce a new image before the timeout.');
  }

  /* ---------------------------------------------------------------- */
  /* Diagnostics                                                      */
  /* ---------------------------------------------------------------- */

  async diagnostics() {
    await this.attach();
    const info = await this.pageInfo().catch(() => ({ url: this.getPageUrl(), title: '', readyState: 'unknown' }));
    const results = await this.resolver.probeAll((expression) => this.exec(expression));
    return { url: info ? info.url : this.getPageUrl(), title: info ? info.title : '', results };
  }
}

module.exports = { GeminiAdapter, pageHelper, GEMINI_URL };
