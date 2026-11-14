'use strict';

// CRITICAL: must be first. Enables CDP access for diagnostics/troubleshooting.
const { app, protocol, Menu, dialog } = require('electron');
app.commandLine.appendSwitch('remote-debugging-port', '9222');

const fs = require('fs');
const path = require('path');

/**
 * Fatal startup problems (a missing native module in a broken install, an
 * unreadable profile directory, ...) must be visible instead of silently
 * killing the process. The full stack is written next to the app data so it
 * can be attached to a bug report.
 */
function writeStartupReport(message) {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'startup-error.log'), `${new Date().toISOString()} ${message}\n`);
  } catch (err) { /* nothing else we can do */ }
}

function fatalStartup(err) {
  const detail = err && err.stack ? err.stack : String(err);
  writeStartupReport(`FATAL: ${detail}`);
  try { console.error('FATAL STARTUP:', detail); } catch (inner) { /* no console */ }
  app.whenReady().then(() => {
    try {
      dialog.showErrorBox(
        'Gemini Bulk Image Studio — startup error',
        `${detail.slice(0, 1600)}\n\nDetails were written to:\n${path.join(app.getPath('userData'), 'startup-error.log')}`
      );
    } catch (inner) { /* best effort */ }
    app.exit(1);
  }).catch(() => app.exit(1));
}

// Testing hook: lets automated tests keep the browser profile and database
// inside the workspace instead of the real AppData folder.
if (process.env.GBS_USER_DATA_DIR) {
  try {
    app.setPath('userData', path.resolve(process.env.GBS_USER_DATA_DIR));
  } catch (err) { /* ignore invalid override */ }
}

// The renderer is served from a privileged app:// scheme so ES modules work
// without weakening webSecurity (file:// module scripts are CORS-blocked).
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

let WindowManager = null;
let registerIpcHandlers = null;
let closeDb = null;
let getDb = null;
let loggingService = null;
let recoverStuckJobs = null;

try {
  ({ WindowManager } = require('./window-manager'));
  ({ registerIpcHandlers } = require('./ipc-handlers'));
  ({ closeDb, getDb } = require('../database/database'));
  loggingService = require('../services/logging-service');
  ({ recoverStuckJobs } = require('../automation/recovery-engine'));
} catch (err) {
  fatalStartup(err);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function registerAppProtocol() {
  const rendererRoot = path.join(__dirname, '..', 'renderer');
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      let relativePath = decodeURIComponent(url.pathname || '/');
      if (relativePath === '/' || relativePath === '') relativePath = '/index.html';

      const resolved = path.normalize(path.join(rendererRoot, relativePath));
      if (resolved !== rendererRoot && !resolved.startsWith(rendererRoot + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }

      const data = await fs.promises.readFile(resolved);
      const mime = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      return new Response(data, {
        status: 200,
        headers: { 'content-type': mime, 'cache-control': 'no-store' }
      });
    } catch (err) {
      return new Response('Not found', { status: 404 });
    }
  });
}

let windowManager = null;
let logger = null;

if (WindowManager && registerIpcHandlers) {
  let gotSingleInstanceLock = true;
  try {
    // Test-only escape hatch: Electron's process singleton can be unavailable in
    // restricted CI/sandbox environments. Production always uses the lock.
    gotSingleInstanceLock = process.env.GBS_DISABLE_SINGLE_INSTANCE === '1'
      ? true
      : app.requestSingleInstanceLock();
  } catch (err) {
    // A failure to create the OS lock must never prevent the app from starting.
    gotSingleInstanceLock = true;
  }

  if (!gotSingleInstanceLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      const win = windowManager ? windowManager.getWindow() : null;
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });

    app.whenReady().then(async () => {
      logger = loggingService.createLogger();

      try {
        getDb();
        recoverStuckJobs(logger);
      } catch (err) {
        logger.error({ err: err.message }, 'database initialisation failed');
      }

      registerAppProtocol();
      Menu.setApplicationMenu(null);

      windowManager = new WindowManager(logger);
      await windowManager.create();

      loggingService.setBroadcaster((event) => windowManager.send('event:log', event));
      registerIpcHandlers(windowManager, logger);

      // Only now load the app UI, so every IPC channel already exists.
      await windowManager.loadRenderer();

      logger.info({
        version: app.getVersion(),
        userData: app.getPath('userData'),
        packaged: app.isPackaged
      }, 'Gemini Bulk Image Studio started');

      app.on('activate', async () => {
        if (!windowManager || !windowManager.getWindow()) {
          windowManager = new WindowManager(logger);
          await windowManager.create();
          registerIpcHandlers(windowManager, logger);
          await windowManager.loadRenderer();
        }
      });
    }).catch((err) => {
      fatalStartup(err);
    });

    app.on('window-all-closed', () => {
      try { closeDb(); } catch (err) { /* ignore */ }
      if (process.platform !== 'darwin') app.quit();
    });

    app.on('before-quit', () => {
      try { closeDb(); } catch (err) { /* ignore */ }
    });

    process.on('uncaughtException', (err) => {
      const detail = err && err.stack ? err.stack : String(err);
      try {
        if (logger) logger.error({ err: err.message, stack: err.stack }, 'uncaught exception');
        else writeStartupReport(`UNCAUGHT: ${detail}`);
      } catch (inner) {
        try { console.error('Uncaught:', err); } catch (e) { /* ignore */ }
      }
    });

    process.on('unhandledRejection', (reason) => {
      const message = reason && reason.message ? reason.message : String(reason);
      try {
        if (logger) logger.error({ err: message }, 'unhandled rejection');
        else writeStartupReport(`UNHANDLED REJECTION: ${message}`);
      } catch (inner) {
        try { console.error('Unhandled rejection:', reason); } catch (e) { /* ignore */ }
      }
    });
  }
}
