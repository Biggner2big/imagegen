'use strict';

const path = require('path');
const { app } = require('electron');

/**
 * Central filesystem locations. Everything lives under the per-user
 * application data folder, never inside the install directory.
 * Getters are used because app.getPath() is only meaningful once Electron
 * has initialised its user-data path.
 */
module.exports = {
  get userDataDir() { return app.getPath('userData'); },
  get dataDir() { return path.join(app.getPath('userData'), 'data'); },
  get logsDir() { return path.join(app.getPath('userData'), 'data', 'logs'); },
  get thumbsDir() { return path.join(app.getPath('userData'), 'data', 'thumbs'); },
  get dbPath() { return path.join(app.getPath('userData'), 'data', 'application.db'); },
  get settingsDir() { return path.join(app.getPath('userData'), 'data'); },
  get browserProfileDir() { return path.join(app.getPath('userData'), 'Partitions', 'gemini-session'); },
  get appConfigPath() { return path.join(__dirname, '..', '..', 'config', 'app.config.json'); },
  get selectorsPath() { return path.join(__dirname, '..', '..', 'config', 'selectors.json'); },
  get rendererDir() { return path.join(__dirname, '..', 'renderer'); }
};
