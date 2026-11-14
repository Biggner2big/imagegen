'use strict';

const fs = require('fs');
const Store = require('electron-store');
const paths = require('../main/paths');

const defaults = require('../../config/app.config.json');

const NUMBER_RULES = {
  maxRetries: { min: 0, max: 10, integer: true },
  generationTimeoutMs: { min: 10000, max: 900000 },
  downloadTimeoutMs: { min: 5000, max: 300000 },
  uploadTimeoutMs: { min: 5000, max: 300000 },
  timeBetweenJobsMs: { min: 0, max: 120000 },
  settleTimeoutMs: { min: 1000, max: 60000 }
};

const BOOLEAN_KEYS = ['includeSubfolders', 'autoQueueNewImages', 'startWithWindows', 'confirmBeforeBatch', 'pauseAfterError', 'newChatPerJob'];

let store = null;

function getStore() {
  if (store) return store;
  fs.mkdirSync(paths.settingsDir, { recursive: true });
  store = new Store({
    name: 'settings',
    cwd: paths.settingsDir,
    defaults,
    clearInvalidConfig: true
  });
  return store;
}

function getSettings() {
  const stored = getStore().store || {};
  return { ...defaults, ...stored };
}

function clampNumber(key, value) {
  const rule = NUMBER_RULES[key];
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`Setting "${key}" must be a number`);
  const clamped = Math.min(rule.max, Math.max(rule.min, num));
  return rule.integer ? Math.round(clamped) : Math.round(clamped);
}

function setSettings(partial) {
  if (!partial || typeof partial !== 'object') throw new Error('Invalid settings payload');
  const next = {};

  for (const [key, raw] of Object.entries(partial)) {
    if (key === 'inputFolder' || key === 'outputFolder' || key === 'promptId') continue;
    if (NUMBER_RULES[key]) {
      next[key] = clampNumber(key, raw);
      continue;
    }
    if (BOOLEAN_KEYS.includes(key)) {
      next[key] = !!raw;
      continue;
    }
    if (key === 'outputFilenameFormat') {
      const format = String(raw || '').trim();
      if (!format.includes('{base}')) throw new Error('Output filename format must contain {base}');
      if (format.length > 120) throw new Error('Output filename format is too long');
      next[key] = format;
      continue;
    }
    if (key === 'duplicateHandling') {
      // R8: completed outputs are never overwritten, so "rename" is the only
      // strategy this build supports.
      next[key] = 'rename';
      continue;
    }
    if (key === 'theme') {
      next[key] = 'dark';
      continue;
    }
  }

  if (Object.keys(next).length === 0) throw new Error('No valid settings provided');
  getStore().set(next);
  return getSettings();
}

function setSelection({ inputFolder, outputFolder }) {
  const next = {};
  if (typeof inputFolder === 'string' && inputFolder.trim()) next.inputFolder = inputFolder.trim();
  if (typeof outputFolder === 'string' && outputFolder.trim()) next.outputFolder = outputFolder.trim();
  if (Object.keys(next).length) getStore().set(next);
  return getSettings();
}

function getPublicSettings() {
  const settings = getSettings();
  return {
    ...settings,
    inputFolder: settings.inputFolder || null,
    outputFolder: settings.outputFolder || null
  };
}

module.exports = { getSettings, getPublicSettings, setSettings, setSelection };
