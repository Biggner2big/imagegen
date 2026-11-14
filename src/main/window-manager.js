'use strict';

const { BrowserWindow, Menu } = require('electron');
const path = require('path');

const { BrowserManager } = require('./browser-manager');

class WindowManager {
  constructor(logger) {
    this.logger = logger;
    this.window = null;
    this.browser = null;
    this.onClosed = null;
  }

  async create() {
    Menu.setApplicationMenu(null);

    this.window = new BrowserWindow({
      width: 1680,
      height: 1000,
      minWidth: 1200,
      minHeight: 700,
      title: 'Gemini Bulk Image Studio',
      backgroundColor: '#0f1117',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        sandbox: false, // required so the preload can require('electron')
        webSecurity: true,
        spellcheck: false
      }
    });

    this.window.once('ready-to-show', () => {
      if (this.window && !this.window.isDestroyed()) this.window.show();
    });

    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('app://')) event.preventDefault();
    });

    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('app://')) event.preventDefault();
    });

    // The Gemini view is created before the renderer loads; IPC handlers are
    // registered by the caller between create() and loadRenderer() so the
    // renderer can never invoke a channel that does not exist yet.
    this.browser = new BrowserManager(this.window, {
      logger: this.logger,
      send: (channel, payload) => this.send(channel, payload)
    });
    this.browser.create();

    this.window.on('closed', () => {
      try { if (this.browser) this.browser.destroy(); } catch (err) { /* best effort */ }
      this.browser = null;
      this.window = null;
      if (typeof this.onClosed === 'function') this.onClosed();
    });

    return this.window;
  }

  async loadRenderer() {
    if (!this.window || this.window.isDestroyed()) throw new Error('Window is not available');
    await this.window.loadURL('app://bundle/index.html');
  }

  getBrowser() {
    return this.browser;
  }

  getWindow() {
    return this.window;
  }

  send(channel, data) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, data);
    }
  }
}

module.exports = { WindowManager };
