'use strict';

/**
 * Backend smoke tests. Runs inside Electron (native modules are built for the
 * Electron ABI):
 *
 *   npx electron tools/backend-test.js
 *
 * Covers: SQLite migrations + repos, state machine enforcement, output filename
 * collisions, sequential generation (no two images at once), retry/terminal
 * failure handling, scanning, thumbnails, PNG conversion, settings validation,
 * selector resolution and startup recovery.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TEST_ROOT = path.join(ROOT, '.cache', 'backend-test');
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(TEST_ROOT, { recursive: true });

app.setPath('userData', path.join(TEST_ROOT, 'userdata'));
app.commandLine.appendSwitch('disable-gpu');

const results = [];
let currentSection = 'general';

function section(name) {
  currentSection = name;
}

function check(name, fn) {
  try {
    fn();
    results.push({ section: currentSection, name, ok: true });
  } catch (err) {
    results.push({ section: currentSection, name, ok: false, error: err.message });
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ section: currentSection, name, ok: true });
  } catch (err) {
    results.push({ section: currentSection, name, ok: false, error: err.message, stack: err.stack });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function makeImage(sharp, filePath, format) {
  await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 124, g: 92, b: 255, alpha: 1 } }
  }).toFormat(format).toFile(filePath);
}

app.whenReady().then(async () => {
  try {
    const sharp = require('sharp');
    const { getDb, closeDb } = require('../src/database/database');
    const jobsRepo = require('../src/database/repos/jobs.repo');
    const promptsRepo = require('../src/database/repos/prompts.repo');
    const historyRepo = require('../src/database/repos/history.repo');
    const fileService = require('../src/services/file-service');
    const imageService = require('../src/services/image-service');
    const settingsService = require('../src/services/settings-service');
    const { assertTransition, TRANSITIONS } = require('../src/automation/state-machine');
    const { SelectorResolver } = require('../src/automation/selector-resolver');
    const { SelectorNotFoundError } = require('../src/automation/errors');
    const { GenerationEngine } = require('../src/automation/generation-engine');
    const { recoverStuckJobs } = require('../src/automation/recovery-engine');

    /* ---------------- database + repositories ---------------- */
    section('database');
    const db = getDb();
    check('database opens and migrates', () => {
      assert(db && db.open, 'database did not open');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
      for (const table of ['jobs', 'batches', 'prompts', 'events']) assert(tables.includes(table), `missing table ${table}`);
    });
    check('migration is idempotent', () => {
      const sql = fs.readFileSync(path.join(ROOT, 'src', 'database', 'migrations', '001_init.sql'), 'utf8');
      db.exec(sql);
    });
    check('journal mode is WAL', () => {
      assert(db.pragma('journal_mode', { simple: true }).toLowerCase() === 'wal', 'not WAL');
    });

    section('prompts');
    let defaultPromptId = null;
    check('save first prompt becomes default', () => {
      const prompt = promptsRepo.savePrompt({ name: 'Master', body: 'Turn this into a watercolour painting.' });
      defaultPromptId = prompt.id;
      assert(prompt.is_default === 1, 'first prompt should be default');
    });
    check('save second prompt is not default', () => {
      const second = promptsRepo.savePrompt({ name: 'Alt', body: 'Make it a pencil sketch.' });
      assert(second.is_default === 0, 'second prompt should not be default');
    });
    check('set default prompt', () => {
      const list = promptsRepo.listPrompts();
      const alt = list.find((p) => p.name === 'Alt');
      promptsRepo.setDefaultPrompt(alt.id);
      assert(promptsRepo.getDefaultPrompt().id === alt.id, 'default not switched');
      promptsRepo.setDefaultPrompt(defaultPromptId);
    });
    check('empty prompt body rejected', () => {
      let threw = false;
      try { promptsRepo.savePrompt({ name: 'x', body: '   ' }); } catch (err) { threw = true; }
      assert(threw, 'empty body accepted');
    });
    check('default prompt cannot be deleted', () => {
      let threw = false;
      try { promptsRepo.deletePrompt(defaultPromptId); } catch (err) { threw = true; }
      assert(threw, 'deleted default prompt');
    });

    section('state machine');
    check('legal transition accepted', () => assertTransition('PENDING', 'PREPARING'));
    check('illegal transition rejected', () => {
      let threw = false;
      try { assertTransition('FAILED', 'COMPLETED'); } catch (err) { threw = true; }
      assert(threw, 'FAILED -> COMPLETED allowed');
    });
    check('COMPLETED is terminal', () => assert(TRANSITIONS.COMPLETED.length === 0, 'COMPLETED not terminal'));

    /* ---------------- fixture images ---------------- */
    const inputFolder = path.join(TEST_ROOT, 'input');
    const outputFolder = path.join(TEST_ROOT, 'output');
    fs.mkdirSync(inputFolder, { recursive: true });
    fs.mkdirSync(outputFolder, { recursive: true });
    await makeImage(sharp, path.join(inputFolder, 'alpha.jpg'), 'jpeg');
    await makeImage(sharp, path.join(inputFolder, 'beta.png'), 'png');
    await makeImage(sharp, path.join(inputFolder, 'gamma.webp'), 'webp');
    fs.writeFileSync(path.join(inputFolder, 'notes.txt'), 'not an image');
    fs.writeFileSync(path.join(inputFolder, 'empty.png'), '');

    section('file service');
    let listed = [];
    await checkAsync('scans only supported, non-empty images', async () => {
      listed = await fileService.listImagesInFolder(inputFolder, { includeSubfolders: false });
      assert(listed.length === 3, `expected 3 images, got ${listed.length}: ${listed.map((i) => i.name).join(',')}`);
      assert(listed.map((i) => i.name).join(',') === 'alpha.jpg,beta.png,gamma.webp', 'wrong order/names');
    });
    await checkAsync('verifyImage accepts jpg/png/webp', async () => {
      for (const image of listed) assert(await fileService.verifyImage(image.path), `verifyImage failed for ${image.name}`);
    });
    await checkAsync('verifyImage rejects junk', async () => {
      assert(!(await fileService.verifyImage(path.join(inputFolder, 'notes.txt'))), 'text file accepted as image');
      assert(!(await fileService.verifyImage(path.join(inputFolder, 'empty.png'))), 'empty file accepted');
    });

    section('image service');
    await checkAsync('thumbnail generated and cached', async () => {
      const thumb = await imageService.generateThumbnail(listed[0].path);
      assert(fs.existsSync(thumb), 'thumb not written');
      const meta = await sharp(thumb).metadata();
      assert(meta.width === 120 && meta.height === 120, `thumb size ${meta.width}x${meta.height}`);
    });
    await checkAsync('thumbnail data URL', async () => {
      const dataUrl = await imageService.generateThumbnailDataUrl(listed[0].path);
      assert(dataUrl.startsWith('data:image/jpeg;base64,'), 'bad data URL');
    });
    await checkAsync('convertToPng produces valid PNG', async () => {
      const src = listed[0].path;
      const out = path.join(TEST_ROOT, 'converted.png');
      const meta = await imageService.convertToPng(src, out);
      assert(meta.format === 'png' && meta.width > 0, 'conversion failed');
      const stat = fs.statSync(out);
      assert(stat.size > 0, 'empty png');
    });

    /* ---------------- batches + jobs ---------------- */
    section('jobs repo');
    let batch;
    let jobs;
    check('create batch + jobs in order', () => {
      batch = jobsRepo.createBatch({
        inputFolder,
        outputFolder,
        promptId: defaultPromptId,
        promptName: 'Master',
        promptBody: 'Turn this into a watercolour painting.',
        total: listed.length
      });
      jobsRepo.createJobs(batch.id, listed);
      jobs = jobsRepo.listJobs({ batchId: batch.id, limit: 10 }).sort((a, b) => a.queue_index - b.queue_index);
      assert(jobs.length === 3, `expected 3 jobs, got ${jobs.length}`);
      assert(jobsRepo.getNextPendingJob(batch.id).queue_index === 0, 'next pending is not the first job');
    });
    check('job requires legal transitions', () => {
      const job = jobs[0];
      jobsRepo.updateJobStatus(job.id, 'PREPARING', { started_at: new Date().toISOString() });
      jobsRepo.updateJobStatus(job.id, 'UPLOADING');
      let threw = false;
      try { jobsRepo.updateJobStatus(job.id, 'COMPLETED', { output_path: 'x' }); } catch (err) { threw = true; }
      assert(threw, 'UPLOADING -> COMPLETED allowed');
      jobsRepo.updateJobStatus(job.id, 'UPLOADED');
      jobsRepo.updateJobStatus(job.id, 'PROMPT_SUBMITTED');
      jobsRepo.updateJobStatus(job.id, 'GENERATING');
      jobsRepo.updateJobStatus(job.id, 'GENERATED');
      jobsRepo.updateJobStatus(job.id, 'DOWNLOADING');
      jobsRepo.updateJobStatus(job.id, 'VERIFYING');
      const completed = jobsRepo.updateJobStatus(job.id, 'COMPLETED', {
        output_path: path.join(outputFolder, 'fake.png'),
        output_name: 'fake.png',
        duration_ms: 1234
      });
      assert(completed.status === 'COMPLETED', 'not completed');
      let threw2 = false;
      try { jobsRepo.updateJobStatus(job.id, 'FAILED'); } catch (err) { threw2 = true; }
      assert(threw2, 'COMPLETED job was modified');
    });
    check('COMPLETED without output_path rejected', () => {
      const job = jobs[1];
      jobsRepo.updateJobStatus(job.id, 'PREPARING');
      jobsRepo.updateJobStatus(job.id, 'UPLOADING');
      jobsRepo.updateJobStatus(job.id, 'UPLOADED');
      jobsRepo.updateJobStatus(job.id, 'PROMPT_SUBMITTED');
      jobsRepo.updateJobStatus(job.id, 'GENERATING');
      jobsRepo.updateJobStatus(job.id, 'GENERATED');
      jobsRepo.updateJobStatus(job.id, 'DOWNLOADING');
      jobsRepo.updateJobStatus(job.id, 'VERIFYING');
      let threw = false;
      try { jobsRepo.updateJobStatus(job.id, 'COMPLETED', {}); } catch (err) { threw = true; }
      assert(threw, 'COMPLETED without output allowed');
      jobsRepo.updateJobStatus(job.id, 'FAILED', { error_code: 'UNKNOWN', error_message: 'test failure' });
    });
    check('counts, requeue and retry/skip', () => {
      const counts = jobsRepo.countByStatus(batch.id);
      assert(counts.completed === 1 && counts.failed === 1 && counts.pending === 1, `unexpected counts ${JSON.stringify(counts)}`);
      const requeued = jobsRepo.requeueFailed(batch.id);
      assert(requeued === 1, `requeued ${requeued}`);
      assert(jobsRepo.countByStatus(batch.id).failed === 0, 'failed count not decremented');
      const pending = jobsRepo.getNextPendingJob(batch.id);
      jobsRepo.skipJobById(pending.id);
      assert(jobsRepo.countByStatus(batch.id).skipped === 1, 'skip not counted');
      jobsRepo.retryJobById(pending.id);
      assert(jobsRepo.countByStatus(batch.id).pending >= 1, 'retry did not requeue');
    });
    check('event log persists', () => {
      historyRepo.logEvent(null, 'info', 'test', 'hello event', { batchId: batch.id });
      const events = historyRepo.listEvents({ limit: 5 });
      assert(events.length > 0 && events[0].message === 'hello event', 'event missing');
    });

    section('recovery');
    check('stuck jobs reset to PENDING', () => {
      const job = jobsRepo.getNextPendingJob(batch.id);
      db.prepare("UPDATE jobs SET status = 'GENERATING' WHERE id = ?").run(job.id);
      const summary = recoverStuckJobs({ info: () => {} });
      assert(summary.jobs >= 1, 'no jobs recovered');
      const recovered = jobsRepo.getJob(job.id);
      assert(recovered.status === 'PENDING', `status ${recovered.status}`);
      assert(recovered.error_code === 'RECOVERED', 'recovery code missing');
    });

    section('settings');
    check('settings merge defaults and selections', () => {
      const settings = settingsService.getSettings();
      assert(settings.maxRetries === 3, 'default maxRetries missing');
      settingsService.setSelection({ inputFolder, outputFolder });
      assert(settingsService.getSettings().inputFolder === inputFolder, 'input folder not persisted');
    });
    check('invalid filename format rejected', () => {
      let threw = false;
      try { settingsService.setSettings({ outputFilenameFormat: 'no-placeholder.png' }); } catch (err) { threw = true; }
      assert(threw, 'invalid format accepted');
    });
    check('numbers are clamped', () => {
      const updated = settingsService.setSettings({ maxRetries: 99 });
      assert(updated.maxRetries === 10, `maxRetries=${updated.maxRetries}`);
      settingsService.setSettings({ maxRetries: 3 });
    });
    check('duplicateHandling cannot enable overwrite', () => {
      const updated = settingsService.setSettings({ duplicateHandling: 'overwrite' });
      assert(updated.duplicateHandling === 'rename', 'overwrite allowed');
    });

    section('selectors');
    await checkAsync('resolver finds first matching selector', async () => {
      const fakeSelectors = { promptEditor: ['div.editor', 'textarea'] };
      const resolver = new SelectorResolver(fakeSelectors, null);
      const exec = async (expression) => expression.includes('div.editor');
      const found = await resolver.find(exec, 'promptEditor');
      assert(found === 'div.editor', `found ${found}`);
    });
    await checkAsync('resolver throws when nothing matches', async () => {
      const fakeSelectors = { promptEditor: ['div.editor'] };
      const resolver = new SelectorResolver(fakeSelectors, null);
      let threw = null;
      try { await resolver.find(async () => false, 'promptEditor'); } catch (err) { threw = err; }
      assert(threw instanceof SelectorNotFoundError, 'wrong error type');
      assert(threw.code === 'SELECTOR_NOT_FOUND', 'wrong code');
    });

    /* ---------------- generation engine (simulated Gemini) ---------------- */
    section('generation engine');
    const engineInput = path.join(TEST_ROOT, 'engine-input');
    const engineOutput = path.join(TEST_ROOT, 'engine-output');
    fs.mkdirSync(engineInput, { recursive: true });
    fs.mkdirSync(engineOutput, { recursive: true });
    const engineImages = [
      { path: path.join(engineInput, 'one.jpg'), name: 'one.jpg', ext: 'jpg' },
      { path: path.join(engineInput, 'two.png'), name: 'two.png', ext: 'png' },
      { path: path.join(engineInput, 'three.webp'), name: 'three.webp', ext: 'webp' }
    ];
    for (const image of engineImages) await makeImage(sharp, image.path, image.ext === 'jpg' ? 'jpeg' : image.ext);
    // Pre-existing output to prove collision handling never overwrites.
    fs.writeFileSync(path.join(engineOutput, 'one_generated.png'), 'DO NOT OVERWRITE');

    const order = [];
    const fakeAdapter = {
      calls: [],
      async attach() {},
      async checkLoginStatus() { return 'logged_in'; },
      async isCaptchaVisible() { return false; },
      async isUsageLimitVisible() { return false; },
      async beginNewChat() { this.calls.push('beginNewChat'); return true; },
      async waitForEditor() { return true; },
      async attachmentCount() { return 0; },
      async uploadFile(filePath) { this.calls.push(`upload:${path.basename(filePath)}`); return true; },
      async verifyUploadComplete() { return true; },
      async snapshotImages() { return []; },
      async enterPrompt(text) {
        assert(typeof text === 'string' && text.trim().length > 0, 'prompt not passed to Gemini');
        this.calls.push('prompt');
        return true;
      },
      async submitPrompt() { this.calls.push('submit'); return true; },
      async waitForNewImage() { this.calls.push('wait'); return `https://example.invalid/generated-${this.calls.length}.png`; }
    };
    const fakeDownloader = {
      async saveImage(src, outPath) {
        const buf = await sharp({
          create: { width: 96, height: 96, channels: 4, background: { r: 40, g: 200, b: 140, alpha: 1 } }
        }).png().toBuffer();
        await fs.promises.writeFile(outPath, buf);
      }
    };

    let engineBatch;
    await checkAsync('processes 3 images sequentially with correct filenames', async () => {
      engineBatch = jobsRepo.createBatch({
        inputFolder: engineInput,
        outputFolder: engineOutput,
        promptId: defaultPromptId,
        promptName: 'Master',
        promptBody: 'Turn this into a watercolour painting.',
        total: engineImages.length
      });
      jobsRepo.createJobs(engineBatch.id, engineImages);

      const engine = new GenerationEngine({
        adapter: fakeAdapter,
        downloader: fakeDownloader,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        jobsRepo,
        promptsRepo,
        settingsProvider: () => ({ ...settingsService.getSettings(), timeBetweenJobsMs: 0, newChatPerJob: true }),
        emit: (name, payload) => {
          if (name === 'job-update') order.push({ jobId: payload.jobId, status: payload.status });
        },
        logEvent: () => {}
      });

      const status = await engine.start(engineBatch);
      assert(status === 'completed', `batch status ${status}`);
      const finalJobs = jobsRepo.listJobs({ batchId: engineBatch.id, limit: 10 });
      assert(finalJobs.every((job) => job.status === 'COMPLETED'), 'not all completed');
      assert(finalJobs.every((job) => job.error_message === null), 'unexpected errors');
      assert(fs.existsSync(path.join(engineOutput, 'two_generated.png')), 'two_generated.png missing');
      assert(fs.existsSync(path.join(engineOutput, 'three_generated.png')), 'three_generated.png missing');
      assert(fs.existsSync(path.join(engineOutput, 'one_generated_01.png')), 'collision filename missing');
      assert(fs.readFileSync(path.join(engineOutput, 'one_generated.png'), 'utf8') === 'DO NOT OVERWRITE', 'existing output overwritten');
      const meta = await sharp(path.join(engineOutput, 'two_generated.png')).metadata();
      assert(meta.format === 'png' && meta.width === 96, 'output is not a valid png');
      // Sequential invariant: job 2 only starts uploading after job 1 completed.
      const jobIds = order.map((entry) => entry.jobId);
      const firstIndex = jobIds.indexOf(finalJobs.find((j) => j.original_name === 'one.jpg').id);
      const secondJobId = finalJobs.find((j) => j.original_name === 'two.png').id;
      const firstCompleted = order.findIndex((e) => e.jobId === jobIds[firstIndex] && e.status === 'COMPLETED');
      const secondUploading = order.findIndex((e) => e.jobId === secondJobId && e.status === 'UPLOADING');
      assert(firstCompleted !== -1 && secondUploading !== -1, 'missing status events');
      assert(firstCompleted < secondUploading, 'image 2 started before image 1 completed');
      // Prompt was sent verbatim once per image.
      assert(fakeAdapter.calls.filter((c) => c === 'prompt').length === 3, 'prompt not sent per image');
    });

    await checkAsync('failed job is retried then marked FAILED (never COMPLETED)', async () => {
      const failInput = path.join(TEST_ROOT, 'fail-input');
      fs.mkdirSync(failInput, { recursive: true });
      const missing = path.join(failInput, 'missing.jpg');
      const failBatch = jobsRepo.createBatch({
        inputFolder: failInput,
        outputFolder: engineOutput,
        promptId: defaultPromptId,
        promptName: 'Master',
        promptBody: 'x',
        total: 1
      });
      jobsRepo.createJobs(failBatch.id, [{ path: missing, name: 'missing.jpg', ext: 'jpg' }]);

      const engine = new GenerationEngine({
        adapter: fakeAdapter,
        downloader: fakeDownloader,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        jobsRepo,
        promptsRepo,
        settingsProvider: () => ({ ...settingsService.getSettings(), timeBetweenJobsMs: 0 }),
        emit: () => {},
        logEvent: () => {}
      });
      const status = await engine.start(failBatch);
      assert(status === 'completed_with_errors', `batch status ${status}`);
      const failedJob = jobsRepo.listJobs({ batchId: failBatch.id, limit: 1 })[0];
      assert(failedJob.status === 'FAILED', `job status ${failedJob.status}`);
      assert(failedJob.error_code === 'INVALID_IMAGE', `error code ${failedJob.error_code}`);
      assert(failedJob.retry_count >= 2, `retry_count ${failedJob.retry_count}`);
      assert(failedJob.output_path === null, 'failed job has output path');
    });

    section('summary');
    check('database closes cleanly', () => {
      closeDb();
      getDb();
    });

    const failed = results.filter((result) => !result.ok);
    const lines = [];
    lines.push('');
    lines.push('================ BACKEND TEST RESULTS ================');
    for (const result of results) {
      lines.push(`${result.ok ? 'PASS' : 'FAIL'}  [${result.section}] ${result.name}${result.ok ? '' : ` -> ${result.error}`}`);
    }
    lines.push('-----------------------------------------------------');
    lines.push(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
      lines.push('');
      for (const result of failed) lines.push(`FAILURE STACK (${result.name}):\n${result.stack || result.error}`);
    }
    lines.push('=====================================================');
    console.log(lines.join('\n'));
    process.exitCode = failed.length ? 1 : 0;
    app.exit(failed.length ? 1 : 0);
  } catch (err) {
    console.error('TEST HARNESS CRASH:', err && err.stack ? err.stack : err);
    app.exit(2);
  }
});
