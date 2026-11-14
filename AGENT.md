# AGENT.md — GEMINI BULK IMAGE STUDIO
## MASTER BUILD COMMAND FOR AI CODING AGENTS

**YOU ARE AN AI CODING AGENT.** Your task is to build a complete, production-ready
Windows desktop application called **GEMINI BULK IMAGE STUDIO** exactly as specified
in this document. Build every file listed. Do not skip sections. Do not ask for
clarification — make reasonable decisions and document them in `README.md`.

**Build order:** follow Sections 1 → 20 in order. After each section, write the
files to disk. Test at the end using Section 18's checklist.

---

## SECTION 1 — MISSION AND HARD RULES

### 1.1 What you are building

A Windows desktop application that:

1. Displays the **real** `https://gemini.google.com/app` inside its own window
2. Lets the user sign in to Google **manually, once**
3. Preserves that login across restarts
4. Reads images from a user-selected input folder
5. For **each image, sequentially**: uploads → types a saved master prompt → submits → waits for generation → downloads the actual generated image → saves it to the output folder with a `_generated` suffix
6. **Never** starts image N+1 until image N is downloaded and verified
7. Persists queue state so it survives crashes
8. Shows a professional dashboard with all required controls

### 1.2 Hard rules — violating any of these fails the build

| # | Rule |
|---|------|
| R1 | Must be **Electron**, not a website |
| R2 | Must display **real** Gemini, not a mockup, not the API, not fake images |
| R3 | Must use `WebContentsView` (Electron 30+) or `BrowserView` — **never** `<iframe>` (Gemini blocks iframes) |
| R4 | Must use `partition: 'persist:gemini-session'` for login persistence |
| R5 | Must **never** ask for or store Google password |
| R6 | Must process images **strictly one at a time** |
| R7 | Must **never** mark failed jobs as completed |
| R8 | Must **never** overwrite completed outputs |
| R9 | Must pause + show prompt on CAPTCHA/MFA — never bypass |
| R10 | All Gemini selectors must live in `config/selectors.json` — **zero hardcoded DOM selectors in `.js` files** |
| R11 | `contextIsolation: true`, `nodeIntegration: false` everywhere |
| R12 | Gemini view must run in **its own session partition**, isolated from app UI |
| R13 | Must use `better-sqlite3` for persistence — no JSON-only queues |
| R14 | Must log structured events (pino) — no `console.log` in production code |
| R15 | Must build a working Windows installer via `electron-builder` |

---

## SECTION 2 — CREATE THIS EXACT FILE TREE

Create every file listed below. Files marked `⭐` contain the most critical logic
and have full code patterns in later sections.

```
gemini-bulk-image-studio/
├── AGENT.md                              (this file — do not modify)
├── package.json                          ⭐ Section 4
├── README.md                             Section 19
├── START.bat                             Section 20.1
├── BUILD.bat                             Section 20.2
├── .gitignore
├── config/
│   ├── selectors.json                    ⭐ Section 7
│   └── app.config.json                   Section 6.2
├── assets/
│   └── icons/
│       └── app.ico                       (generate a 256x256 placeholder)
├── src/
│   ├── main/
│   │   ├── main.js                       ⭐ Section 5.1
│   │   ├── window-manager.js             ⭐ Section 5.2
│   │   ├── browser-manager.js            ⭐ Section 5.3
│   │   ├── download-manager.js           ⭐ Section 5.4
│   │   ├── folder-manager.js             Section 5.5
│   │   ├── ipc-handlers.js               ⭐ Section 5.6
│   │   └── paths.js                      Section 5.7
│   ├── preload/
│   │   └── preload.js                    ⭐ Section 6.1
│   ├── renderer/
│   │   ├── index.html                    ⭐ Section 6.3
│   │   ├── styles.css                    ⭐ Section 6.4
│   │   ├── app.js                        ⭐ Section 6.5
│   │   └── pages/
│   │       ├── dashboard.js              Section 6.6
│   │       ├── folders.js                Section 6.6
│   │       ├── prompts.js                Section 6.6
│   │       ├── queue.js                  Section 6.6
│   │       ├── gallery.js                Section 6.6
│   │       ├── history.js                Section 6.6
│   │       ├── settings.js               Section 6.6
│   │       └── logs.js                   Section 6.6
│   ├── automation/
│   │   ├── gemini-adapter.js             ⭐ Section 8.1
│   │   ├── selector-resolver.js          ⭐ Section 8.2
│   │   ├── generation-engine.js          ⭐ Section 8.3
│   │   ├── upload-engine.js              ⭐ Section 8.4
│   │   ├── image-download.js             ⭐ Section 8.5
│   │   ├── state-machine.js              ⭐ Section 8.6
│   │   └── recovery-engine.js            Section 8.7
│   ├── database/
│   │   ├── database.js                   ⭐ Section 3.1
│   │   ├── migrations/
│   │   │   └── 001_init.sql              ⭐ Section 3.2
│   │   └── repos/
│   │       ├── jobs.repo.js              Section 3.3
│   │       ├── prompts.repo.js           Section 3.3
│   │       └── history.repo.js           Section 3.3
│   └── services/
│       ├── image-service.js              Section 3.4
│       ├── file-service.js               Section 3.4
│       ├── prompt-service.js             Section 3.4
│       └── logging-service.js            Section 3.5
└── data/                                  (created at runtime)
```

**Total files to create: ~45.** Do not stop until all exist and the app runs.

---

## SECTION 3 — DATABASE LAYER

### 3.1 `src/database/database.js` ⭐

```javascript
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let db = null;

function getDb() {
  if (db) return db;
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'application.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const migrationFile = path.join(__dirname, 'migrations', '001_init.sql');
  const sql = fs.readFileSync(migrationFile, 'utf8');
  db.exec(sql);
}

function closeDb() {
  if (db) { db.close(); db = null; }
}

module.exports = { getDb, closeDb };
```

### 3.2 `src/database/migrations/001_init.sql` ⭐

Write the exact SQL from Section 5.1 (jobs, batches, prompts, events tables + indexes).
Make every `CREATE` idempotent with `IF NOT EXISTS`.

### 3.3 Repos

Create `jobs.repo.js`, `prompts.repo.js`, `history.repo.js`. Each exports plain
functions:
- `getNextPendingJob(batchId)` — returns next job with `status = 'PENDING'`, ordered by `created_at`
- `updateJobStatus(jobId, newStatus, extraFields)` — runs state-machine validation, writes to DB
- `incrementBatchCompleted(batchId)`, `incrementBatchFailed(batchId)`
- `createBatch(...)`, `getActiveBatch()`
- `createPrompt(...)`, `getDefaultPrompt()`, `listPrompts()`, `setDefaultPrompt(id)`
- `logEvent(jobId, level, category, message, meta)` — inserts into `events`

### 3.4 `src/services/`

- `image-service.js` — wraps `sharp`: `getMetadata(path)`, `generateThumbnail(path)` (120×120 cached jpeg in `data/thumbs/{sha1}.jpg`)
- `file-service.js` — `verifyReadable(path)`, `verifyImage(path)` (checks size>0 + sharp can read), `ensureDir(path)`, `listImagesInFolder(folder, { includeSubfolders })` returning array of `{ path, name, size, ext }` filtered to `jpg|jpeg|png|webp`
- `prompt-service.js` — thin wrapper around prompts.repo
- `logging-service.js` — creates pino logger, writes to `data/logs/app.log` + console in dev. **Never** log Cookie/Authorization headers.

### 3.5 Logging rules

```javascript
// NEVER do this:
logger.info({ headers: req.headers }, 'request');

// DO this:
logger.info({ url: req.url, status: req.status }, 'request');
```

---

## SECTION 4 — `package.json` ⭐

Use **exactly** this file:

```json
{
  "name": "gemini-bulk-image-studio",
  "version": "2.0.0",
  "description": "Bulk image generation through the real Gemini website",
  "main": "src/main/main.js",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "start": "electron .",
    "build": "electron-builder --win",
    "postinstall": "electron-builder install-app-deps"
  },
  "dependencies": {
    "electron-store": "^8.2.0",
    "better-sqlite3": "^11.3.0",
    "sharp": "^0.33.5",
    "pino": "^9.4.0",
    "pino-pretty": "^11.2.2",
    "archiver": "^7.0.1",
    "dayjs": "^1.11.13",
    "uuid": "^10.0.0"
  },
  "devDependencies": {
    "electron": "^32.2.0",
    "electron-builder": "^25.1.7"
  },
  "build": {
    "appId": "com.gemini.bulkimagestudio",
    "productName": "Gemini Bulk Image Studio",
    "directories": { "output": "dist" },
    "files": [
      "src/**/*",
      "assets/**/*",
      "config/**/*",
      "package.json"
    ],
    "win": {
      "target": [{ "target": "nsis", "arch": ["x64"] }],
      "icon": "assets/icons/app.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "perMachine": false
    }
  }
}
```

---

## SECTION 5 — MAIN PROCESS

### 5.1 `src/main/main.js` ⭐

```javascript
// CRITICAL: must be first
const { app } = require('electron');
app.commandLine.appendSwitch('remote-debugging-port', '9222');

const { WindowManager } = require('./window-manager');
const { registerIpcHandlers } = require('./ipc-handlers');
const { closeDb } = require('../database/database');

let windowManager = null;

app.whenReady().then(async () => {
  windowManager = new WindowManager();
  await windowManager.create();
  registerIpcHandlers(windowManager);
});

app.on('window-all-closed', () => {
  closeDb();
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught:', err);
});
```

### 5.2 `src/main/window-manager.js` ⭐

```javascript
const { BrowserWindow } = require('electron');
const path = require('path');
const { BrowserManager } = require('./browser-manager');

class WindowManager {
  constructor() {
    this.window = null;
    this.browser = null;
  }

  async create() {
    this.window = new BrowserWindow({
      width: 1680,
      height: 1000,
      minWidth: 1200,
      minHeight: 700,
      title: 'Gemini Bulk Image Studio',
      backgroundColor: '#0f1117',
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,  // needed for preload require()
      },
    });

    await this.window.loadFile(
      path.join(__dirname, '../renderer/index.html')
    );

    this.browser = new BrowserManager(this.window);
    this.browser.create();

    this.window.on('closed', () => {
      this.browser?.destroy();
      this.window = null;
      this.browser = null;
    });
  }

  getBrowser() { return this.browser; }
  getWindow() { return this.window; }
  send(channel, data) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, data);
    }
  }
}

module.exports = { WindowManager };
```

### 5.3 `src/main/browser-manager.js` ⭐

Implement exactly the `BrowserManager` class from earlier sections. Key points:

- `partition: 'persist:gemini-session'`
- `sandbox: true`, `nodeIntegration: false`, `contextIsolation: true`
- `setWindowOpenHandler` allows `accounts.google.com` popups only
- `updateBounds()` positions view at `x: 480, y: 0, width: w-480, height: h`
- Attach `webContents.debugger` on creation for CDP automation
- Expose `getWebContents()`, `reload()`, `goBack()`, `goForward()`

### 5.4 `src/main/download-manager.js` ⭐

Handles both blob: URLs (fetch in page context → base64 → write) and http(s) URLs
(use `session.once('will-download')` + `webContents.downloadURL(src)`).

```javascript
const fs = require('fs').promises;

class DownloadManager {
  constructor(webContents) {
    this.wc = webContents;
  }

  async saveImage(src, outputPath) {
    if (src.startsWith('blob:')) {
      const base64 = await this.wc.executeJavaScript(`
        (async () => {
          const r = await fetch(${JSON.stringify(src)});
          const b = await r.blob();
          return new Promise(res => {
            const fr = new FileReader();
            fr.onloadend = () => res(fr.result.split(',')[1]);
            fr.readAsDataURL(b);
          });
        })()
      `, true);
      await fs.writeFile(outputPath, Buffer.from(base64, 'base64'));
      return;
    }

    await new Promise((resolve, reject) => {
      const session = this.wc.session;
      const handler = (_e, item) => {
        item.setSavePath(outputPath);
        item.once('done', (_e2, state) => {
          session.removeListener('will-download', handler);
          if (state === 'completed') resolve();
          else reject(new Error(`Download ${state}`));
        });
      };
      session.once('will-download', handler);
      this.wc.downloadURL(src);
    });
  }
}

module.exports = { DownloadManager };
```

### 5.5 `src/main/folder-manager.js`

`listImages(folder, { includeSubfolders })` → array of `{ path, name, size, ext }`.
Also `generateThumbnailBase64(imagePath)` using `sharp`.

### 5.6 `src/main/ipc-handlers.js` ⭐

Register every IPC channel from Section 9. Each handler:

1. Validates input types
2. Sanitizes any file paths via `path.resolve` + prefix check
3. Catches errors and returns `{ ok: false, error: msg }`
4. Emits `event:job-update` when job state changes

### 5.7 `src/main/paths.js`

```javascript
const path = require('path');
const { app } = require('electron');
module.exports = {
  dataDir:   path.join(app.getPath('userData'), 'data'),
  logsDir:   path.join(app.getPath('userData'), 'data', 'logs'),
  thumbsDir: path.join(app.getPath('userData'), 'data', 'thumbs'),
};
```

---

## SECTION 6 — PRELOAD + RENDERER

### 6.1 `src/preload/preload.js` ⭐

Expose a clean API under `window.api`. Channels:

```javascript
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
const subscribe = (ch, cb) => {
  const fn = (_e, d) => cb(d);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('api', {
  // folders
  pickInputFolder:  () => invoke('folder:pick-input'),
  pickOutputFolder: () => invoke('folder:pick-output'),
  scanFolder:       (folder, opts) => invoke('folder:scan', folder, opts),

  // prompts
  listPrompts:   () => invoke('prompt:list'),
  savePrompt:    (p) => invoke('prompt:save', p),
  setDefault:    (id) => invoke('prompt:set-default', id),
  deletePrompt:  (id) => invoke('prompt:delete', id),

  // batch
  startBatch:   (batchOpts) => invoke('batch:start', batchOpts),
  pauseBatch:   () => invoke('batch:pause'),
  resumeBatch:  () => invoke('batch:resume'),
  stopBatch:    () => invoke('batch:stop'),
  skipCurrent:  () => invoke('batch:skip'),
  retryFailed:  () => invoke('batch:retry-failed'),

  // state
  getDashboard: () => invoke('state:dashboard'),
  getJobs:      (filter) => invoke('state:jobs', filter),
  getHistory:   (filter) => invoke('state:history', filter),

  // settings
  getSettings: () => invoke('settings:get'),
  setSettings: (s) => invoke('settings:set', s),

  // browser controls
  browserReload:  () => invoke('browser:reload'),
  browserBack:    () => invoke('browser:back'),
  browserForward: () => invoke('browser:forward'),
  getLoginStatus: () => invoke('browser:login-status'),

  // diagnostics
  runDiagnostics: () => invoke('diag:run'),

  // events
  onJobUpdate:  (cb) => subscribe('event:job-update', cb),
  onLog:        (cb) => subscribe('event:log', cb),
  onLoginState: (cb) => subscribe('event:login-state', cb),
});
```

### 6.2 `config/app.config.json`

```json
{
  "maxRetries": 3,
  "generationTimeoutMs": 180000,
  "downloadTimeoutMs": 60000,
  "uploadTimeoutMs": 45000,
  "autoQueueNewImages": false,
  "includeSubfolders": false,
  "outputFilenameFormat": "{base}_generated{ext}",
  "duplicateHandling": "rename",
  "theme": "dark",
  "startWithWindows": false,
  "confirmBeforeBatch": true,
  "pauseAfterError": true
}
```

### 6.3 `src/renderer/index.html` ⭐

Two-column layout:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Gemini Bulk Image Studio</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <aside class="sidebar">
    <header class="brand">
      <h1>GEMINI <span>BULK</span><br/>IMAGE STUDIO</h1>
    </header>

    <nav class="nav">
      <button data-page="dashboard" class="active">Dashboard</button>
      <button data-page="folders">Folders</button>
      <button data-page="prompts">Prompts</button>
      <button data-page="queue">Queue</button>
      <button data-page="gallery">Gallery</button>
      <button data-page="history">History</button>
      <button data-page="settings">Settings</button>
      <button data-page="logs">Logs</button>
    </nav>

    <div class="status-bar">
      <div class="status-item">
        <span class="label">Login</span>
        <span id="loginStatus" class="value">Checking…</span>
      </div>
      <div class="status-item">
        <span class="label">Gemini</span>
        <span id="geminiStatus" class="value">—</span>
      </div>
    </div>

    <div id="page-host" class="page-host"></div>
  </aside>

  <main class="gemini-host">
    <!-- WebContentsView is positioned here by the main process -->
  </main>

  <script src="app.js" type="module"></script>
</body>
</html>
```

### 6.4 `src/renderer/styles.css` ⭐

Dark professional theme. Use these tokens:

```css
:root {
  --bg-primary:   #0f1117;
  --bg-panel:     #171a23;
  --bg-card:      #1f2330;
  --border:       #2a2f3d;
  --text-primary: #e8eaf0;
  --text-muted:   #8b93a7;
  --accent:       #7c5cff;
  --success:      #36c98f;
  --warning:      #f5a623;
  --danger:       #f05252;
  --radius:       10px;
  --font-sans:    "Inter", "Segoe UI", system-ui, sans-serif;
  --font-mono:    "JetBrains Mono", Consolas, monospace;
}

* { box-sizing: border-box; }
html, body {
  margin: 0; height: 100vh;
  background: var(--bg-primary); color: var(--text-primary);
  font-family: var(--font-sans); overflow: hidden;
}
body { display: grid; grid-template-columns: 480px 1fr; }

.sidebar {
  background: var(--bg-panel); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; overflow: hidden;
}
.brand { padding: 20px 20px 12px; }
.brand h1 {
  font-size: 15px; letter-spacing: 0.1em; line-height: 1.2;
  margin: 0; color: var(--text-primary);
}
.brand h1 span { color: var(--accent); }

.nav {
  display: flex; flex-direction: column; gap: 2px;
  padding: 8px 12px; border-bottom: 1px solid var(--border);
}
.nav button {
  background: transparent; border: none; color: var(--text-muted);
  text-align: left; padding: 9px 12px; border-radius: 8px;
  font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit;
}
.nav button:hover { background: rgba(255,255,255,0.04); color: var(--text-primary); }
.nav button.active { background: var(--accent); color: #fff; }

.status-bar {
  display: grid; grid-template-columns: 1fr 1fr;
  padding: 10px 16px; border-bottom: 1px solid var(--border);
  gap: 12px; font-size: 11px;
}
.status-item .label { color: var(--text-muted); display: block; text-transform: uppercase; }
.status-item .value { font-weight: 600; }

.page-host { flex: 1; overflow-y: auto; padding: 16px; }

.gemini-host { position: relative; background: var(--bg-primary); }

/* Buttons */
button.primary {
  background: var(--accent); color: #fff; border: none;
  padding: 10px 16px; border-radius: 8px;
  font-weight: 600; cursor: pointer; font-family: inherit; font-size: 13px;
}
button.primary:hover { filter: brightness(1.1); }
button.ghost {
  background: transparent; color: var(--text-primary);
  border: 1px solid var(--border); padding: 8px 14px;
  border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 12px;
}
button.success { background: var(--success); color: #0b1a13; }
button.warning { background: var(--warning); color: #1a1200; }
button.danger  { background: var(--danger); color: #fff; }
button:disabled { opacity: 0.45; cursor: not-allowed; }
```

### 6.5 `src/renderer/app.js` ⭐

```javascript
const pages = {
  dashboard: () => import('./pages/dashboard.js'),
  folders:   () => import('./pages/folders.js'),
  prompts:   () => import('./pages/prompts.js'),
  queue:     () => import('./pages/queue.js'),
  gallery:   () => import('./pages/gallery.js'),
  history:   () => import('./pages/history.js'),
  settings:  () => import('./pages/settings.js'),
  logs:      () => import('./pages/logs.js'),
};

let currentPage = null;

async function navigate(pageName) {
  document.querySelectorAll('.nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.page === pageName);
  });
  document.querySelectorAll('button[data-page]').forEach(b => {
    b.addEventListener('click', () => navigate(b.dataset.page));
  });
}

// wire nav
document.querySelectorAll('.nav button').forEach(btn => {
  btn.addEventListener('click', () => navigate(btn.dataset.page));
});

// subscribe to main-process events
window.api.onJobUpdate(update => {
  window.dispatchEvent(new CustomEvent('job-update', { detail: update }));
});
window.api.onLog(msg => {
  window.dispatchEvent(new CustomEvent('log', { detail: msg }));
});
window.api.onLoginState(state => {
  const el = document.getElementById('loginStatus');
  if (el) el.textContent =
    state === 'logged_in' ? '✅ Logged In'
    : state === 'needs_login' ? '⚠️ Sign In Required'
    : 'Unknown';
});

// initial page
navigate('dashboard');
```

Each page module exports `render(host)` and handles its own data fetching.

### 6.6 Pages

Each page in `src/renderer/pages/*.js` follows this shape:

```javascript
export default async function render(host) {
  host.innerHTML = `<div class="card">…loading…</div>`;
  // fetch data via window.api
  // build DOM
  // attach listeners
}
```

Required pages and their content:

- **dashboard.js** — 5 stat cards (Total, Completed, Processing, Pending, Failed), progress bar, current filename, ETA, control buttons (START, PAUSE, RESUME, STOP, SKIP, RETRY FAILED). Listen for `job-update` events and update live.
- **folders.js** — Input folder picker + scan + thumbnail grid; output folder picker; image count; refresh button.
- **prompts.js** — Textarea for prompt body, list of saved prompts, save/load/default buttons.
- **queue.js** — Table of all jobs with status badges, retry/skip buttons per row.
- **gallery.js** — Grid of completed images, click to enlarge, open folder, ZIP export.
- **history.js** — Filterable table of events + CSV export.
- **settings.js** — All settings from Section 6.2 as a form, save button.
- **logs.js** — Live log stream (subscribe to `onLog`), diagnostics button.

---

## SECTION 7 — `config/selectors.json` ⚠️

⚠️ **These selectors are best-guess from public sources. Verify against live Gemini.**

```json
{
  "_comment": "Fallback chains. Each tried in order until one matches a visible+enabled element.",
  "_lastVerified": "verify before shipping",

  "promptEditor": [
    "div.ql-editor[contenteditable=\"true\"]",
    "rich-textarea div[contenteditable=\"true\"]",
    "div[contenteditable=\"true\"][role=\"textbox\"]",
    "textarea[aria-label*=\"prompt\" i]"
  ],
  "sendButton": [
    "button.send-button:not([disabled])",
    "button[aria-label*=\"Send message\" i]:not([disabled])",
    "button[aria-label*=\"Submit\" i]:not([disabled])",
    "button[type=\"submit\"]:not([disabled])"
  ],
  "uploadButton": [
    "button[aria-label*=\"Upload\" i]",
    "button[aria-label*=\"Add file\" i]",
    "button[aria-label*=\"Add image\" i]",
    "gem-icon-button[aria-label*=\"Upload\" i]",
    "button[data-test-id=\"upload-button\"]"
  ],
  "fileInput": [
    "input[type=\"file\"][accept*=\"image\"]",
    "input[type=\"file\"]"
  ],
  "generatedImage": [
    "message-content img[src*=\"googleusercontent.com\"]",
    "model-response img[src*=\"googleusercontent.com\"]",
    "img[src*=\"lh3.googleusercontent.com\"]",
    "img[src^=\"blob:\"][width]:not([width=\"0\"])"
  ],
  "downloadButton": [
    "button[aria-label*=\"Download\" i]",
    "button[aria-label*=\"Save image\" i]",
    "download-generated-image-button"
  ],
  "generatingIndicator": [
    "[data-test-id=\"loading-indicator\"]",
    "mat-progress-bar",
    "div[role=\"progressbar\"]"
  ],
  "usageLimitBanner": [
    "[role=\"alert\"]:has-text(\"limit\")",
    "[role=\"alert\"]:has-text(\"try again later\")"
  ],
  "captchaIndicator": [
    "iframe[src*=\"recaptcha\"]",
    "iframe[src*=\"challenges.cloudflare.com\"]",
    "div[class*=\"captcha\"]"
  ],
  "signInButton": [
    "a[href*=\"accounts.google.com\"]",
    "button:has-text(\"Sign in\")"
  ]
}
```

The app must **fail loudly** when a selector cannot be found. Never silently
fall back to `document.querySelector('button')`.

---

## SECTION 8 — AUTOMATION ENGINE

### 8.1 `src/automation/gemini-adapter.js` ⭐

Wraps all Gemini page interaction. Uses **Electron's `webContents.debugger`**
(Path A) — no Playwright needed at runtime.

```javascript
const { SelectorResolver } = require('./selector-resolver');
const selectors = require('../../config/selectors.json');

class GeminiAdapter {
  constructor(webContents, logger) {
    this.wc = webContents;
    this.logger = logger;
    this.resolver = new SelectorResolver(selectors, logger);
    this.attached = false;
  }

  async attach() {
    if (this.attached) return;
    this.wc.debugger.attach('1.3');
    await this.wc.debugger.sendCommand('Page.enable');
    await this.wc.debugger.sendCommand('Runtime.enable');
    await this.wc.debugger.sendCommand('DOM.enable');
    await this.wc.debugger.sendCommand('Network.enable');
    this.attached = true;
  }

  async exec(js) {
    const { result } = await this.wc.debugger.sendCommand('Runtime.evaluate', {
      expression: js,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
    }
    return result.value;
  }

  async findSelector(key) {
    const chain = selectors[key];
    for (const sel of chain) {
      const found = await this.exec(`
        !!document.querySelector(${JSON.stringify(sel)})
      `);
      if (found) return sel;
    }
    this.logger.warn({ key, chain }, 'selector not found');
    throw new SelectorNotFoundError(key, chain);
  }

  // ---- concrete operations ----

  async checkLoginStatus() {
    const url = this.wc.getURL();
    if (url.includes('accounts.google.com')) return 'needs_login';
    const hasEditor = await this.exec(`
      !!document.querySelector('div.ql-editor[contenteditable="true"]')
    `);
    if (hasEditor) return 'logged_in';
    const hasSignIn = await this.exec(`
      !!document.querySelector('a[href*="accounts.google.com"]')
    `);
    return hasSignIn ? 'needs_login' : 'unknown';
  }

  async countGeneratedImages() {
    return this.exec(`
      Array.from(document.querySelectorAll('img'))
        .filter(i => i.naturalWidth > 512 && i.naturalHeight > 512)
        .length
    `);
  }

  async attachImage(filePath) {
    await this.attach();

    // Enable file chooser interception
    await this.wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', {
      enabled: true,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wc.debugger.off('message', onMessage);
        reject(new Error('File chooser never opened'));
      }, 15000);

      const onMessage = async (_event, method, params) => {
        if (method === 'Page.fileChooserOpened') {
          clearTimeout(timer);
          this.wc.debugger.off('message', onMessage);
          try {
            await this.wc.debugger.sendCommand('DOM.setFileInputFiles', {
              backendNodeId: params.backendNodeId,
              files: [filePath],
            });
            resolve();
          } catch (e) {
            reject(e);
          }
        }
      };

      this.wc.debugger.on('message', onMessage);

      // Click upload button
      (async () => {
        const sel = await this.findSelector('uploadButton');
        await this.exec(`
          document.querySelector(${JSON.stringify(sel)}).click()
        `);
      })().catch(err => {
        clearTimeout(timer);
        this.wc.debugger.off('message', onMessage);
        reject(err);
      });
    });
  }

  async verifyUploadComplete(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const attached = await this.exec(`
        document.querySelectorAll('img').length > 0
      `);
      if (attached) return;
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Upload did not complete');
  }

  async enterPrompt(promptText) {
    const sel = await this.findSelector('promptEditor');
    await this.exec(`
      (function() {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return false;
        el.focus();
        document.execCommand('insertText', false, ${JSON.stringify(promptText)});
        return true;
      })()
    `);
  }

  async submitPrompt() {
    try {
      const sel = await this.findSelector('sendButton');
      await this.exec(`
        document.querySelector(${JSON.stringify(sel)}).click()
      `);
    } catch {
      // Fallback: Enter key
      this.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      this.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }
  }

  async waitForNewImage(beforeCount, timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = await this.countGeneratedImages();
      if (count > beforeCount) {
        // Return src of newest large image
        const src = await this.exec(`
          Array.from(document.querySelectorAll('img'))
            .filter(i => i.naturalWidth > 512 && i.naturalHeight > 512)
            .pop()?.src
        `);
        if (src) return src;
      }

      // Check for errors
      const hasError = await this.exec(`
        !!document.querySelector('[role="alert"]')
      `);
      if (hasError) {
        throw new Error('Gemini returned an error card');
      }

      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('Generation timeout');
  }
}

module.exports = { GeminiAdapter };
```

### 8.2 `src/automation/selector-resolver.js` ⭐

See Section 7.3 pattern. Throw `SelectorNotFoundError` when nothing matches.

### 8.3 `src/automation/generation-engine.js` ⭐

```javascript
const fs = require('fs').promises;
const path = require('path');
const { GeminiAdapter } = require('./gemini-adapter');
const { DownloadManager } = require('../main/download-manager');
const { assertTransition } = require('./state-machine');
const { fileService } = require('../services/file-service');
const { imageService } = require('../services/image-service');

class GenerationEngine {
  constructor({ webContents, logger, settings, jobsRepo, promptsRepo, emit }) {
    this.adapter = new GeminiAdapter(webContents, logger);
    this.downloader = new DownloadManager(webContents);
    this.logger = logger;
    this.settings = settings;
    this.jobsRepo = jobsRepo;
    this.promptsRepo = promptsRepo;
    this.emit = emit;
    this.running = false;
    this.paused = false;
    this.stopped = false;
  }

  async start(batch) {
    this.running = true;
    await this.adapter.attach();

    while (!this.stopped) {
      if (this.paused) { await this.sleep(500); continue; }

      const job = this.jobsRepo.getNextPendingJob(batch.id);
      if (!job) break;

      try {
        await this.processJob(job, batch);
      } catch (err) {
        await this.handleFailure(job, err);
      }

      if (this.pausedAfterError) {
        this.paused = true;
      }
    }

    this.running = false;
    this.emit('batch-finished', { batchId: batch.id });
  }

  async processJob(job, batch) {
    const startTime = Date.now();

    // PREPARING
    await this.setStatus(job, 'PREPARING', { started_at: new Date().toISOString() });
    await fileService.verifyReadable(job.original_path);

    const login = await this.adapter.checkLoginStatus();
    if (login !== 'logged_in') {
      throw new RecoverableError('NEEDS_LOGIN', 'Sign in to Gemini');
    }

    // UPLOADING
    await this.setStatus(job, 'UPLOADING');
    const beforeCount = await this.adapter.countGeneratedImages();
    await this.adapter.attachImage(job.original_path);
    await this.adapter.verifyUploadComplete();
    await this.setStatus(job, 'UPLOADED');

    // PROMPT_SUBMITTED
    await this.setStatus(job, 'PROMPT_SUBMITTED');
    const prompt = this.promptsRepo.getDefaultPrompt();
    if (!prompt) throw new Error('No default prompt set');
    await this.adapter.enterPrompt(prompt.body);
    await this.adapter.submitPrompt();

    // GENERATING
    await this.setStatus(job, 'GENERATING');
    const src = await this.adapter.waitForNewImage(
      beforeCount,
      this.settings.generationTimeoutMs
    );
    await this.setStatus(job, 'GENERATED');

    // DOWNLOADING
    await this.setStatus(job, 'DOWNLOADING');
    const outPath = this.computeOutputPath(job, batch);
    await this.downloader.saveImage(src, outPath);

    // VERIFYING
    await this.setStatus(job, 'VERIFYING');
    const ok = await fileService.verifyImage(outPath);
    if (!ok) throw new Error('Downloaded file is invalid');

    // COMPLETED
    await this.jobsRepo.updateJobStatus(job.id, 'COMPLETED', {
      output_path: outPath,
      output_name: path.basename(outPath),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });
    this.jobsRepo.incrementBatchCompleted(batch.id);
    this.emitUpdate(batch, job, 'COMPLETED', null);
  }

  computeOutputPath(job, batch) {
    const base = path.basename(job.original_name, `.${job.original_ext}`);
    let name = `${base}_generated.png`;
    let full = path.join(batch.output_folder, name);
    let counter = 1;
    while (fsExistsSync(full)) {
      name = `${base}_generated_${String(counter).padStart(2, '0')}.png`;
      full = path.join(batch.output_folder, name);
      counter++;
    }
    return full;
  }

  async setStatus(job, status, extra = {}) {
    assertTransition(job.status, status);
    await this.jobsRepo.updateJobStatus(job.id, status, extra);
    job.status = status;
    this.emit('job-update', { jobId: job.id, status });
  }

  async handleFailure(job, err) {
    const retryable = err instanceof RecoverableError;
    const retriesLeft = job.retry_count < this.settings.maxRetries;

    if (retryable && retriesLeft) {
      await this.jobsRepo.updateJobStatus(job.id, 'PENDING', {
        retry_count: job.retry_count + 1,
        error_code: err.code,
        error_message: err.message,
      });
      await this.sleep(8000 * (job.retry_count + 1));
    } else {
      await this.jobsRepo.updateJobStatus(job.id, 'FAILED', {
        error_code: err.code || 'UNKNOWN',
        error_message: err.message,
        completed_at: new Date().toISOString(),
      });
      this.jobsRepo.incrementBatchFailed(job.batch_id);
    }
    this.emit('job-update', { jobId: job.id, status: job.status, error: err.message });
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }
  stop() { this.stopped = true; }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

class RecoverableError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.retryable = true;
  }
}

function fsExistsSync(p) {
  try { require('fs').accessSync(p); return true; } catch { return false; }
}

module.exports = { GenerationEngine, RecoverableError };
```

### 8.4 `src/automation/upload-engine.js`

Can be folded into `gemini-adapter.js` — or kept separate if the adapter
exceeds 300 lines. **Either way, the CDP file-chooser interception pattern in
Section 8.1 is the correct approach and must not be changed.**

### 8.5 `src/automation/image-download.js`

Same as `download-manager.js` in Section 5.4.

### 8.6 `src/automation/state-machine.js` ⭐

```javascript
const TRANSITIONS = {
  DISCOVERED:        ['PENDING', 'SKIPPED'],
  PENDING:           ['PREPARING', 'SKIPPED'],
  PREPARING:         ['UPLOADING', 'FAILED', 'PAUSED'],
  UPLOADING:         ['UPLOADED', 'FAILED', 'PAUSED'],
  UPLOADED:          ['PROMPT_SUBMITTED', 'FAILED'],
  PROMPT_SUBMITTED:  ['GENERATING', 'FAILED'],
  GENERATING:        ['GENERATED', 'FAILED', 'PAUSED'],
  GENERATED:         ['DOWNLOADING', 'FAILED'],
  DOWNLOADING:       ['VERIFYING', 'FAILED'],
  VERIFYING:         ['COMPLETED', 'FAILED'],
  COMPLETED:         [],
  FAILED:            ['PENDING', 'SKIPPED'],
  SKIPPED:           ['PENDING'],
  PAUSED:            ['PENDING', 'SKIPPED'],
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from]) {
    throw new Error(`Unknown state: ${from}`);
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal transition: ${from} → ${to}`);
  }
}

module.exports = { TRANSITIONS, assertTransition };
```

### 8.7 `src/automation/recovery-engine.js`

Handles app startup: query DB for jobs stuck in transient states (UPLOADING,
GENERATING, DOWNLOADING) and reset them to PENDING with a note, so they retry
safely.

---

## SECTION 9 — IPC CONTRACT

Every channel used by `preload.js` must have a matching handler in
`ipc-handlers.js`. Reference:

| Channel | Args | Returns |
|---------|------|---------|
| `folder:pick-input` | — | `{ folder, images: [...] }` or `{ canceled: true }` |
| `folder:pick-output` | — | `{ folder }` or `{ canceled: true }` |
| `folder:scan` | `folder, opts` | `{ images: [...] }` |
| `prompt:list` | — | `[...]` |
| `prompt:save` | `{ id?, name, body }` | `{ id }` |
| `prompt:set-default` | `id` | `{ ok: true }` |
| `prompt:delete` | `id` | `{ ok: true }` |
| `batch:start` | `{ inputFolder, outputFolder, promptId }` | `{ batchId, total }` |
| `batch:pause` | — | `{ ok: true }` |
| `batch:resume` | — | `{ ok: true }` |
| `batch:stop` | — | `{ ok: true }` |
| `batch:skip` | — | `{ ok: true }` |
| `batch:retry-failed` | — | `{ requeued: n }` |
| `state:dashboard` | — | `{ total, completed, processing, pending, failed }` |
| `state:jobs` | `filter` | `[...]` |
| `state:history` | `filter` | `[...]` |
| `settings:get` | — | `{...}` |
| `settings:set` | `settings` | `{ ok: true }` |
| `browser:reload` | — | `{ ok: true }` |
| `browser:back` | — | `{ ok: true }` |
| `browser:forward` | — | `{ ok: true }` |
| `browser:login-status` | — | `'logged_in' \| 'needs_login' \| 'unknown'` |
| `diag:run` | — | `[{ key, found, selector }]` |

Emitted events (main → renderer):

- `event:job-update` → `{ jobId, status, error? }`
- `event:log` → `{ level, message, time }`
- `event:login-state` → `'logged_in' \| 'needs_login' \| 'unknown'`

---

## SECTION 10 — START / PAUSE / STOP / SKIP / RETRY FLOW

Implement in `ipc-handlers.js`:

**START**
1. Validate input folder + output folder + default prompt exist.
2. Check Gemini login → `checkLoginStatus()`. If not `logged_in`, return error.
3. Scan input folder → build job list in DB with status `PENDING`.
4. Create batch record with status `running`.
5. Instantiate `GenerationEngine` and call `.start(batch)` — **do not await**.
6. Return `{ batchId, total }`.

**PAUSE** — Call `engine.pause()`. Current job continues to safe point.

**RESUME** — Call `engine.resume()`.

**STOP** — Call `engine.stop()`. Update batch status to `stopped`.

**SKIP** — Set current job to `SKIPPED`, then let loop pick next `PENDING`.

**RETRY FAILED** — Query all jobs in batch with `status='FAILED'`, set back to `PENDING`, increment batch total.

---

## SECTION 11 — ERROR HANDLING TAXONOMY

Every thrown error must carry a `code`. Map to UI message:

| Code | Retry | UI |
|------|-------|-----|
| `NEEDS_LOGIN` | ❌ | Pause + banner: "Sign in to Gemini" |
| `CAPTCHA` | ❌ | Pause + banner: "Solve CAPTCHA in Gemini panel" |
| `USAGE_LIMIT` | ❌ | Stop batch + banner: "Daily limit reached" |
| `SELECTOR_NOT_FOUND` | ❌ | Stop batch + banner: "Gemini layout changed" |
| `UPLOAD_TIMEOUT` | ✅ | Auto-retry 3× |
| `GENERATION_TIMEOUT` | ✅ | Auto-retry 2×, then pause |
| `DOWNLOAD_FAILED` | ✅ | Auto-retry 3× |
| `INVALID_IMAGE` | ✅ | Auto-retry 2× |
| `NETWORK_ERROR` | ✅ | Exponential backoff |
| `DISK_FULL` | ❌ | Stop batch |
| `UNKNOWN` | ✅ | Auto-retry 1× then FAILED |

---

## SECTION 12 — SECURITY CHECKLIST

Verify **every** item before shipping:

- [ ] `contextIsolation: true` on app UI **and** Gemini view
- [ ] `nodeIntegration: false` on both
- [ ] `sandbox: true` on Gemini view
- [ ] No preload attached to Gemini view
- [ ] `setWindowOpenHandler` on Gemini view denies non-Google popups
- [ ] All file paths from renderer passed through `validatePath()` with root prefix check
- [ ] No `Cookie`, `Authorization`, `Set-Cookie` headers in any log
- [ ] No Google password input field anywhere
- [ ] `data/browser-profile/` never copied outside user's machine

```javascript
function validatePath(p, allowedRoot) {
  const path = require('path');
  const resolved = path.resolve(p);
  const root = path.resolve(allowedRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}
```

---

## SECTION 13 — TESTING CHECKLIST (MUST ALL PASS)

Run through this checklist manually before claiming completion. Every P0 must
pass.

### P0 — Blocking

- [ ] T01 App launches with Gemini loaded inside window
- [ ] T02 Sign in to Google once → status becomes "Logged In"
- [ ] T03 Restart app → still logged in
- [ ] T04 Select 3-image input folder → 3 thumbnails appear
- [ ] T05 Save prompt → restart app → prompt persists
- [ ] T06 START with 1 image → image uploads, prompt sent, image downloads
- [ ] T07 Output filename is `{base}_generated.png`
- [ ] T08 Output file exists in folder, size > 0, valid PNG
- [ ] T09 3-image batch completes fully
- [ ] T10 Image 2 upload starts only after image 1 saved

### P1 — Critical

- [ ] T11 Output collision → `_generated_01` suffix
- [ ] T12 PAUSE mid-batch → current completes, next waits
- [ ] T13 RESUME → continues
- [ ] T14 STOP → current stops safely
- [ ] T15 Close app mid-batch → reopen → queue restored
- [ ] T16 Upload failure → auto-retry 3×
- [ ] T17 Generation timeout → retry 2×
- [ ] T18 RETRY FAILED works
- [ ] T19 SKIP works
- [ ] T20 Empty prompt → START refuses
- [ ] T21 Missing output folder → START refuses

### P2 — Important

- [ ] T22 Non-image files ignored
- [ ] T23 WEBP inputs handled
- [ ] T24 History CSV export opens in Excel
- [ ] T25 Gallery ZIP export contains all selected
- [ ] T26 Diagnostics mode shows selector status

---

## SECTION 14 — STARTUP RECOVERY

On app launch, before showing any UI:

```javascript
function recoverStuckJobs() {
  const db = getDb();
  db.prepare(`
    UPDATE jobs
    SET status = 'PENDING', error_message = 'Recovered from crash'
    WHERE status IN ('PREPARING', 'UPLOADING', 'PROMPT_SUBMITTED',
                     'GENERATING', 'DOWNLOADING', 'VERIFYING')
  `).run();
}
```

---

## SECTION 15 — OUTPUT FILENAME RULES

```
Original:    MA548.jpg
Generated:   MA548_generated.png
Collision 1: MA548_generated_01.png
Collision 2: MA548_generated_02.png
```

Always check `fs.existsSync` before writing. **Never** overwrite.

---

## SECTION 16 — THE PROMPT PRESERVATION RULE

**The same saved master prompt is used for EVERY image in a batch.** Do not
append instructions, do not paraphrase, do not inject extra text. Read it once
at batch start, use verbatim.

If the user edits the prompt mid-batch, it applies to the **next** batch only.

---

## SECTION 17 — PERFORMANCE TARGETS

| Metric | Target |
|--------|--------|
| Cold start | < 3s |
| Scan 100 images | < 2s |
| 100 thumbnails | < 5s (sharp, parallel ×4) |
| Memory idle | < 250 MB |
| Memory during batch | < 500 MB |
| DB write per job | < 5ms |

Use `sharp().resize(120,120).toBuffer()`. Cache thumbs at
`data/thumbs/{sha1-of-path}.jpg`. Never load full images into renderer.

---

## SECTION 18 — DELIVERY FILES

Before declaring "done", these must exist and work:

1. ✅ All source files from Section 2
2. ✅ `README.md` with installation + troubleshooting
3. ✅ `START.bat` for dev launch
4. ✅ `BUILD.bat` for installer build
5. ✅ `package.json` with correct scripts and dependencies
6. ✅ `config/selectors.json` with all fallback chains
7. ✅ `npm install && npm start` launches the app
8. ✅ `npm run build` produces `dist/Gemini Bulk Image Studio Setup 2.0.0.exe`

---

## SECTION 19 — `README.md` TEMPLATE

Include in the generated README:

```markdown
# Gemini Bulk Image Studio

Bulk image generation via the real Google Gemini website.

## Requirements
- Windows 10/11
- Node.js 20+ (dev only — not needed for .exe)
- Google account with Gemini access

## Install (dev)
1. Extract project folder
2. Run START.bat

## Install (production)
1. Run `Gemini Bulk Image Studio Setup 2.0.0.exe`
2. Launch from Start Menu

## First-time setup
1. Sign in to Google in the Gemini panel (right side)
2. Click "Folders" → Select Input Folder
3. Click "Prompts" → write master prompt → Save → Set Default
4. Click "Folders" → Select Output Folder
5. Click "Dashboard" → START

## Limitations
- Gemini's UI changes frequently. All selectors are in `config/selectors.json`.
- Automation may violate Google's Terms of Service. Use responsibly.
- CAPTCHA and MFA must be solved manually — this app pauses and shows a banner.
- Do NOT run other automation tools on the same Google account simultaneously.

## Troubleshooting
- "Selector not found" → open Settings → Diagnostics, check config/selectors.json
- "Sign in required" → complete Google sign-in in the Gemini panel
- "Generation timeout" → increase `generationTimeoutMs` in Settings
- Output file empty → Gemini returned an error; check the Gemini panel
```

---

## SECTION 20 — LAUNCHER SCRIPTS

### 20.1 `START.bat`

```bat
@echo off
setlocal
cd /d "%~dp0"
title GEMINI BULK IMAGE STUDIO

where node >nul 2>nul || (
  echo [!] Node.js 20+ required. Install from https://nodejs.org
  pause & exit /b 1
)

if not exist node_modules (
  echo [*] Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo [X] npm install failed & pause & exit /b 1 )
)

echo [*] Starting app...
call npx electron .
if errorlevel 1 ( echo [X] App exited with error & pause )
```

### 20.2 `BUILD.bat`

```bat
@echo off
cd /d "%~dp0"
call npm install
call npm run build
echo Installer at: dist\Gemini Bulk Image Studio Setup 2.0.0.exe
pause
```

---

## SECTION 21 — FINAL BUILD CHECKLIST FOR THE AI AGENT

Before claiming completion, verify:

- [ ] Every file from Section 2 exists with real code
- [ ] `npm install` runs without errors
- [ ] `npm start` opens the window with Gemini loaded on the right
- [ ] Left sidebar has all 8 navigation items working
- [ ] Dashboard shows all 5 stat cards
- [ ] START button is wired and does something
- [ ] All IPC channels from Section 9 have handlers
- [ ] `config/selectors.json` exists with all chains
- [ ] `state-machine.js` prevents illegal transitions
- [ ] `generation-engine.js` never processes 2 images at once
- [ ] `download-manager.js` handles both `blob:` and `https:` URLs
- [ ] `START.bat` launches correctly
- [ ] `npm run build` produces an installer
- [ ] `README.md` written with all sections

**If you cannot complete a section, document exactly what is missing in
`README.md` under "Known Limitations". Do not pretend a step works if it does
not.**

**End of AGENT.md**