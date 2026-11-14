'use strict';

const { WebContentsView, session } = require('electron');

const { GeminiAdapter, GEMINI_URL } = require('../automation/gemini-adapter');

const PARTITION = 'persist:gemini-session';
const SIDEBAR_WIDTH = 480;
const LOGIN_POLL_MS = 5000;

const ALLOWED_POPUP_SUFFIXES = ['.google.com'];
const ALLOWED_POPUP_HOSTS = ['accounts.google.com', 'consent.google.com', 'myaccount.google.com'];

/**
 * Owns the real Gemini website in an isolated persistent session partition.
 * The view is positioned to the right of the 480px application sidebar.
 */
class BrowserManager {
  constructor(window, { logger, send } = {}) {
    this.window = window;
    this.logger = logger;
    this.send = send || (() => {});
    this.view = null;
    this.adapter = null;
    this.loginTimer = null;
    this.lastLoginState = 'unknown';
    this.destroyed = false;
  }

  create() {
    const geminiSession = session.fromPartition(PARTITION);
    geminiSession.setPermissionRequestHandler((_wc, permission, callback) => {
      // The Gemini view never needs camera/mic/notifications from this app.
      if (this.logger) this.logger.debug({ permission }, 'denied Gemini permission request');
      callback(false);
    });

    this.view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false
      }
    });

    this.window.contentView.addChildView(this.view);

    const wc = this.view.webContents;

    wc.setWindowOpenHandler((details) => this.handleWindowOpen(details));

    wc.on('did-finish-load', () => {
      this.refreshLoginState();
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (this.logger) this.logger.warn({ errorCode, errorDescription, url: validatedURL }, 'Gemini failed to load');
      this.send('event:login-state', 'unknown');
      this.send('event:notice', {
        level: 'error',
        code: 'NETWORK_ERROR',
        message: `Could not load Gemini (${errorDescription}). Check your internet connection and click Reload in Settings.`,
        sticky: true
      });
    });

    wc.on('render-process-gone', (_event, details) => {
      if (this.logger) this.logger.error({ reason: details.reason }, 'Gemini renderer crashed');
      this.send('event:notice', {
        level: 'error',
        code: 'GEMINI_CRASHED',
        message: 'The Gemini page crashed. Open Settings and click Reload to recover.',
        sticky: true
      });
    });

    wc.on('destroyed', () => {
      this.stopLoginWatcher();
    });

    this.updateBounds();
    this.window.on('resize', () => this.updateBounds());
    this.window.on('maximize', () => this.updateBounds());
    this.window.on('unmaximize', () => this.updateBounds());
    this.window.on('restore', () => this.updateBounds());

    this.adapter = new GeminiAdapter(wc, this.logger);

    wc.loadURL(GEMINI_URL).catch((err) => {
      if (this.logger) this.logger.warn({ err: err.message }, 'initial Gemini load failed');
    });

    this.startLoginWatcher();
    return this.view;
  }

  handleWindowOpen({ url }) {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch (err) {
      return { action: 'deny' };
    }

    const host = parsed.hostname;
    const allowed = ALLOWED_POPUP_HOSTS.includes(host)
      || ALLOWED_POPUP_SUFFIXES.some((suffix) => host.endsWith(suffix));

    if (allowed) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 560,
          height: 760,
          autoHideMenuBar: true,
          title: 'Google sign-in',
          webPreferences: {
            partition: PARTITION,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true
          }
        }
      };
    }

    if (this.logger) this.logger.warn({ host }, 'blocked non-Google popup from Gemini');
    return { action: 'deny' };
  }

  updateBounds() {
    if (!this.view || this.destroyed) return;
    try {
      if (this.window.isDestroyed()) return;
      const [width, height] = this.window.getContentSize();
      const viewWidth = Math.max(320, width - SIDEBAR_WIDTH);
      this.view.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: viewWidth, height });
    } catch (err) {
      if (this.logger) this.logger.warn({ err: err.message }, 'could not update Gemini view bounds');
    }
  }

  startLoginWatcher() {
    if (this.loginTimer) return;
    this.loginTimer = setInterval(() => {
      this.refreshLoginState();
    }, LOGIN_POLL_MS);
    // Do not keep the process alive purely for the poll.
    if (this.loginTimer.unref) this.loginTimer.unref();
  }

  stopLoginWatcher() {
    if (this.loginTimer) {
      clearInterval(this.loginTimer);
      this.loginTimer = null;
    }
  }

  async refreshLoginState() {
    if (!this.adapter || this.destroyed) return this.lastLoginState;
    try {
      const state = await this.adapter.checkLoginStatus();
      if (state !== this.lastLoginState) {
        this.lastLoginState = state;
        this.send('event:login-state', state);
        if (this.logger) this.logger.info({ loginState: state }, 'Gemini login state changed');
      }
      return state;
    } catch (err) {
      if (this.logger) this.logger.debug({ err: err.message }, 'login poll failed');
      return this.lastLoginState;
    }
  }

  getLastLoginState() {
    return this.lastLoginState;
  }

  getWebContents() {
    if (!this.view || this.destroyed) return null;
    try {
      return this.view.webContents.isDestroyed() ? null : this.view.webContents;
    } catch (err) {
      return null;
    }
  }

  getAdapter() {
    return this.adapter;
  }

  reload() {
    const wc = this.getWebContents();
    if (!wc) throw new Error('Gemini view is not ready');
    wc.reload();
    return true;
  }

  goBack() {
    const wc = this.getWebContents();
    if (!wc) throw new Error('Gemini view is not ready');
    if (wc.navigationHistory && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else wc.goBack();
    return true;
  }

  goForward() {
    const wc = this.getWebContents();
    if (!wc) throw new Error('Gemini view is not ready');
    if (wc.navigationHistory && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else wc.goForward();
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.stopLoginWatcher();
    try {
      if (this.adapter) this.adapter.detach();
    } catch (err) { /* best effort */ }
    try {
      if (this.view && this.window && !this.window.isDestroyed()) {
        this.window.contentView.removeChildView(this.view);
      }
    } catch (err) { /* best effort */ }
    try {
      if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    } catch (err) { /* best effort */ }
    this.view = null;
    this.adapter = null;
  }
}

module.exports = { BrowserManager, PARTITION, SIDEBAR_WIDTH };
