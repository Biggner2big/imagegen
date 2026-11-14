/**
 * Settings page — processing options, Gemini browser controls and read-only folders.
 * All values are validated in the renderer before `window.api.setSettings` is called.
 */
import { esc, toast } from '../util.js';

const NUMBER_FIELDS = [
  { key: 'maxRetries', label: 'Max retries', min: 0, max: 10, step: 1, unit: '' },
  { key: 'generationTimeoutMs', label: 'Generation timeout', min: 30000, max: 600000, step: 1000, unit: 'ms' },
  { key: 'downloadTimeoutMs', label: 'Download timeout', min: 5000, max: 300000, step: 1000, unit: 'ms' },
  { key: 'uploadTimeoutMs', label: 'Upload timeout', min: 5000, max: 300000, step: 1000, unit: 'ms' },
  { key: 'timeBetweenJobsMs', label: 'Time between jobs', min: 0, max: 60000, step: 100, unit: 'ms' }
];

const CHECKBOX_FIELDS = [
  { key: 'includeSubfolders', label: 'Include subfolders when scanning' },
  { key: 'autoQueueNewImages', label: 'Auto-queue newly added images' },
  { key: 'confirmBeforeBatch', label: 'Confirm before starting a batch' },
  { key: 'pauseAfterError', label: 'Pause the batch after an error' },
  { key: 'startWithWindows', label: 'Start with Windows (not applied)' }
];

const BROWSER_ACTIONS = { reload: 'browserReload', back: 'browserBack', forward: 'browserForward' };

function errText(err, fallback) {
  if (err && err.message) return String(err.message);
  if (typeof err === 'string' && err) return err;
  return fallback;
}

function settingsOf(res) {
  if (res && typeof res.settings === 'object' && res.settings && !Array.isArray(res.settings)) return res.settings;
  if (res && typeof res === 'object' && !Array.isArray(res)) return res;
  return {};
}

function numberFieldHtml(field, settings) {
  const raw = settings ? settings[field.key] : undefined;
  const value = raw != null && Number.isFinite(Number(raw)) ? String(Number(raw)) : '';
  const range = `${field.min}–${field.max}${field.unit ? ` ${field.unit}` : ''}`;
  return `<div class="field">
      <label for="set-${field.key}">${esc(field.label)} <span class="muted">(${esc(range)})</span></label>
      <input class="input" id="set-${field.key}" type="number" inputmode="numeric"
             min="${field.min}" max="${field.max}" step="${field.step}"
             data-number-key="${field.key}" value="${esc(value)}" />
    </div>`;
}

function checkboxFieldHtml(field, settings) {
  const checked = !!(settings && settings[field.key]);
  return `<label class="checkbox-row">
      <input type="checkbox" data-bool-key="${field.key}"${checked ? ' checked' : ''} />
      <span>${esc(field.label)}</span>
    </label>`;
}

function fieldsHtml(settings) {
  const numbers = NUMBER_FIELDS.map((field) => numberFieldHtml(field, settings)).join('');
  const checkboxes = CHECKBOX_FIELDS.map((field) => checkboxFieldHtml(field, settings)).join('');
  const formatValue =
    settings && settings.outputFilenameFormat != null ? String(settings.outputFilenameFormat) : '';

  return `${numbers}
    <div class="field">
      <label for="set-duplicateHandling">Duplicate handling</label>
      <select class="input" id="set-duplicateHandling" data-select-key="duplicateHandling">
        <option value="rename">Rename (append a suffix)</option>
      </select>
    </div>
    <div class="field">
      <label for="set-outputFilenameFormat">Output filename format</label>
      <input class="input mono" id="set-outputFilenameFormat" type="text" spellcheck="false"
             data-text-key="outputFilenameFormat" value="${esc(formatValue)}" />
      <div class="muted small">Must contain <span class="mono">{base}</span> — the source file name.
        <span class="mono">{ext}</span> becomes “.png”.</div>
    </div>
    ${checkboxes}
    <div class="muted small">Windows autostart is not configured by this build; the start-with-Windows flag is stored but not applied.</div>`;
}

export default async function render(host) {
  let disposed = false;
  let current = {};
  let loaded = false;
  let saving = false;

  host.innerHTML = `
    <form data-form novalidate>
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Processing</h2>
          <div class="row">
            <button type="button" class="ghost sm" data-reset disabled>Reset</button>
            <button type="submit" class="primary sm" data-save disabled>Save</button>
          </div>
        </div>
        <div data-fields><div class="muted small">Loading settings…</div></div>
      </div>
    </form>

    <div class="card" data-browser-card>
      <div class="card-header">
        <h2 class="card-title">Gemini Browser</h2>
        <span data-login><span class="badge badge-pending">Unknown</span></span>
      </div>
      <div class="row">
        <button type="button" class="ghost sm" data-browser="reload">Reload</button>
        <button type="button" class="ghost sm" data-browser="back">Back</button>
        <button type="button" class="ghost sm" data-browser="forward">Forward</button>
      </div>
      <p class="card-sub">Sign in is manual: use the Gemini panel on the right. The password is never
        stored or typed into this app.</p>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Folders (read-only)</h2>
      </div>
      <div class="kv">
        <div class="k">Input</div>
        <div class="v mono small" data-folder="input">—</div>
        <div class="k">Output</div>
        <div class="v mono small" data-folder="output">—</div>
      </div>
      <p class="card-sub">Change these folders on the Folders page.</p>
    </div>`;

  const formEl = host.querySelector('[data-form]');
  const fieldsEl = host.querySelector('[data-fields]');
  const saveBtn = host.querySelector('[data-save]');
  const resetBtn = host.querySelector('[data-reset]');
  const loginEl = host.querySelector('[data-login]');
  const browserCard = host.querySelector('[data-browser-card]');
  const inputFolderEl = host.querySelector('[data-folder="input"]');
  const outputFolderEl = host.querySelector('[data-folder="output"]');

  // ---- rendering -----------------------------------------------------------

  function updateFolders() {
    const inputFolder = current.inputFolder == null ? '' : String(current.inputFolder);
    const outputFolder = current.outputFolder == null ? '' : String(current.outputFolder);
    if (inputFolderEl) {
      inputFolderEl.textContent = inputFolder || 'Not set';
      inputFolderEl.title = inputFolder || 'Not set';
    }
    if (outputFolderEl) {
      outputFolderEl.textContent = outputFolder || 'Not set';
      outputFolderEl.title = outputFolder || 'Not set';
    }
  }

  function renderLogin(state) {
    if (!loginEl) return;
    const key = String(state || 'unknown');
    let badgeClass = 'badge-pending';
    let text = 'Unknown';
    if (key === 'logged_in') {
      badgeClass = 'badge-completed';
      text = 'Logged in';
    } else if (key === 'needs_login') {
      badgeClass = 'badge-warning';
      text = 'Sign in required';
    }
    loginEl.innerHTML = `<span class="badge ${badgeClass}">${esc(text)}</span>`;
  }

  function onLoginState(event) {
    if (disposed) return;
    renderLogin(event && event.detail);
  }

  // ---- validation / collection ---------------------------------------------

  function collect() {
    const values = {};

    for (const field of NUMBER_FIELDS) {
      const input = formEl.querySelector(`[data-number-key="${field.key}"]`);
      if (!input) continue;
      const raw = String(input.value || '').trim();
      const num = Number(raw);
      if (raw === '' || !Number.isFinite(num)) {
        return { error: `${field.label} must be a number between ${field.min} and ${field.max}.`, focus: input };
      }
      if (num < field.min || num > field.max) {
        return { error: `${field.label} must be between ${field.min} and ${field.max}.`, focus: input };
      }
      values[field.key] = Math.round(num);
    }

    for (const field of CHECKBOX_FIELDS) {
      const checkbox = formEl.querySelector(`[data-bool-key="${field.key}"]`);
      values[field.key] = !!(checkbox && checkbox.checked);
    }

    // Only "rename" is supported by this build, so the value is fixed.
    values.duplicateHandling = 'rename';

    const formatInput = formEl.querySelector('[data-text-key="outputFilenameFormat"]');
    const format = formatInput ? String(formatInput.value || '').trim() : '';
    if (!format) {
      return { error: 'Output filename format is required.', focus: formatInput };
    }
    if (!format.includes('{base}')) {
      return { error: 'Output filename format must contain {base}.', focus: formatInput };
    }
    values.outputFilenameFormat = format;

    return { values };
  }

  // ---- data ----------------------------------------------------------------

  async function loadSettings() {
    try {
      const res = await window.api.getSettings();
      if (disposed) return;
      if (res && res.ok === false) {
        fieldsEl.innerHTML = `<div class="banner error">${esc(res.error || 'Could not load settings')}</div>`;
        return;
      }
      current = settingsOf(res);
      fieldsEl.innerHTML = fieldsHtml(current);
      updateFolders();
      loaded = true;
      saveBtn.disabled = false;
      resetBtn.disabled = false;
    } catch (err) {
      if (disposed) return;
      const message = errText(err, 'Could not load settings');
      fieldsEl.innerHTML = `<div class="banner error">${esc(message)}</div>`;
      toast(message, 'error');
    }
  }

  async function save() {
    if (!loaded || saving || disposed) return;
    const result = collect();
    if (result.error) {
      toast(result.error, 'error');
      if (result.focus && typeof result.focus.focus === 'function') result.focus.focus();
      return;
    }

    saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const payload = { ...current, ...result.values };
      const res = await window.api.setSettings(payload);
      if (disposed) return;
      if (res && res.ok === false) {
        toast(res.error || 'Could not save settings', 'error');
        return;
      }
      const answered =
        res && typeof res.settings === 'object' && res.settings && !Array.isArray(res.settings)
          ? res.settings
          : null;
      const nextSettings = { ...payload, ...(answered || {}) };
      current = nextSettings;
      fieldsEl.innerHTML = fieldsHtml(nextSettings);
      updateFolders();
      toast('Settings saved', 'success');
    } catch (err) {
      if (!disposed) toast(errText(err, 'Could not save settings'), 'error');
    } finally {
      saving = false;
      if (!disposed) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    }
  }

  async function reset() {
    if (disposed) return;
    resetBtn.disabled = true;
    try {
      const res = await window.api.getSettings();
      if (disposed) return;
      if (res && res.ok === false) {
        toast(res.error || 'Could not reload settings', 'error');
        return;
      }
      current = settingsOf(res);
      fieldsEl.innerHTML = fieldsHtml(current);
      updateFolders();
      loaded = true;
      saveBtn.disabled = false;
      toast('Settings reloaded', 'info');
    } catch (err) {
      if (!disposed) toast(errText(err, 'Could not reload settings'), 'error');
    } finally {
      if (!disposed) resetBtn.disabled = false;
    }
  }

  async function loadLogin() {
    try {
      const state = await window.api.getLoginStatus();
      if (disposed) return;
      if (typeof state === 'string') {
        renderLogin(state);
      } else if (state && typeof state.status === 'string') {
        renderLogin(state.status);
      } else {
        renderLogin('unknown');
      }
    } catch (err) {
      if (!disposed) renderLogin('unknown');
    }
  }

  // ---- handlers ------------------------------------------------------------

  async function onBrowserClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest('[data-browser]');
    if (!button) return;
    const method = BROWSER_ACTIONS[button.dataset.browser];
    if (!method || !window.api || typeof window.api[method] !== 'function') {
      toast('Browser controls are unavailable', 'error');
      return;
    }
    button.disabled = true;
    try {
      const res = await window.api[method]();
      if (res && res.ok === false) toast(res.error || 'Browser action failed', 'error');
    } catch (err) {
      toast(errText(err, 'Browser action failed'), 'error');
    } finally {
      if (!disposed) button.disabled = false;
    }
  }

  // ---- wiring --------------------------------------------------------------

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  resetBtn.addEventListener('click', reset);
  browserCard.addEventListener('click', onBrowserClick);
  window.addEventListener('login-state', onLoginState);

  await loadSettings();
  await loadLogin();

  return () => {
    disposed = true;
    window.removeEventListener('login-state', onLoginState);
  };
}
