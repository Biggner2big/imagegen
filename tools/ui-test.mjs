/**
 * End-to-end UI test. Expects the app to already be running with
 * --remote-debugging-port=9222 (main.js enables it).
 *
 *   node tools/ui-test.mjs phase1   (full UI + IPC test, writes test data)
 *   node tools/ui-test.mjs phase2   (restart: proves persistence)
 *
 * Uses Node's built-in WebSocket client; no extra dependencies.
 */
const PHASE = process.argv[2] || 'phase1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const failures = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` -> ${detail}` : ''}`);
}

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.ws = null;
  }

  async open() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('WebSocket error'));
      setTimeout(() => reject(new Error('WebSocket open timeout')), 20000);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  async eval(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (response.exceptionDetails) {
      const exception = response.exceptionDetails.exception || {};
      throw new Error(exception.description || response.exceptionDetails.text || 'evaluate failed');
    }
    return response.result ? response.result.value : undefined;
  }

  close() {
    try { this.ws.close(); } catch (err) { /* ignore */ }
  }
}

async function fetchTargets() {
  try {
    const response = await fetch('http://127.0.0.1:9222/json/list');
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    return null;
  }
}

async function waitForTarget(predicate, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetchTargets();
    if (Array.isArray(targets)) {
      const found = targets.find(predicate);
      if (found) return { target: found, targets };
    }
    await sleep(1000);
  }
  throw new Error('Timed out waiting for a CDP target');
}

async function waitFor(client, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await client.eval(expression)) return true;
    } catch (err) { /* page may be reloading */ }
    await sleep(500);
  }
  return false;
}

function report() {
  const failed = results.filter((item) => !item.ok);
  console.log(`\n=============== UI TEST RESULTS (${PHASE}) ===============`);
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok || !item.detail ? '' : ` -> ${item.detail}`}`);
  }
  console.log('--------------------------------------------------------');
  console.log(`${results.length - failed.length}/${results.length} passed`);
  console.log('========================================================');
  if (failed.length) process.exitCode = 1;
}

async function phase1() {
  const { target, targets } = await waitForTarget((item) => item.type === 'page' && item.url.startsWith('app://bundle/'));
  const geminiTarget = targets.find((item) => item.url.includes('gemini.google.com'));
  check('app renderer target is loaded (app://bundle/index.html)', true, target.url);
  check('real Gemini page exists as a separate CDP target (WebContentsView)', !!geminiTarget,
    geminiTarget ? geminiTarget.url : `targets: ${targets.map((t) => t.url).join(' | ')}`);

  const client = new CDP(target.webSocketDebuggerUrl);
  await client.open();
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Page.enable');

  await client.send('Page.reload', { ignoreCache: true });
  await sleep(3500);
  await waitFor(client, "document.readyState === 'complete'", 20000);
  await waitFor(client, "document.querySelectorAll('#page-host .stat-card').length >= 5", 40000);

  // ---- structural checks ----
  check('window.api bridge is exposed', await client.eval(
    "typeof window.api === 'object' && typeof window.api.startBatch === 'function'"));
  check('all 8 navigation items render', await client.eval(
    "document.querySelectorAll('.nav button[data-page]').length === 8"));
  check('sidebar status bar shows login state', await client.eval(
    "!!document.getElementById('loginStatus') && document.getElementById('loginStatus').textContent.trim().length > 0"));
  check('dashboard shows 5 stat cards', await client.eval(
    "document.querySelectorAll('#page-host .stat-card').length === 5"),
    await client.eval("document.querySelectorAll('#page-host .stat-card').length"));
  check('dashboard shows progress bar and ETA', await client.eval(
    "!!document.querySelector('#page-host .progress-fill') && /ETA|remaining|Left/i.test(document.querySelector('#page-host').innerText)"));
  const controls = await client.eval(
    "Array.from(document.querySelectorAll('#page-host button')).map(b => b.textContent.trim().toUpperCase()).join('|')");
  for (const label of ['START', 'PAUSE', 'RESUME', 'STOP', 'SKIP', 'RETRY FAILED']) {
    check(`dashboard control present: ${label}`, controls.includes(label.replace('RETRY FAILED', 'RETRY')), controls);
  }

  // ---- renderer security ----
  check('renderer has no Node.js require', await client.eval("typeof require === 'undefined'"));
  check('renderer has no Node.js process', await client.eval("typeof process === 'undefined'"));
  check('renderer has no module object', await client.eval("typeof module === 'undefined'"));

  // ---- real IPC round trips ----
  const dashboard = await client.eval('window.api.getDashboard()');
  check('state:dashboard returns the dashboard shape',
    !!dashboard && typeof dashboard === 'object' && !!dashboard.counts && typeof dashboard.running === 'boolean',
    JSON.stringify(dashboard && dashboard.counts));
  const settings = await client.eval('window.api.getSettings()');
  check('settings:get returns defaults',
    settings && Number.isFinite(settings.maxRetries) && Number.isFinite(settings.generationTimeoutMs) && settings.generationTimeoutMs === 180000,
    JSON.stringify(settings && { maxRetries: settings.maxRetries, generationTimeoutMs: settings.generationTimeoutMs }));
  const login = await client.eval('window.api.getLoginStatus()');
  check('browser:login-status returns a valid state', ['logged_in', 'needs_login', 'unknown'].includes(login), String(login));
  const promptsBefore = await client.eval('window.api.listPrompts()');
  check('prompt:list returns an array', Array.isArray(promptsBefore));

  const fixture = new URL('../.cache/backend-test/input', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const scan = await client.eval(
    `window.api.scanFolder(${JSON.stringify(decodeURIComponent(fixture))}, { includeSubfolders: false })`);
  const scanImages = scan && Array.isArray(scan.images) ? scan.images : [];
  check('folder:scan finds 3 supported images and ignores non-images',
    !!scan && scan.ok === true && scanImages.length === 3,
    JSON.stringify(scan && { ok: scan.ok, error: scan.error, count: scanImages.length }));
  check('folder:scan returns cached JPEG thumbnails (sharp works in-app)',
    scanImages.length === 3 && scanImages.every((image) => typeof image.thumb === 'string' && image.thumb.startsWith('data:image/jpeg;base64,')),
    scanImages.map((image) => (image.thumb ? 'thumb' : 'none')).join(','));

  const invalidStart = await client.eval(
    "window.api.startBatch({ inputFolder: 'C:\\\\definitely-not-a-real-folder-xyz', outputFolder: 'C:\\\\definitely-not-a-real-folder-xyz' })");
  check('batch:start refuses invalid folders (validation works)',
    invalidStart && invalidStart.ok === false && typeof invalidStart.error === 'string', JSON.stringify(invalidStart));
  const invalidPause = await client.eval('window.api.pauseBatch()');
  check('batch:pause refuses when nothing is running', invalidPause && invalidPause.ok === false, JSON.stringify(invalidPause));

  // ---- diagnostics (may be inconclusive without a signed-in Gemini session) ----
  const diagnostics = await client.eval('window.api.runDiagnostics()');
  check('diag:run returns a diagnostics payload',
    !!diagnostics && (Array.isArray(diagnostics.results) || diagnostics.ok === false),
    JSON.stringify(diagnostics && (diagnostics.error || `${(diagnostics.results || []).length} selectors`)));

  // ---- navigation through every page (dynamic ESM imports over app://) ----
  const pages = ['folders', 'prompts', 'queue', 'gallery', 'history', 'settings', 'logs', 'dashboard'];
  for (const page of pages) {
    await client.eval(`document.querySelector('.nav button[data-page="${page}"]').click()`);
    await sleep(900);
    const state = await client.eval(`(() => {
      const host = document.querySelector('#page-host');
      return {
        cards: host.querySelectorAll('.card').length,
        textLength: host.innerText.trim().length,
        error: !!host.querySelector('.banner.error'),
        active: document.querySelector('.nav button[data-page="${page}"]').classList.contains('active'),
        html: host.innerText.slice(0, 120)
      };
    })()`);
    check(`page "${page}" renders content`, state.textLength > 20 && state.cards > 0 && !state.error,
      `cards=${state.cards} len=${state.textLength} error=${state.error} text="${state.html.replace(/\n/g, ' ')}"`);
    check(`page "${page}" nav item activates`, state.active === true);
  }

  // ---- persistence writes for phase 2 ----
  const saved = await client.eval(
    "window.api.savePrompt({ name: 'E2E Persisted Prompt', body: 'E2E verbatim master prompt body' })");
  check('prompt:save returns an id', !!saved && saved.ok === true && !!saved.id, JSON.stringify(saved));
  const setDefault = await client.eval(`window.api.setDefault(${JSON.stringify(saved && saved.id)})`);
  check('prompt:set-default succeeds', !!setDefault && setDefault.ok === true, JSON.stringify(setDefault));
  const settingsSaved = await client.eval('window.api.setSettings({ maxRetries: 4 })');
  check('settings:set persists a change', !!settingsSaved && settingsSaved.ok === true && settingsSaved.settings.maxRetries === 4,
    JSON.stringify(settingsSaved && settingsSaved.settings && settingsSaved.settings.maxRetries));

  // ---- renderer console/exception errors ----
  const rendererErrors = client.events.filter((event) => {
    if (event.method === 'Runtime.exceptionThrown') return true;
    if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') return true;
    if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
      return !/favicon|ERR_FILE_NOT_FOUND/i.test(event.params.entry.text || '');
    }
    return false;
  });
  check('no renderer console errors or uncaught exceptions', rendererErrors.length === 0,
    rendererErrors.slice(0, 4).map((event) => event.method).join(', '));

  client.close();
}

async function phase2() {
  const { target } = await waitForTarget((item) => item.type === 'page' && item.url.startsWith('app://bundle/'));
  const client = new CDP(target.webSocketDebuggerUrl);
  await client.open();
  await client.send('Runtime.enable');
  await waitFor(client, "typeof window.api === 'object'", 30000);
  await waitFor(client, "document.querySelectorAll('#page-host .stat-card').length >= 5", 40000);

  const prompts = await client.eval('window.api.listPrompts()');
  const persisted = Array.isArray(prompts) ? prompts.find((prompt) => prompt.name === 'E2E Persisted Prompt') : null;
  check('prompt persisted across app restart', !!persisted && persisted.body === 'E2E verbatim master prompt body',
    persisted ? persisted.name : 'not found');
  check('persisted prompt is the default after restart', !!persisted && persisted.is_default === 1,
    persisted ? String(persisted.is_default) : 'n/a');

  const settings = await client.eval('window.api.getSettings()');
  check('settings persisted across app restart', !!settings && settings.maxRetries === 4,
    settings ? String(settings.maxRetries) : 'null');

  const jobs = await client.eval('window.api.getJobs()');
  check('queue loads from the SQLite database after restart', Array.isArray(jobs), Array.isArray(jobs) ? `${jobs.length} jobs` : 'not an array');
  const history = await client.eval('window.api.getHistory()');
  check('history loads from the SQLite database after restart', Array.isArray(history) && history.length > 0,
    Array.isArray(history) ? `${history.length} events` : 'not an array');
  const dashboard = await client.eval('window.api.getDashboard()');
  check('dashboard still reports a valid state after restart', !!dashboard && !!dashboard.counts,
    JSON.stringify(dashboard && dashboard.counts));

  // restore the default setting used by the product
  await client.eval('window.api.setSettings({ maxRetries: 3 })');
  client.close();
}

(async () => {
  try {
    if (PHASE === 'phase1') await phase1();
    else if (PHASE === 'phase2') await phase2();
    else throw new Error(`Unknown phase: ${PHASE}`);
    report();
  } catch (err) {
    console.log(`\nUI TEST HARNESS ERROR: ${err && err.stack ? err.stack : err}`);
    report();
    process.exitCode = 2;
  }
})();
