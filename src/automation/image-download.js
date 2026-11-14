'use strict';

/**
 * Image download entry point. The implementation is shared with
 * src/main/download-manager.js so there is exactly one download code path
 * (blob:, https: and data: URLs).
 */
const { DownloadManager } = require('../main/download-manager');

module.exports = { DownloadManager };
