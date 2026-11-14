'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const config = require('../../config/app.config.json');
const { GeminiAdapter } = require('./gemini-adapter');
const { DownloadManager } = require('../main/download-manager');
const {
  AppError,
  RecoverableError,
  RETRY_LIMITS,
  SkipSignal,
  StopSignal,
  classifyError
} = require('./errors');
const fileService = require('../services/file-service');
const imageService = require('../services/image-service');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeSegment(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
}

/**
 * Sequential generation engine. The loop processes exactly one image at a time
 * (R6): the next job is only selected after the previous one has been
 * downloaded and verified.
 */
class GenerationEngine {
  constructor(options = {}) {
    this.adapter = options.adapter || new GeminiAdapter(options.webContents, options.logger);
    this.downloader = options.downloader || new DownloadManager(
      options.adapter ? options.adapter.wc : options.webContents,
      options.logger
    );
    this.logger = options.logger || console;
    this.jobsRepo = options.jobsRepo;
    this.promptsRepo = options.promptsRepo || null;
    this.emit = options.emit || (() => {});
    this.logEvent = options.logEvent || (() => {});
    this.settingsProvider = options.settingsProvider || (() => options.settings || {});

    this.batch = null;
    this.currentJob = null;
    this.running = false;
    this.paused = false;
    this.stopped = false;
    this.skipRequested = false;
    this.lastError = null;
  }

  settings() {
    return { ...config, ...(this.settingsProvider() || {}) };
  }

  getSnapshot() {
    return {
      running: this.running,
      paused: this.paused,
      stopped: this.stopped,
      batchId: this.batch ? this.batch.id : null,
      current: this.currentJob ? {
        jobId: this.currentJob.id,
        name: this.currentJob.original_name,
        status: this.currentJob.status,
        startedAt: this.currentJob.started_at || null
      } : null,
      lastError: this.lastError
    };
  }

  async start(batch) {
    if (this.running) throw new AppError('BATCH_RUNNING', 'A batch is already running.');
    this.batch = batch;
    this.running = true;
    this.paused = false;
    this.stopped = false;
    this.skipRequested = false;
    this.lastError = null;

    this.emit('batch-state', this.getSnapshot());
    this.logEvent(null, 'info', 'batch', `Batch started: ${batch.total} image(s), prompt "${batch.prompt_name || 'default'}"`, { batchId: batch.id });

    let finalStatus = 'interrupted';
    try {
      await this.adapter.attach();

      while (!this.stopped) {
        if (this.paused) {
          await sleep(400);
          continue;
        }

        const job = this.jobsRepo.getNextPendingJob(batch.id);
        if (!job) break;

        this.currentJob = job;
        try {
          await this.processJob(job);
        } catch (err) {
          await this.handleFailure(job, err);
        } finally {
          this.currentJob = null;
          this.skipRequested = false;
          this.emit('batch-state', this.getSnapshot());
        }

        if (!this.stopped && !this.paused) {
          const delay = this.settings().timeBetweenJobsMs || 0;
          if (delay > 0) await sleep(delay);
        }
      }

      if (this.stopped) {
        finalStatus = 'stopped';
      } else if (this.paused) {
        finalStatus = 'paused';
      } else {
        const counts = this.jobsRepo.countByStatus(batch.id);
        finalStatus = counts.failed > 0 ? 'completed_with_errors' : 'completed';
      }
    } catch (err) {
      const info = classifyError(err);
      finalStatus = 'interrupted';
      this.lastError = { code: info.code, message: info.message, at: new Date().toISOString() };
      this.logger.error({ err: err.message, code: info.code }, 'generation engine stopped unexpectedly');
      this.logEvent(null, 'error', 'batch', `Engine stopped: ${info.code} - ${info.message}`, { batchId: batch.id });
      this.emit('notice', {
        level: 'error',
        code: info.code,
        message: `Automation stopped: ${info.message}`,
        sticky: true
      });
    } finally {
      this.running = false;
      try {
        if (finalStatus === 'paused' || finalStatus === 'interrupted') {
          this.jobsRepo.updateBatchStatus(batch.id, finalStatus);
        } else {
          this.jobsRepo.finalizeBatch(batch.id, finalStatus);
        }
      } catch (err) {
        this.logger.error({ err: err.message }, 'could not finalise batch');
      }
      this.emit('batch-state', this.getSnapshot());
      this.logEvent(null, 'info', 'batch', `Batch finished with status ${finalStatus}`, { batchId: batch.id });
    }
    return finalStatus;
  }

  async processJob(job) {
    const batch = this.batch;
    const startTime = Date.now();
    this.checkAbort();

    // ---- PREPARING ----
    await this.setStatus(job, 'PREPARING', { started_at: new Date().toISOString() });

    const readable = await fileService.verifyReadable(job.original_path);
    if (!readable) {
      throw new AppError('INVALID_IMAGE', `Input image is missing or unreadable: ${job.original_name}`, { retryable: true });
    }

    const login = await this.adapter.checkLoginStatus();
    if (login !== 'logged_in') {
      throw new AppError('NEEDS_LOGIN', 'You are not signed in to Gemini. Sign in in the right-hand panel, then press RESUME.', { pause: true });
    }
    if (await this.adapter.isCaptchaVisible()) {
      throw new AppError('CAPTCHA', 'Gemini is showing a CAPTCHA. Solve it in the Gemini panel, then press RESUME.', { pause: true });
    }
    if (await this.adapter.isUsageLimitVisible()) {
      throw new AppError('USAGE_LIMIT', 'The Gemini usage limit has been reached. Try again later.', { fatal: true });
    }
    this.checkAbort();

    // ---- NEW CHAT (keeps each image independent) ----
    if (this.settings().newChatPerJob !== false) {
      await this.adapter.beginNewChat();
      await this.adapter.waitForEditor(30000);
    }
    this.checkAbort();

    // ---- UPLOADING ----
    const baselineAttachments = await this.adapter.attachmentCount();
    await this.setStatus(job, 'UPLOADING');
    await this.adapter.uploadFile(job.original_path, this.settings().uploadTimeoutMs);
    await this.adapter.verifyUploadComplete(baselineAttachments, this.settings().uploadTimeoutMs);
    this.checkAbort();
    await this.setStatus(job, 'UPLOADED');

    // ---- PROMPT_SUBMITTED ----
    await this.setStatus(job, 'PROMPT_SUBMITTED');
    const beforeImages = await this.adapter.snapshotImages();
    const promptBody = batch.prompt_body || '';
    if (!String(promptBody).trim()) {
      throw new AppError('PROMPT_EMPTY', 'No master prompt was captured for this batch.', { fatal: true });
    }
    await this.adapter.enterPrompt(promptBody);
    await this.adapter.submitPrompt();
    this.checkAbort();

    // ---- GENERATING ----
    await this.setStatus(job, 'GENERATING');
    const imageSrc = await this.adapter.waitForNewImage(
      beforeImages,
      this.settings().generationTimeoutMs,
      { shouldAbort: () => this.abortActionFor(job.id) }
    );
    this.checkAbort();
    await this.setStatus(job, 'GENERATED');

    // ---- DOWNLOADING ----
    await this.setStatus(job, 'DOWNLOADING');
    const outputPath = this.computeOutputPath(job, batch);
    const tempPath = path.join(batch.output_folder, `.download_${job.id}.bin`);
    let duration = 0;
    try {
      await this.downloader.saveImage(imageSrc, tempPath, this.settings().downloadTimeoutMs);
      this.checkAbort();

      // ---- VERIFYING ----
      await this.setStatus(job, 'VERIFYING');
      await imageService.convertToPng(tempPath, outputPath);
      const valid = await fileService.verifyImage(outputPath);
      if (!valid) throw new AppError('INVALID_IMAGE', 'The downloaded file is not a readable image.', { retryable: true });
      duration = Date.now() - startTime;
    } finally {
      await fsp.unlink(tempPath).catch(() => {});
    }

    // ---- COMPLETED (only after the file is on disk and verified) ----
    this.jobsRepo.updateJobStatus(job.id, 'COMPLETED', {
      output_path: outputPath,
      output_name: path.basename(outputPath),
      completed_at: new Date().toISOString(),
      duration_ms: duration
    });
    job.status = 'COMPLETED';
    job.output_path = outputPath;
    this.jobsRepo.incrementBatchCompleted(batch.id);
    this.emit('job-update', {
      jobId: job.id,
      batchId: batch.id,
      status: 'COMPLETED',
      outputName: path.basename(outputPath)
    });
    this.logEvent(job.id, 'info', 'job', `Completed ${job.original_name} → ${path.basename(outputPath)}`, {
      batchId: batch.id,
      durationMs: duration
    });
  }

  abortActionFor(jobId) {
    if (this.stopped) return 'stop';
    if (this.skipRequested && this.currentJob && this.currentJob.id === jobId) return 'skip';
    return null;
  }

  checkAbort() {
    if (this.stopped) throw new StopSignal();
    if (this.skipRequested && this.currentJob) throw new SkipSignal();
  }

  async setStatus(job, status, extra = {}) {
    this.jobsRepo.updateJobStatus(job.id, status, extra);
    job.status = status;
    if (extra.started_at) job.started_at = extra.started_at;
    this.emit('job-update', { jobId: job.id, batchId: job.batch_id, status });
    if (status === 'UPLOADING') {
      this.logEvent(job.id, 'info', 'job', `Uploading ${job.original_name}`, { batchId: job.batch_id });
    } else if (status === 'GENERATING') {
      this.logEvent(job.id, 'info', 'job', `Waiting for Gemini to generate ${job.original_name}`, { batchId: job.batch_id });
    } else {
      this.logEvent(job.id, 'debug', 'job', `${job.original_name}: ${status}`, { batchId: job.batch_id });
    }
  }

  async handleFailure(job, err) {
    const info = classifyError(err);
    this.lastError = { code: info.code, message: info.message, at: new Date().toISOString() };
    const fresh = this.jobsRepo.getJob(job.id) || job;

    if (info.code === 'STOPPED') {
      this.restoreToPending(fresh, 'STOPPED', 'Stopped by user — will retry on next start');
      this.stopped = true;
      this.logEvent(job.id, 'warn', 'job', `${job.original_name}: stopped mid-job`, { batchId: job.batch_id });
      return;
    }

    if (info.code === 'SKIPPED') {
      this.markSkipped(fresh);
      return;
    }

    const limit = RETRY_LIMITS[info.code] !== undefined ? RETRY_LIMITS[info.code] : 1;
    const attempt = fresh.retry_count || 0;

    if (info.retryable && attempt < limit && !this.stopped) {
      this.retryJob(fresh, info);
      this.logEvent(job.id, 'warn', 'job', `${info.code}: ${info.message} — retry ${attempt + 1}/${limit}`, {
        batchId: job.batch_id
      });
      this.emit('notice', {
        level: 'warning',
        code: info.code,
        message: `${job.original_name}: ${info.message} (retry ${attempt + 1}/${limit})`,
        sticky: false
      });
      await sleep(Math.min(15000, 2000 * (attempt + 1)));
      return;
    }

    this.markFailed(fresh, info);
    this.emit('job-update', {
      jobId: job.id,
      batchId: job.batch_id,
      status: 'FAILED',
      error: info.message,
      code: info.code
    });
    this.logEvent(job.id, 'error', 'job', `Failed ${job.original_name}: ${info.code} — ${info.message}`, {
      batchId: job.batch_id
    });

    if (info.pause) {
      this.paused = true;
      this.emit('notice', {
        level: 'error',
        code: info.code,
        message: `Batch paused — ${job.original_name}: ${info.message}. Fix it in the Gemini panel, then press RESUME.`,
        sticky: true
      });
    } else if (info.fatal) {
      this.stopped = true;
      this.emit('notice', {
        level: 'error',
        code: info.code,
        message: `Batch stopped — ${info.message}`,
        sticky: true
      });
    }
  }

  retryJob(job, info) {
    if (!job || job.status === 'COMPLETED' || job.status === 'SKIPPED') return;
    let current = job;
    if (current.status !== 'FAILED') {
      this.jobsRepo.updateJobStatus(current.id, 'FAILED', {
        error_code: info.code,
        error_message: info.message
      });
      current = this.jobsRepo.getJob(job.id);
    }
    this.jobsRepo.updateJobStatus(current.id, 'PENDING', {
      retry_count: (current.retry_count || 0) + 1,
      error_code: info.code,
      error_message: info.message,
      started_at: null,
      completed_at: null
    });
    if (this.currentJob && this.currentJob.id === job.id) this.currentJob.status = 'PENDING';
    this.emit('job-update', {
      jobId: job.id,
      batchId: job.batch_id,
      status: 'PENDING',
      error: info.message,
      code: info.code
    });
  }

  restoreToPending(job, code, message) {
    if (!job || job.status === 'COMPLETED') return;
    let current = job;
    if (current.status !== 'FAILED') {
      if (current.status === 'PENDING') {
        this.jobsRepo.updateJobStatus(current.id, 'PENDING', { error_code: code, error_message: message });
        return;
      }
      this.jobsRepo.updateJobStatus(current.id, 'FAILED', { error_code: code, error_message: message });
      current = this.jobsRepo.getJob(job.id);
    }
    this.jobsRepo.updateJobStatus(current.id, 'PENDING', {
      error_code: code,
      error_message: message,
      started_at: null,
      completed_at: null
    });
    this.emit('job-update', { jobId: job.id, batchId: job.batch_id, status: 'PENDING', code, error: message });
  }

  markFailed(job, info) {
    if (!job) return;
    const fresh = this.jobsRepo.getJob(job.id);
    if (!fresh || fresh.status === 'COMPLETED') return;
    if (fresh.status !== 'FAILED') {
      this.jobsRepo.updateJobStatus(job.id, 'FAILED', {
        error_code: info.code,
        error_message: info.message,
        completed_at: new Date().toISOString()
      });
    }
    this.jobsRepo.incrementBatchFailed(job.batch_id);
  }

  markSkipped(job) {
    if (!job) return;
    const fresh = this.jobsRepo.getJob(job.id);
    if (!fresh || fresh.status === 'COMPLETED' || fresh.status === 'SKIPPED') return;
    const now = new Date().toISOString();
    if (fresh.status === 'PENDING') {
      this.jobsRepo.updateJobStatus(fresh.id, 'SKIPPED', { error_code: 'SKIPPED', error_message: 'Skipped by user', completed_at: now });
    } else if (fresh.status === 'FAILED') {
      this.jobsRepo.updateJobStatus(fresh.id, 'SKIPPED', { error_message: 'Skipped by user', completed_at: now });
    } else {
      this.jobsRepo.updateJobStatus(fresh.id, 'FAILED', { error_code: 'SKIPPED', error_message: 'Skipped by user' });
      this.jobsRepo.updateJobStatus(fresh.id, 'SKIPPED', { error_message: 'Skipped by user', completed_at: now });
    }
    this.jobsRepo.incrementBatchSkipped(job.batch_id);
    this.emit('job-update', { jobId: job.id, batchId: job.batch_id, status: 'SKIPPED' });
    this.logEvent(job.id, 'warn', 'job', `${job.original_name}: skipped by user`, { batchId: job.batch_id });
  }

  skipNextPending(batch) {
    const next = this.jobsRepo.getNextPendingJob(batch.id);
    if (!next) return false;
    this.jobsRepo.skipJobById(next.id);
    this.jobsRepo.incrementBatchSkipped(batch.id);
    this.emit('job-update', { jobId: next.id, batchId: batch.id, status: 'SKIPPED' });
    this.logEvent(next.id, 'warn', 'job', `${next.original_name}: skipped by user`, { batchId: batch.id });
    return true;
  }

  computeOutputPath(job, batch) {
    const settings = this.settings();
    const format = (settings.outputFilenameFormat && settings.outputFilenameFormat.includes('{base}'))
      ? settings.outputFilenameFormat
      : '{base}_generated{ext}';
    const originalExt = job.original_ext ? `.${job.original_ext}` : path.extname(job.original_name);
    const base = sanitizeSegment(path.basename(job.original_name, originalExt)) || 'image';
    const folder = path.resolve(batch.output_folder);
    fs.mkdirSync(folder, { recursive: true });

    let rendered = format.replace(/\{base\}/g, base).replace(/\{ext\}/g, '.png');
    rendered = path.basename(rendered.replace(/[\\/:*?"<>|]/g, '_'));
    if (!rendered.toLowerCase().endsWith('.png')) rendered += '.png';

    let candidate = path.join(folder, rendered);
    if (!candidate.startsWith(folder + path.sep)) candidate = path.join(folder, `${base}_generated.png`);

    let counter = 1;
    while (fs.existsSync(candidate)) {
      const parsed = path.parse(candidate);
      candidate = path.join(parsed.dir, `${parsed.name}_${String(counter).padStart(2, '0')}${parsed.ext || '.png'}`);
      counter += 1;
      if (counter > 999) throw new AppError('DISK_FULL', 'Could not find an unused output filename.', { fatal: true });
    }
    return candidate;
  }

  pause() {
    this.paused = true;
    this.emit('batch-state', this.getSnapshot());
    this.logEvent(null, 'info', 'batch', 'Batch paused by user', { batchId: this.batch ? this.batch.id : null });
  }

  resume() {
    this.paused = false;
    this.emit('batch-state', this.getSnapshot());
    this.logEvent(null, 'info', 'batch', 'Batch resumed by user', { batchId: this.batch ? this.batch.id : null });
  }

  stop() {
    this.stopped = true;
    this.paused = false;
    this.emit('batch-state', this.getSnapshot());
    this.logEvent(null, 'info', 'batch', 'Batch stop requested', { batchId: this.batch ? this.batch.id : null });
  }

  skipCurrent() {
    this.skipRequested = true;
    if (!this.currentJob) {
      // Nothing in flight: skip the next queued job immediately.
      if (this.batch) this.skipNextPending(this.batch);
      this.skipRequested = false;
    }
    return true;
  }
}

module.exports = { GenerationEngine, RecoverableError };
