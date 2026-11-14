'use strict';

/**
 * Error taxonomy (AGENT.md Section 11). Every thrown error carries a code so
 * the engine can decide whether to retry, pause the batch or stop it.
 */

const RETRY_LIMITS = {
  UPLOAD_TIMEOUT: 3,
  GENERATION_TIMEOUT: 2,
  GENERATION_ERROR: 1,
  DOWNLOAD_FAILED: 3,
  INVALID_IMAGE: 2,
  NETWORK_ERROR: 5,
  PROMPT_REJECTED: 1,
  PAGE_SCRIPT_ERROR: 1,
  UNKNOWN: 1,
  UPLOAD_FAILED: 3
};

class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'AppError';
    this.code = code || 'UNKNOWN';
    this.retryable = !!options.retryable;
    this.fatal = !!options.fatal;
    this.pause = !!options.pause;
    this.meta = options.meta || null;
  }
}

class RecoverableError extends AppError {
  constructor(code, message, options = {}) {
    super(code, message, { ...options, retryable: true });
    this.name = 'RecoverableError';
  }
}

class SelectorNotFoundError extends AppError {
  constructor(key, chain) {
    super('SELECTOR_NOT_FOUND',
      `Gemini layout changed: none of the configured selectors for "${key}" were found. Update config/selectors.json.`,
      { fatal: true });
    this.name = 'SelectorNotFoundError';
    this.key = key;
    this.chain = chain || [];
  }
}

class SkipSignal extends Error {
  constructor(message = 'Skipped by user') {
    super(message);
    this.name = 'SkipSignal';
    this.code = 'SKIPPED';
  }
}

class StopSignal extends Error {
  constructor(message = 'Stopped by user') {
    super(message);
    this.name = 'StopSignal';
    this.code = 'STOPPED';
  }
}

/**
 * Normalise any thrown value into the taxonomy used by the engine and UI.
 */
function classifyError(err) {
  if (!err) return { code: 'UNKNOWN', retryable: true, fatal: false, pause: false, message: 'Unknown error' };
  if (err.code === 'SKIPPED') return { code: 'SKIPPED', retryable: false, fatal: false, pause: false, message: err.message };
  if (err.code === 'STOPPED') return { code: 'STOPPED', retryable: false, fatal: false, pause: false, message: err.message };

  const known = {
    NEEDS_LOGIN: { retryable: false, fatal: false, pause: true },
    CAPTCHA: { retryable: false, fatal: false, pause: true },
    USAGE_LIMIT: { retryable: false, fatal: true, pause: false },
    SELECTOR_NOT_FOUND: { retryable: false, fatal: true, pause: false },
    DISK_FULL: { retryable: false, fatal: true, pause: false },
    UPLOAD_TIMEOUT: { retryable: true, fatal: false, pause: false },
    GENERATION_TIMEOUT: { retryable: true, fatal: false, pause: true },
    GENERATION_ERROR: { retryable: true, fatal: false, pause: false },
    DOWNLOAD_FAILED: { retryable: true, fatal: false, pause: false },
    INVALID_IMAGE: { retryable: true, fatal: false, pause: false },
    NETWORK_ERROR: { retryable: true, fatal: false, pause: false },
    PROMPT_REJECTED: { retryable: true, fatal: false, pause: false },
    PAGE_SCRIPT_ERROR: { retryable: true, fatal: false, pause: false },
    UNKNOWN: { retryable: true, fatal: false, pause: false }
  };

  const code = err.code && known[err.code] ? err.code : 'UNKNOWN';
  const base = known[code];
  return {
    code,
    message: err.message || String(err),
    retryable: err.retryable !== undefined ? !!err.retryable && base.retryable : base.retryable,
    fatal: err.fatal !== undefined ? !!err.fatal || base.fatal : base.fatal,
    pause: err.pause !== undefined ? !!err.pause || base.pause : base.pause
  };
}

module.exports = {
  RETRY_LIMITS,
  AppError,
  RecoverableError,
  SelectorNotFoundError,
  SkipSignal,
  StopSignal,
  classifyError
};
