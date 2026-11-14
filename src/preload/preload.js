'use strict';

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
  retryJob:     (jobId) => invoke('job:retry', jobId),
  skipJob:      (jobId) => invoke('job:skip', jobId),

  // state
  getDashboard: () => invoke('state:dashboard'),
  getJobs:      (filter) => invoke('state:jobs', filter),
  getHistory:   (filter) => invoke('state:history', filter),
  getGallery:   () => invoke('state:gallery'),

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

  // files / exports
  revealJob:  (jobId) => invoke('file:reveal', jobId),
  exportZip:  (jobIds) => invoke('export:zip', jobIds),
  exportCsv:  (filter) => invoke('export:csv', filter),

  // events
  onJobUpdate:  (cb) => subscribe('event:job-update', cb),
  onLog:        (cb) => subscribe('event:log', cb),
  onNotice:     (cb) => subscribe('event:notice', cb),
  onLoginState: (cb) => subscribe('event:login-state', cb),
  onBatchState: (cb) => subscribe('event:batch-state', cb)
});
