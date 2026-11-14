import { esc, fmtDate, fmtDuration, badgeHtml, toast, debounce } from '../util.js';

const LEVELS = new Set(['error', 'warning', 'info', 'success']);

function normalizeLevel(level) {
  const key = String(level || '').toLowerCase();
  return LEVELS.has(key) ? key : 'info';
}

function errorKey(err) {
  if (!err) return '';
  return `${err.code || ''}|${err.message || ''}`;
}

function makeBanner(level, text, onDismiss) {
  const node = document.createElement('div');
  node.className = `banner ${normalizeLevel(level)}`;
  const message = document.createElement('span');
  message.className = 'small';
  message.style.flex = '1';
  message.textContent = String(text || '');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn';
  close.textContent = '✕';
  close.title = 'Dismiss';
  close.addEventListener('click', onDismiss);
  node.appendChild(message);
  node.appendChild(close);
  return node;
}

export default async function render(host) {
  if (!window.api) {
    host.innerHTML = '<div class="banner error">Application API is unavailable. Restart the app.</div>';
    return undefined;
  }

  host.innerHTML = `
    <div data-dashboard>
      <div data-notice-host></div>
      <div data-finished-host></div>

      <div class="stat-grid">
        <div class="stat-card accent">
          <div class="stat-label">Total</div>
          <div class="stat-value" data-stat="total">0</div>
        </div>
        <div class="stat-card success">
          <div class="stat-label">Completed</div>
          <div class="stat-value" data-stat="completed">0</div>
        </div>
        <div class="stat-card accent">
          <div class="stat-label">Processing</div>
          <div class="stat-value" data-stat="processing">0</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-label">Pending</div>
          <div class="stat-value" data-stat="pending">0</div>
        </div>
        <div class="stat-card danger">
          <div class="stat-label">Failed</div>
          <div class="stat-value" data-stat="failed">0</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Batch Progress</h2>
          <span data-batch-badge hidden></span>
        </div>
        <div class="card-sub" style="margin:0 0 10px">Active prompt: <span data-active-prompt>—</span></div>
        <div class="progress"><div class="progress-fill" data-progress-fill></div></div>
        <div class="progress-meta">
          <span data-progress-count>0 / 0</span>
          <span data-progress-eta>ETA —</span>
        </div>
        <div class="kv" data-batch-kv style="margin-top:10px">
          <span class="k">Input</span><span class="v mono" data-batch-input>—</span>
          <span class="k">Output</span><span class="v mono" data-batch-output>—</span>
          <span class="k">Started</span><span class="v" data-batch-started>—</span>
          <span class="k">Finished</span><span class="v" data-batch-finished>—</span>
        </div>
        <div class="empty" data-batch-empty hidden>No batch yet — choose folders, then press START.</div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Current Job</h2>
          <span data-current-badge hidden></span>
        </div>
        <div class="row" data-current-row hidden style="display:none;gap:10px">
          <span class="small mono" data-current-name
                style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</span>
          <span class="small muted" style="white-space:nowrap">Elapsed <span data-current-elapsed>—</span></span>
        </div>
        <div class="small muted" data-current-empty>No job is currently processing.</div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Batch Control</h2>
        </div>
        <div class="row">
          <button type="button" class="primary" data-action="start">START</button>
          <button type="button" class="warning" data-action="pause">PAUSE</button>
          <button type="button" class="primary" data-action="resume">RESUME</button>
          <button type="button" class="danger" data-action="stop">STOP</button>
          <button type="button" class="ghost" data-action="skip">SKIP</button>
          <button type="button" class="ghost" data-action="retry-failed">RETRY FAILED</button>
        </div>
      </div>
    </div>
  `;

  const page = host.querySelector('[data-dashboard]');
  if (!page) return undefined;
  const q = (selector) => page.querySelector(selector);

  const statEls = {
    total: q('[data-stat="total"]'),
    completed: q('[data-stat="completed"]'),
    processing: q('[data-stat="processing"]'),
    pending: q('[data-stat="pending"]'),
    failed: q('[data-stat="failed"]')
  };
  const noticeHost = q('[data-notice-host]');
  const finishedHost = q('[data-finished-host]');
  const batchBadge = q('[data-batch-badge]');
  const progressFill = q('[data-progress-fill]');
  const progressCount = q('[data-progress-count]');
  const progressEta = q('[data-progress-eta]');
  const activePromptEl = q('[data-active-prompt]');
  const batchKv = q('[data-batch-kv]');
  const batchEmpty = q('[data-batch-empty]');
  const batchInput = q('[data-batch-input]');
  const batchOutput = q('[data-batch-output]');
  const batchStarted = q('[data-batch-started]');
  const batchFinished = q('[data-batch-finished]');
  const currentRow = q('[data-current-row]');
  const currentName = q('[data-current-name]');
  const currentElapsed = q('[data-current-elapsed]');
  const currentBadge = q('[data-current-badge]');
  const currentEmpty = q('[data-current-empty]');
  const startBtn = q('[data-action="start"]');
  const pauseBtn = q('[data-action="pause"]');
  const resumeBtn = q('[data-action="resume"]');
  const stopBtn = q('[data-action="stop"]');
  const skipBtn = q('[data-action="skip"]');
  const retryBtn = q('[data-action="retry-failed"]');

  let disposed = false;
  let pollTimer = null;
  let tickTimer = null;
  let noticeState = null;
  let lastError = null;
  let dismissedErrorKey = '';
  let renderedNoticeSignature = '';
  let currentStartedAt = null;
  let lastRunning = false;
  let lastBatchBadgeStatus = '';
  let lastFinishedText = '';
  let pollErrorShown = false;

  const setText = (node, text) => {
    if (!node) return;
    const value = String(text == null ? '' : text);
    if (node.textContent !== value) node.textContent = value;
  };
  const setHtml = (node, html) => {
    if (!node) return;
    if (node.innerHTML !== html) node.innerHTML = html;
  };
  // `hidden` alone does not win against styles.css display rules (e.g. .row/.kv),
  // so toggle an inline display value as well and restore the stylesheet value.
  const setHidden = (node, hidden) => {
    if (!node) return;
    node.hidden = !!hidden;
    node.style.display = hidden ? 'none' : '';
  };

  function renderNotices(force) {
    if (!noticeHost) return;
    const parts = [];
    if (noticeState && noticeState.message) {
      parts.push(`n|${noticeState.level}|${noticeState.message}`);
    }
    if (lastError && errorKey(lastError) !== dismissedErrorKey) {
      parts.push(`e|${errorKey(lastError)}|${lastError.code || ''}|${lastError.message || ''}`);
    }
    const signature = parts.join('||');
    if (!force && signature === renderedNoticeSignature) return;
    renderedNoticeSignature = signature;
    noticeHost.innerHTML = '';

    if (noticeState && noticeState.message) {
      noticeHost.appendChild(makeBanner(noticeState.level, noticeState.message, () => {
        noticeState = null;
        renderNotices(true);
      }));
    }
    if (lastError && errorKey(lastError) !== dismissedErrorKey) {
      const key = errorKey(lastError);
      const text = [lastError.code, lastError.message].filter(Boolean).join(': ') || 'Unknown error';
      noticeHost.appendChild(makeBanner('error', text, () => {
        dismissedErrorKey = key;
        renderNotices(true);
      }));
    }
  }

  function renderFinished(counts, running, total) {
    if (!finishedHost) return;
    const pending = counts ? Number(counts.pending) || 0 : 0;
    const show = !running && total > 0 && pending === 0;
    if (!show) {
      if (finishedHost.childElementCount > 0) finishedHost.innerHTML = '';
      lastFinishedText = '';
      return;
    }
    const completed = counts ? Number(counts.completed) || 0 : 0;
    const failed = counts ? Number(counts.failed) || 0 : 0;
    const skipped = counts ? Number(counts.skipped) || 0 : 0;
    let text = `Batch finished — ${completed} completed, ${failed} failed`;
    if (skipped > 0) text += `, ${skipped} skipped`;
    text += '.';
    if (text === lastFinishedText) return;
    lastFinishedText = text;
    finishedHost.innerHTML = '';
    const node = document.createElement('div');
    node.className = 'banner success';
    node.textContent = text;
    finishedHost.appendChild(node);
  }

  function tickElapsed() {
    if (disposed || !currentElapsed) return;
    if (!currentStartedAt) {
      setText(currentElapsed, '—');
      return;
    }
    const started = new Date(currentStartedAt).getTime();
    if (Number.isNaN(started)) {
      setText(currentElapsed, '—');
      return;
    }
    setText(currentElapsed, fmtDuration(Math.max(0, Date.now() - started)));
  }

  function applyDashboard(data) {
    if (!data || data.ok === false) return;
    const batch = data.batch || null;
    const counts = data.counts || (batch ? {
      total: batch.total,
      completed: batch.completed,
      failed: batch.failed,
      skipped: batch.skipped,
      pending: batch.pending,
      processing: batch.processing
    } : null);

    const total = counts ? Number(counts.total) || 0 : 0;
    const completed = counts ? Number(counts.completed) || 0 : 0;
    const processing = counts ? Number(counts.processing) || 0 : 0;
    const pending = counts ? Number(counts.pending) || 0 : 0;
    const failed = counts ? Number(counts.failed) || 0 : 0;

    setText(statEls.total, total);
    setText(statEls.completed, completed);
    setText(statEls.processing, processing);
    setText(statEls.pending, pending);
    setText(statEls.failed, failed);

    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : 0;
    if (progressFill) progressFill.style.width = `${pct}%`;
    setText(progressCount, `${completed}/${total}`);

    const hasEta = data.etaSeconds != null && !Number.isNaN(Number(data.etaSeconds));
    setText(progressEta, `ETA ${hasEta ? fmtDuration(Number(data.etaSeconds) * 1000) : '—'}`);

    const batchStatus = batch && batch.status ? String(batch.status) : '';
    if (batchBadge) {
      setHidden(batchBadge, !batchStatus);
      if (lastBatchBadgeStatus !== batchStatus) {
        lastBatchBadgeStatus = batchStatus;
        batchBadge.innerHTML = batchStatus ? badgeHtml(batchStatus) : '';
      }
    }

    setHtml(activePromptEl, esc(data.activePromptName || '—'));

    setHidden(batchKv, !batch);
    setHidden(batchEmpty, !!batch);
    if (batch) {
      const inputFolder = batch.inputFolder || '—';
      const outputFolder = batch.outputFolder || '—';
      setHtml(batchInput, esc(inputFolder));
      if (batchInput) batchInput.title = inputFolder;
      setHtml(batchOutput, esc(outputFolder));
      if (batchOutput) batchOutput.title = outputFolder;
      setText(batchStarted, batch.startedAt ? fmtDate(batch.startedAt) : '—');
      setText(batchFinished, batch.finishedAt ? fmtDate(batch.finishedAt) : '—');
    } else {
      setText(batchStarted, '—');
      setText(batchFinished, '—');
    }

    const current = data.current || null;
    if (current && (current.jobId != null || current.name)) {
      setHidden(currentRow, false);
      setHidden(currentEmpty, true);
      setText(currentName, current.name || '(unnamed)');
      if (currentName) currentName.title = current.name || '';
      const currentStatus = String(current.status || 'PENDING');
      if (currentBadge) {
        setHidden(currentBadge, false);
        if (currentBadge.dataset.status !== currentStatus) {
          currentBadge.dataset.status = currentStatus;
          currentBadge.innerHTML = badgeHtml(currentStatus);
        }
      }
      currentStartedAt = current.startedAt || null;
    } else {
      setHidden(currentRow, true);
      setHidden(currentEmpty, false);
      if (currentBadge) {
        setHidden(currentBadge, true);
        currentBadge.innerHTML = '';
        delete currentBadge.dataset.status;
      }
      currentStartedAt = null;
      setText(currentElapsed, '—');
    }
    tickElapsed();

    lastRunning = !!data.running;
    const paused = !!data.paused;
    if (startBtn) startBtn.disabled = lastRunning;
    if (pauseBtn) pauseBtn.disabled = !(lastRunning && !paused);
    if (resumeBtn) resumeBtn.disabled = !paused;
    if (stopBtn) stopBtn.disabled = !(lastRunning || paused);
    if (skipBtn) skipBtn.disabled = !lastRunning;
    if (retryBtn) retryBtn.disabled = false;

    const nextError = data.lastError || null;
    if (errorKey(nextError) !== errorKey(lastError)) lastError = nextError;

    renderNotices(false);
    renderFinished(counts, lastRunning, total);
  }

  async function refresh() {
    if (disposed) return;
    try {
      const data = await window.api.getDashboard();
      if (disposed) return;
      if (!data || data.ok === false) {
        if (!pollErrorShown) {
          pollErrorShown = true;
          toast((data && data.error) || 'Could not load dashboard state.', 'error');
        }
        return;
      }
      pollErrorShown = false;
      applyDashboard(data);
    } catch (err) {
      if (!pollErrorShown && !disposed) {
        pollErrorShown = true;
        toast(err && err.message ? err.message : 'Dashboard refresh failed.', 'error');
      }
    }
  }

  function showValidationWarning(problems) {
    noticeState = { level: 'warning', message: `Cannot start: ${problems.join(' ')}` };
    renderNotices(true);
    toast('Fix the highlighted requirements before starting.', 'warning');
  }

  async function onStart() {
    if (startBtn.disabled) return;
    startBtn.disabled = true;

    // Clear the sticky notice banner when a new start attempt begins.
    noticeState = null;
    dismissedErrorKey = errorKey(lastError);
    renderNotices(true);

    try {
      let settings;
      try {
        settings = await window.api.getSettings();
      } catch (err) {
        toast(err && err.message ? err.message : 'Could not load settings.', 'error');
        return;
      }
      if (settings && settings.ok === false) {
        toast(settings.error || 'Could not load settings.', 'error');
        return;
      }
      settings = settings || {};

      const problems = [];
      if (!settings.inputFolder) problems.push('No input folder selected — choose one on the Folders page.');
      if (!settings.outputFolder) problems.push('No output folder selected — choose one on the Folders page.');

      let prompts;
      try {
        prompts = await window.api.listPrompts();
      } catch (err) {
        toast(err && err.message ? err.message : 'Could not load prompts.', 'error');
        return;
      }
      if (!Array.isArray(prompts)) {
        toast((prompts && prompts.error) || 'Could not load prompts.', 'error');
        return;
      }
      const defaultPrompt = prompts.find((p) => p && p.is_default) || null;
      if (!defaultPrompt) {
        problems.push('No default prompt set — create one and set it as default on the Prompts page.');
      }

      if (problems.length > 0) {
        showValidationWarning(problems);
        return;
      }

      if (settings.confirmBeforeBatch && !window.confirm('Start processing all images in the input folder?')) {
        return;
      }

      const result = await window.api.startBatch({
        inputFolder: settings.inputFolder,
        outputFolder: settings.outputFolder,
        promptId: defaultPrompt.id
      });
      if (!result || result.ok === false) {
        toast((result && result.error) || 'Failed to start batch.', 'error');
      } else {
        const queued = result.total != null ? Number(result.total) || 0 : 0;
        toast(`Batch started — ${queued} image${queued === 1 ? '' : 's'} queued.`, 'success');
      }
    } catch (err) {
      toast(err && err.message ? err.message : 'Failed to start batch.', 'error');
    } finally {
      await refresh();
      if (startBtn) startBtn.disabled = lastRunning;
    }
  }

  async function runBatchAction(action, successMessage) {
    try {
      const result = await action();
      if (!result || result.ok === false) {
        toast((result && result.error) || 'Action failed.', 'error');
      } else {
        toast(successMessage, 'success');
      }
    } catch (err) {
      toast(err && err.message ? err.message : 'Action failed.', 'error');
    }
    await refresh();
  }

  startBtn.addEventListener('click', onStart);
  pauseBtn.addEventListener('click', () => runBatchAction(() => window.api.pauseBatch(), 'Batch paused.'));
  resumeBtn.addEventListener('click', () => runBatchAction(() => window.api.resumeBatch(), 'Batch resumed.'));
  stopBtn.addEventListener('click', () => runBatchAction(() => window.api.stopBatch(), 'Batch stop requested.'));
  skipBtn.addEventListener('click', () => runBatchAction(() => window.api.skipCurrent(), 'Current job skipped.'));
  retryBtn.addEventListener('click', () => runBatchAction(() => window.api.retryFailed(), 'Retrying failed jobs.'));

  const refreshSoon = debounce(() => { refresh(); }, 400);

  function onJobUpdate() {
    refreshSoon();
  }
  function onBatchState() {
    refresh();
  }
  function onNotice(event) {
    const detail = (event && event.detail) || {};
    const level = normalizeLevel(detail.level);
    const text = [detail.code, detail.message].filter(Boolean).join(': ') || 'Notice';
    noticeState = { level, message: text, sticky: !!detail.sticky };
    renderNotices(true);
  }

  window.addEventListener('job-update', onJobUpdate);
  window.addEventListener('batch-state', onBatchState);
  window.addEventListener('notice', onNotice);

  await refresh();
  if (disposed) return undefined;

  pollTimer = window.setInterval(() => { refresh(); }, 2500);
  tickTimer = window.setInterval(() => { tickElapsed(); }, 1000);

  return function cleanup() {
    disposed = true;
    if (pollTimer) window.clearInterval(pollTimer);
    if (tickTimer) window.clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
    window.removeEventListener('job-update', onJobUpdate);
    window.removeEventListener('batch-state', onBatchState);
    window.removeEventListener('notice', onNotice);
  };
}
