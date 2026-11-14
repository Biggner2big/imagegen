'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { ipcMain, dialog, shell, app } = require('electron');
const archiver = require('archiver');

const jobsRepo = require('../database/repos/jobs.repo');
const promptsRepo = require('../database/repos/prompts.repo');
const historyRepo = require('../database/repos/history.repo');
const loggingService = require('../services/logging-service');
const settingsService = require('../services/settings-service');
const fileService = require('../services/file-service');
const imageService = require('../services/image-service');
const { folderManager } = require('./folder-manager');
const { GenerationEngine } = require('../automation/generation-engine');
const { AppError } = require('../automation/errors');

const MAX_PATH_LENGTH = 4096;
const MAX_JOB_IDS = 2000;

function validatePath(target, allowedRoot = null) {
  if (typeof target !== 'string' || !target.trim() || target.length > MAX_PATH_LENGTH) {
    throw new AppError('INVALID_PATH', 'Invalid file path.');
  }
  if (target.includes('\u0000')) throw new AppError('INVALID_PATH', 'Invalid file path.');
  const resolved = path.resolve(target);
  if (!path.isAbsolute(resolved)) throw new AppError('INVALID_PATH', 'File paths must be absolute.');
  if (allowedRoot) {
    const root = path.resolve(allowedRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new AppError('INVALID_PATH', 'Path traversal blocked.');
    }
  }
  return resolved;
}

function requireString(value, label, maxLength = 4096) {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('INVALID_INPUT', `${label} is required.`);
  if (value.length > maxLength) throw new AppError('INVALID_INPUT', `${label} is too long.`);
  return value.trim();
}

const nowStamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
};

const csvEscape = (value) => {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * Registers every IPC channel. Handlers validate their input and never throw
 * across the bridge: mutations return { ok:false, error } and reads fall back
 * to safe defaults, so the renderer cannot end up in a broken state.
 */
function registerIpcHandlers(windowManager, logger) {
  const browser = windowManager.getBrowser();
  const adapter = browser ? browser.getAdapter() : null;

  const send = (channel, payload) => windowManager.send(channel, payload);
  const getWindow = () => windowManager.getWindow();

  const logEvent = (jobId, level, category, message, meta) => loggingService.logEvent(jobId, level, category, message, meta);

  let engine = null;
  let engineBatchId = null;

  const emit = (name, payload) => {
    if (name === 'job-update') send('event:job-update', payload);
    else if (name === 'batch-state') send('event:batch-state', payload);
    else if (name === 'notice') send('event:notice', payload);
    else if (name === 'log') send('event:log', payload);
  };

  const safe = (label, fn) => async (event, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      logger.error({ err: err.message, code: err.code, channel: label }, 'IPC handler failed');
      return { ok: false, error: err.message || 'Unknown error', code: err.code };
    }
  };

  function startEngine(batch) {
    if (engine && engine.running) throw new AppError('BATCH_RUNNING', 'A batch is already running.');
    const instance = new GenerationEngine({
      adapter,
      logger,
      settings: settingsService.getSettings(),
      settingsProvider: () => settingsService.getSettings(),
      jobsRepo,
      promptsRepo,
      emit,
      logEvent
    });
    engine = instance;
    engineBatchId = batch.id;
    instance.start(batch)
      .catch((err) => logger.error({ err: err.message }, 'generation engine crashed'))
      .finally(() => {
        if (engine === instance) {
          engine = null;
          engineBatchId = null;
        }
      });
    return instance;
  }

  function activeResumableBatch() {
    const active = jobsRepo.getActiveBatch();
    if (!active) return null;
    if (jobsRepo.getPendingCount(active.id) === 0) return null;
    return active;
  }

  async function requireLogin(actionLabel) {
    if (!adapter) throw new AppError('VIEW_NOT_READY', 'The Gemini panel is not ready yet.');
    const state = await adapter.checkLoginStatus();
    if (state !== 'logged_in') {
      throw new AppError('NEEDS_LOGIN', `Sign in to Gemini in the right-hand panel before ${actionLabel}.`, { pause: true });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Folders                                                          */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('folder:pick-input', safe('folder:pick-input', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Select input folder',
      buttonLabel: 'Use input folder',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };

    const folder = validatePath(result.filePaths[0]);
    if (!(await fileService.isDirectory(folder))) throw new AppError('INVALID_PATH', 'The selected path is not a folder.');

    settingsService.setSelection({ inputFolder: folder });
    const settings = settingsService.getSettings();
    const scan = await folderManager.scanWithThumbnails(folder, {
      includeSubfolders: !!settings.includeSubfolders,
      maxThumbs: 120
    });
    logEvent(null, 'info', 'folders', `Input folder selected (${scan.total} image(s))`, { folder });
    return { folder, images: scan.images, total: scan.total, withThumbs: scan.withThumbs, canceled: false };
  }));

  ipcMain.handle('folder:pick-output', safe('folder:pick-output', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Select output folder',
      buttonLabel: 'Use output folder',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };

    const folder = validatePath(result.filePaths[0]);
    if (!(await fileService.isDirectory(folder))) throw new AppError('INVALID_PATH', 'The selected path is not a folder.');

    settingsService.setSelection({ outputFolder: folder });
    logEvent(null, 'info', 'folders', 'Output folder selected', { folder });
    return { folder, canceled: false };
  }));

  ipcMain.handle('folder:scan', safe('folder:scan', async (folder, opts = {}) => {
    const resolved = validatePath(folder);
    if (!(await fileService.isDirectory(resolved))) throw new AppError('INVALID_PATH', 'Folder does not exist.');
    const settings = settingsService.getSettings();
    const includeSubfolders = opts && typeof opts === 'object' && opts.includeSubfolders !== undefined
      ? !!opts.includeSubfolders
      : !!settings.includeSubfolders;
    const scan = await folderManager.scanWithThumbnails(resolved, {
      includeSubfolders,
      maxThumbs: 120
    });
    return { ok: true, images: scan.images, total: scan.total, withThumbs: scan.withThumbs };
  }));

  /* ---------------------------------------------------------------- */
  /* Prompts                                                          */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('prompt:list', async () => {
    try {
      return promptsRepo.listPrompts();
    } catch (err) {
      logger.error({ err: err.message }, 'prompt:list failed');
      return [];
    }
  });

  ipcMain.handle('prompt:save', safe('prompt:save', async (payload) => {
    if (!payload || typeof payload !== 'object') throw new AppError('INVALID_INPUT', 'Invalid prompt payload.');
    const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) : 'Master Prompt';
    const body = typeof payload.body === 'string' ? payload.body : '';
    if (!body.trim()) throw new AppError('INVALID_INPUT', 'The prompt body cannot be empty.');
    if (body.length > 100000) throw new AppError('INVALID_INPUT', 'The prompt body is too long.');
    const id = payload.id ? requireString(payload.id, 'Prompt id', 80) : null;
    const prompt = promptsRepo.savePrompt({ id, name, body, isDefault: !!payload.isDefault });
    logEvent(null, 'info', 'prompt', `Prompt saved: ${prompt.name}`);
    return { ok: true, id: prompt.id, prompt };
  }));

  ipcMain.handle('prompt:set-default', safe('prompt:set-default', async (id) => {
    const promptId = requireString(id, 'Prompt id', 80);
    const prompt = promptsRepo.setDefaultPrompt(promptId);
    logEvent(null, 'info', 'prompt', `Default prompt set: ${prompt.name}`);
    return { ok: true };
  }));

  ipcMain.handle('prompt:delete', safe('prompt:delete', async (id) => {
    const promptId = requireString(id, 'Prompt id', 80);
    promptsRepo.deletePrompt(promptId);
    logEvent(null, 'info', 'prompt', 'Prompt deleted');
    return { ok: true };
  }));

  /* ---------------------------------------------------------------- */
  /* Batch control                                                    */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('batch:start', safe('batch:start', async (options = {}) => {
    const opts = options && typeof options === 'object' ? options : {};
    const settings = settingsService.getSettings();

    const inputFolder = opts.inputFolder ? validatePath(opts.inputFolder) : (settings.inputFolder ? validatePath(settings.inputFolder) : null);
    const outputFolder = opts.outputFolder ? validatePath(opts.outputFolder) : (settings.outputFolder ? validatePath(settings.outputFolder) : null);

    const prompt = opts.promptId ? promptsRepo.getPrompt(requireString(opts.promptId, 'Prompt id', 80)) : promptsRepo.getDefaultPrompt();
    if (!prompt || !String(prompt.body || '').trim()) {
      throw new AppError('PROMPT_EMPTY', 'No default prompt is saved. Open Prompts, write your master prompt, save it and set it as default.');
    }
    if (!inputFolder || !(await fileService.isDirectory(inputFolder))) {
      throw new AppError('NO_INPUT_FOLDER', 'Select a valid input folder on the Folders page.');
    }
    if (!outputFolder || !(await fileService.isDirectory(outputFolder))) {
      throw new AppError('NO_OUTPUT_FOLDER', 'Select a valid output folder on the Folders page.');
    }
    if (path.resolve(inputFolder) === path.resolve(outputFolder)) {
      throw new AppError('SAME_FOLDERS', 'The input and output folders must be different.');
    }

    await requireLogin('starting a batch');

    // A batch interrupted by a crash/pause is resumed instead of duplicated.
    const resumable = activeResumableBatch();
    if (resumable) {
      if (engine && engine.running) {
        engine.resume();
      } else {
        startEngine(resumable);
      }
      send('event:notice', {
        level: 'info',
        code: 'BATCH_RESUMED',
        message: `Continuing the interrupted batch (${resumable.total} image(s), ${jobsRepo.getPendingCount(resumable.id)} remaining).`,
        sticky: false
      });
      return { ok: true, batchId: resumable.id, total: resumable.total, resumed: true };
    }

    const includeSubfolders = opts.includeSubfolders !== undefined ? !!opts.includeSubfolders : !!settings.includeSubfolders;
    const images = await fileService.listImagesInFolder(inputFolder, { includeSubfolders });
    if (images.length === 0) {
      throw new AppError('NO_IMAGES', 'No supported images (.jpg, .jpeg, .png, .webp) were found in the input folder.');
    }

    const batch = jobsRepo.createBatch({
      inputFolder,
      outputFolder,
      promptId: prompt.id,
      promptName: prompt.name,
      promptBody: prompt.body,
      total: images.length
    });
    jobsRepo.createJobs(batch.id, images);
    settingsService.setSelection({ inputFolder, outputFolder });

    logEvent(null, 'info', 'batch', `Batch created with ${images.length} image(s) using prompt "${prompt.name}"`, { batchId: batch.id });
    startEngine(batch);
    return { ok: true, batchId: batch.id, total: images.length, resumed: false };
  }));

  ipcMain.handle('batch:pause', safe('batch:pause', async () => {
    if (!engine || !engine.running) throw new AppError('NO_BATCH', 'No batch is running.');
    engine.pause();
    if (engine.batch) jobsRepo.updateBatchStatus(engine.batch.id, 'paused');
    return { ok: true };
  }));

  ipcMain.handle('batch:resume', safe('batch:resume', async () => {
    if (engine && engine.running) {
      engine.resume();
      if (engine.batch) jobsRepo.updateBatchStatus(engine.batch.id, 'running');
      return { ok: true, resumed: true };
    }
    const resumable = activeResumableBatch();
    if (!resumable) throw new AppError('NO_BATCH', 'There is no paused batch to resume. Press START to begin.');
    await requireLogin('resuming a batch');
    startEngine(resumable);
    return { ok: true, resumed: true, batchId: resumable.id };
  }));

  ipcMain.handle('batch:stop', safe('batch:stop', async () => {
    if (engine && engine.running) {
      engine.stop();
      return { ok: true };
    }
    const active = jobsRepo.getActiveBatch();
    if (!active) throw new AppError('NO_BATCH', 'No batch is running.');
    jobsRepo.finalizeBatch(active.id, 'stopped');
    send('event:batch-state', { running: false, paused: false, stopped: true, batchId: active.id, current: null });
    logEvent(null, 'info', 'batch', 'Batch stopped by user', { batchId: active.id });
    return { ok: true };
  }));

  ipcMain.handle('batch:skip', safe('batch:skip', async () => {
    if (engine && engine.running) {
      engine.skipCurrent();
      return { ok: true };
    }
    const active = jobsRepo.getActiveBatch();
    if (!active) throw new AppError('NO_BATCH', 'No active batch to skip.');
    const next = jobsRepo.getNextPendingJob(active.id);
    if (!next) throw new AppError('NO_PENDING', 'There are no pending jobs to skip.');
    jobsRepo.skipJobById(next.id);
    jobsRepo.incrementBatchSkipped(active.id);
    send('event:job-update', { jobId: next.id, batchId: active.id, status: 'SKIPPED' });
    return { ok: true };
  }));

  ipcMain.handle('batch:retry-failed', safe('batch:retry-failed', async () => {
    const target = (engine && engine.batch) || jobsRepo.getLatestBatch();
    if (!target) throw new AppError('NO_BATCH', 'There is no batch to retry.');
    const requeued = jobsRepo.requeueFailed(target.id);
    if (requeued > 0) {
      logEvent(null, 'info', 'batch', `Requeued ${requeued} failed job(s)`, { batchId: target.id });
      send('event:notice', {
        level: 'info',
        code: 'RETRY_QUEUED',
        message: `${requeued} failed job(s) requeued.`,
        sticky: false
      });
      if (!engine || !engine.running) startEngine(target);
    }
    return { ok: true, requeued };
  }));

  ipcMain.handle('job:retry', safe('job:retry', async (jobId) => {
    const id = requireString(jobId, 'Job id', 80);
    const job = jobsRepo.retryJobById(id);
    send('event:job-update', { jobId: id, batchId: job.batch_id, status: 'PENDING' });
    const batch = jobsRepo.getBatch(job.batch_id);
    const active = jobsRepo.getActiveBatch();
    if (batch && active && active.id === batch.id && (!engine || !engine.running)) startEngine(batch);
    return { ok: true };
  }));

  ipcMain.handle('job:skip', safe('job:skip', async (jobId) => {
    const id = requireString(jobId, 'Job id', 80);
    const job = jobsRepo.skipJobById(id);
    jobsRepo.incrementBatchSkipped(job.batch_id);
    send('event:job-update', { jobId: id, batchId: job.batch_id, status: 'SKIPPED' });
    return { ok: true };
  }));

  /* ---------------------------------------------------------------- */
  /* State                                                            */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('state:dashboard', async () => {
    const empty = {
      batch: null,
      counts: { total: 0, completed: 0, failed: 0, pending: 0, processing: 0, skipped: 0, paused: 0 },
      current: null,
      etaSeconds: null,
      running: false,
      paused: false,
      stopped: false,
      login: 'unknown',
      activePromptName: null,
      lastError: null,
      hasActiveBatch: false
    };
    try {
      const active = jobsRepo.getActiveBatch() || jobsRepo.getLatestBatch();
      let counts = empty.counts;
      let batch = null;

      if (active) {
        const raw = jobsRepo.countByStatus(active.id);
        counts = {
          total: raw.total,
          completed: raw.completed,
          failed: raw.failed,
          pending: raw.pending,
          processing: raw.processing,
          skipped: raw.skipped,
          paused: raw.paused
        };
        batch = {
          id: active.id,
          status: active.status,
          total: active.total,
          completed: raw.completed,
          failed: raw.failed,
          skipped: raw.skipped,
          pending: raw.pending,
          processing: raw.processing,
          startedAt: active.started_at,
          finishedAt: active.finished_at,
          inputFolder: active.input_folder,
          outputFolder: active.output_folder
        };
      }

      const snapshot = engine
        ? engine.getSnapshot()
        : { running: false, paused: false, stopped: false, current: null, lastError: null };
      const average = active ? jobsRepo.getAverageDuration(active.id) : null;
      const etaSeconds = average && counts.pending > 0 ? Math.round((average * counts.pending) / 1000) : null;
      const prompt = promptsRepo.getDefaultPrompt();

      return {
        batch,
        counts,
        current: snapshot.current || null,
        etaSeconds,
        running: !!snapshot.running,
        paused: !!snapshot.paused,
        stopped: !!snapshot.stopped,
        login: browser ? browser.getLastLoginState() : 'unknown',
        activePromptName: active && active.prompt_name ? active.prompt_name : (prompt ? prompt.name : null),
        lastError: snapshot.lastError || (active ? jobsRepo.getLastError(active.id) : null),
        hasActiveBatch: !!active && counts.pending > 0
      };
    } catch (err) {
      logger.error({ err: err.message }, 'state:dashboard failed');
      return empty;
    }
  });

  ipcMain.handle('state:jobs', async (_event, filter = {}) => {
    try {
      const status = filter && typeof filter.status === 'string' ? filter.status.toUpperCase() : null;
      const batchId = filter && typeof filter.batchId === 'string' ? filter.batchId : null;
      const limit = filter && Number.isFinite(Number(filter.limit)) ? Number(filter.limit) : 500;
      return jobsRepo.listJobs({ batchId, status: status === 'ALL' ? null : status, limit });
    } catch (err) {
      logger.error({ err: err.message }, 'state:jobs failed');
      return [];
    }
  });

  ipcMain.handle('state:history', async (_event, filter = {}) => {
    try {
      const level = filter && typeof filter.level === 'string' ? filter.level.toLowerCase() : null;
      const limit = filter && Number.isFinite(Number(filter.limit)) ? Number(filter.limit) : 100;
      return historyRepo.listEvents({ level: level === 'all' ? null : level, limit });
    } catch (err) {
      logger.error({ err: err.message }, 'state:history failed');
      return [];
    }
  });

  ipcMain.handle('state:gallery', async () => {
    try {
      const jobs = jobsRepo.listCompletedJobs({ limit: 500 });
      const items = await imageService.mapLimit(jobs, 4, async (job) => {
        try {
          const stat = await fsp.stat(job.output_path);
          if (!stat.isFile() || stat.size <= 0) return null;
          return {
            jobId: job.id,
            outputName: job.output_name || path.basename(job.output_path),
            outputPath: job.output_path,
            createdAt: job.completed_at,
            size: stat.size,
            thumb: await imageService.generateThumbnailSafe(job.output_path)
          };
        } catch (err) {
          return null;
        }
      });
      return items.filter(Boolean);
    } catch (err) {
      logger.error({ err: err.message }, 'state:gallery failed');
      return [];
    }
  });

  /* ---------------------------------------------------------------- */
  /* Settings                                                         */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('settings:get', async () => {
    try {
      return settingsService.getPublicSettings();
    } catch (err) {
      logger.error({ err: err.message }, 'settings:get failed');
      return settingsService.getSettings();
    }
  });

  ipcMain.handle('settings:set', safe('settings:set', async (settings) => {
    if (!settings || typeof settings !== 'object') throw new AppError('INVALID_INPUT', 'Invalid settings payload.');
    const updated = settingsService.setSettings(settings);
    logEvent(null, 'info', 'settings', 'Settings updated');
    return { ok: true, settings: { ...updated, inputFolder: updated.inputFolder || null, outputFolder: updated.outputFolder || null } };
  }));

  /* ---------------------------------------------------------------- */
  /* Browser controls                                                 */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('browser:reload', safe('browser:reload', async () => {
    if (!browser) throw new AppError('VIEW_NOT_READY', 'The Gemini panel is not ready yet.');
    browser.reload();
    return { ok: true };
  }));

  ipcMain.handle('browser:back', safe('browser:back', async () => {
    if (!browser) throw new AppError('VIEW_NOT_READY', 'The Gemini panel is not ready yet.');
    browser.goBack();
    return { ok: true };
  }));

  ipcMain.handle('browser:forward', safe('browser:forward', async () => {
    if (!browser) throw new AppError('VIEW_NOT_READY', 'The Gemini panel is not ready yet.');
    browser.goForward();
    return { ok: true };
  }));

  ipcMain.handle('browser:login-status', async () => {
    try {
      if (browser) return await browser.refreshLoginState();
      return 'unknown';
    } catch (err) {
      return 'unknown';
    }
  });

  /* ---------------------------------------------------------------- */
  /* Diagnostics                                                      */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('diag:run', safe('diag:run', async () => {
    if (!adapter) throw new AppError('VIEW_NOT_READY', 'The Gemini panel is not ready yet.');
    const result = await adapter.diagnostics();
    if (result && Array.isArray(result.results)) {
      const missing = result.results.filter((item) => !item.found).length;
      logEvent(null, missing > 0 ? 'warn' : 'info', 'diagnostics',
        `Selector diagnostics: ${result.results.length - missing} found, ${missing} missing`, { url: result.url });
      return { ok: true, results: result.results, url: result.url, title: result.title, missing };
    }
    return { ok: true, results: [], url: '', title: '', missing: 0 };
  }));

  /* ---------------------------------------------------------------- */
  /* Files / exports                                                  */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('file:reveal', safe('file:reveal', async (jobId) => {
    const id = requireString(jobId, 'Job id', 80);
    const job = jobsRepo.getJob(id);
    if (!job) throw new AppError('NOT_FOUND', 'Job not found.');
    if (!job.output_path) throw new AppError('NO_OUTPUT', 'This job has no downloaded image.');
    const target = validatePath(job.output_path);
    if (!(await fileService.verifyReadable(target))) throw new AppError('NOT_FOUND', 'The output file no longer exists.');
    shell.showItemInFolder(target);
    return { ok: true };
  }));

  ipcMain.handle('export:zip', safe('export:zip', async (jobIds) => {
    if (!Array.isArray(jobIds) || jobIds.length === 0) {
      throw new AppError('INVALID_INPUT', 'Select at least one generated image to export.');
    }
    const ids = jobIds.filter((id) => typeof id === 'string').slice(0, MAX_JOB_IDS);
    const jobs = ids
      .map((id) => jobsRepo.getJob(id))
      .filter((job) => job && job.status === 'COMPLETED' && job.output_path);

    const files = [];
    for (const job of jobs) {
      try {
        const target = validatePath(job.output_path);
        if (await fileService.verifyReadable(target)) files.push({ path: target, name: job.output_name || path.basename(target) });
      } catch (err) { /* skip unreadable */ }
    }
    if (files.length === 0) throw new AppError('NO_OUTPUT', 'None of the selected jobs have a downloaded image.');

    const saveResult = await dialog.showSaveDialog(getWindow(), {
      title: 'Export generated images',
      defaultPath: path.join(app.getPath('downloads'), `generated-images_${nowStamp()}.zip`),
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
    });
    if (saveResult.canceled || !saveResult.filePath) return { canceled: true };

    const targetZip = validatePath(saveResult.filePath);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(targetZip);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      const usedNames = new Set();
      for (const file of files) {
        let name = file.name;
        let counter = 1;
        while (usedNames.has(name)) {
          const parsed = path.parse(file.name);
          name = `${parsed.name}_${counter}${parsed.ext}`;
          counter += 1;
        }
        usedNames.add(name);
        archive.file(file.path, { name });
      }
      archive.finalize();
    });

    logEvent(null, 'info', 'export', `Exported ${files.length} image(s) to ZIP`, { path: targetZip });
    return { ok: true, path: targetZip, count: files.length };
  }));

  ipcMain.handle('export:csv', safe('export:csv', async (filter = {}) => {
    const level = filter && typeof filter.level === 'string' ? filter.level.toLowerCase() : null;
    const events = historyRepo.listEvents({ level: level === 'all' ? null : level, limit: 5000 });
    const header = ['created_at', 'level', 'category', 'job_id', 'message'];
    const rows = events.map((event) => [
      event.created_at,
      event.level,
      event.category,
      event.job_id || '',
      event.message
    ].map(csvEscape).join(','));
    const csv = `\uFEFF${[header.join(','), ...rows].join('\r\n')}\r\n`;

    const saveResult = await dialog.showSaveDialog(getWindow(), {
      title: 'Export history',
      defaultPath: path.join(app.getPath('downloads'), `gemini-history_${nowStamp()}.csv`),
      filters: [{ name: 'CSV file', extensions: ['csv'] }]
    });
    if (saveResult.canceled || !saveResult.filePath) return { canceled: true };

    const target = validatePath(saveResult.filePath);
    await fsp.writeFile(target, csv, 'utf8');
    logEvent(null, 'info', 'export', `Exported ${events.length} history event(s) to CSV`, { path: target });
    return { ok: true, path: target, count: events.length };
  }));

  logger.info({
    channels: 22,
    engineBatchId
  }, 'IPC handlers registered');
}

module.exports = { registerIpcHandlers };
