'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { app } = require('electron');

const paths = require('../main/paths');

let logger = null;
let broadcaster = null;
let historyRepo = null;

function buildStreams(logsDir) {
  fs.mkdirSync(logsDir, { recursive: true });
  const streams = [{
    level: 'debug',
    stream: pino.destination({ dest: path.join(logsDir, 'app.log'), sync: false, mkdir: true })
  }];

  // Human friendly console output in development only.
  if (!app.isPackaged) {
    try {
      // eslint-disable-next-line global-require
      const pretty = require('pino-pretty');
      streams.push({
        level: 'debug',
        stream: pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' })
      });
    } catch (err) {
      // pino-pretty is optional at runtime; JSON to stdout is still structured.
      streams.push({ level: 'debug', stream: process.stdout });
    }
  }
  return streams;
}

function createLogger() {
  if (logger) return logger;
  logger = pino({
    level: 'debug',
    timestamp: pino.stdTimeFunctions.isoTime,
    // R14 / security: never persist credentials or auth headers.
    redact: {
      paths: ['cookie', 'cookies', 'authorization', 'password', 'token', 'req.headers.cookie', 'req.headers.authorization'],
      censor: '[REDACTED]'
    }
  }, pino.multistream(buildStreams(paths.logsDir)));
  return logger;
}

function getLogger() {
  return logger || createLogger();
}

/** Wire the renderer log stream (event:log). */
function setBroadcaster(fn) {
  broadcaster = typeof fn === 'function' ? fn : null;
}

function toPinoLevel(level) {
  const value = String(level || 'info').toLowerCase();
  if (['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(value)) return value;
  if (value === 'warning') return 'warn';
  return 'info';
}

/**
 * Structured log + persisted event + live UI event. Never pass headers or
 * cookies in `meta`.
 */
function logEvent(jobId, level, category, message, meta = null) {
  const log = getLogger();
  const pinoLevel = toPinoLevel(level);
  const fields = { category };
  if (jobId) fields.jobId = jobId;
  if (meta && typeof meta === 'object') {
    for (const [key, value] of Object.entries(meta)) {
      if (['cookie', 'cookies', 'authorization', 'password', 'token', 'headers'].includes(key.toLowerCase())) continue;
      fields[key] = value;
    }
  }
  log[pinoLevel](fields, message);

  const time = new Date().toISOString();
  try {
    if (!historyRepo) historyRepo = require('../database/repos/history.repo');
    historyRepo.logEvent(jobId, pinoLevel, category, message, meta);
  } catch (err) {
    log.warn({ err: err.message }, 'could not persist event to database');
  }

  if (broadcaster && pinoLevel !== 'debug' && pinoLevel !== 'trace') {
    try {
      broadcaster({ level: pinoLevel, message: String(message), time, category, jobId: jobId || null });
    } catch (err) { /* renderer may be gone */ }
  }
  return time;
}

module.exports = { createLogger, getLogger, setBroadcaster, logEvent };
