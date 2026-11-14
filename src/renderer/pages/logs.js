/**
 * Logs page — live log stream plus selector diagnostics against the Gemini page.
 * Lines are appended newest-last and capped at 500; auto-scroll follows the tail
 * unless the user has scrolled up.
 */
import { esc, toast } from '../util.js';

const MAX_LINES = 500;
const AUTO_SCROLL_SLACK = 24;

function errText(err, fallback) {
  if (err && err.message) return String(err.message);
  if (typeof err === 'string' && err) return err;
  return fallback;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function fmtTime(iso) {
  const date = iso ? new Date(iso) : new Date();
  const valid = !Number.isNaN(date.getTime());
  const d = valid ? date : new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function levelKey(level) {
  const clean = String(level || 'info').toLowerCase().replace(/[^a-z]/g, '');
  return clean || 'info';
}

function pageLabel() {
  const name = window.__gbs && window.__gbs.currentPage;
  if (!name) return '—';
  const text = String(name);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export default async function render(host) {
  let disposed = false;
  let atBottom = true;
  let placeholderEl = null;
  let unsubscribe = null;

  host.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Logs</h2>
        <div class="row">
          <button type="button" class="ghost sm" data-clear>Clear</button>
          <button type="button" class="primary sm" data-diag>Diagnostics</button>
        </div>
      </div>
      <div class="kv" style="margin-bottom:10px">
        <div class="k">Login</div>
        <div class="v" data-login>Unknown</div>
        <div class="k">Page</div>
        <div class="v" data-page>—</div>
      </div>
      <div class="row" style="margin-bottom:8px">
        <label class="checkbox-row" style="margin:0">
          <input type="checkbox" data-autoscroll checked />
          <span>Auto-scroll</span>
        </label>
        <span class="spacer"></span>
        <span class="muted small" data-line-count>0 lines</span>
      </div>
      <div class="log-stream" data-stream></div>
    </div>

    <div class="card" data-diag-card>
      <div class="card-header">
        <h2 class="card-title">Selector diagnostics</h2>
        <span class="pill" data-diag-pill>Not run</span>
      </div>
      <div data-diag-body>
        <div class="muted small">Run diagnostics to verify the configured Gemini selectors against the live page.</div>
      </div>
    </div>`;

  const streamEl = host.querySelector('[data-stream]');
  const loginEl = host.querySelector('[data-login]');
  const pageEl = host.querySelector('[data-page]');
  const lineCountEl = host.querySelector('[data-line-count]');
  const autoScrollEl = host.querySelector('[data-autoscroll]');
  const clearBtn = host.querySelector('[data-clear]');
  const diagBtn = host.querySelector('[data-diag]');
  const diagBodyEl = host.querySelector('[data-diag-body]');
  const diagPillEl = host.querySelector('[data-diag-pill]');

  // ---- log stream ----------------------------------------------------------

  function setPlaceholder() {
    streamEl.innerHTML = '<div class="muted small" data-placeholder>Waiting for log messages…</div>';
    placeholderEl = streamEl.querySelector('[data-placeholder]');
  }

  function updateLineCount() {
    const count = streamEl.querySelectorAll('.log-line').length;
    lineCountEl.textContent = `${count} line${count === 1 ? '' : 's'}`;
  }

  function trimLines() {
    const lines = streamEl.querySelectorAll('.log-line');
    const excess = lines.length - MAX_LINES;
    for (let index = 0; index < excess; index += 1) lines[index].remove();
  }

  function appendLog(entry) {
    if (disposed) return;
    const detail = entry && typeof entry === 'object' ? entry : {};
    const level = levelKey(detail.level);
    const message = detail.message == null ? '' : String(detail.message);

    const line = document.createElement('div');
    line.className = `log-line log-level-${level}`;

    const timeEl = document.createElement('span');
    timeEl.className = 'time';
    timeEl.textContent = fmtTime(detail.time);

    const levelEl = document.createElement('span');
    levelEl.className = 'level';
    levelEl.textContent = level.toUpperCase();

    const messageEl = document.createElement('span');
    messageEl.className = 'msg';
    messageEl.textContent = message;

    line.appendChild(timeEl);
    line.appendChild(levelEl);
    line.appendChild(messageEl);

    if (placeholderEl) {
      placeholderEl.remove();
      placeholderEl = null;
    }
    streamEl.appendChild(line);
    trimLines();
    updateLineCount();

    if (autoScrollEl.checked && atBottom) streamEl.scrollTop = streamEl.scrollHeight;
  }

  function onWindowLog(event) {
    appendLog(event && event.detail);
  }

  function onScroll() {
    const remaining = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight;
    atBottom = remaining <= AUTO_SCROLL_SLACK;
  }

  function onAutoScrollChange() {
    if (autoScrollEl.checked) {
      atBottom = true;
      streamEl.scrollTop = streamEl.scrollHeight;
    }
  }

  function clearLog() {
    setPlaceholder();
    updateLineCount();
    atBottom = true;
  }

  // ---- login / page header -------------------------------------------------

  function renderLogin(state) {
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

  async function loadLogin() {
    try {
      const state = await window.api.getLoginStatus();
      if (disposed) return;
      if (typeof state === 'string') renderLogin(state);
      else if (state && typeof state.status === 'string') renderLogin(state.status);
      else renderLogin('unknown');
    } catch (err) {
      if (!disposed) renderLogin('unknown');
    }
  }

  // ---- diagnostics ---------------------------------------------------------

  let diagBusy = false;

  function renderDiagnostics(results) {
    const missing = results.filter((result) => !result || result.found !== true);
    const foundCount = results.length - missing.length;
    diagPillEl.textContent = results.length ? `${foundCount}/${results.length} found` : 'No results';

    if (!results.length) {
      diagBodyEl.innerHTML = '<div class="empty">No selectors were reported.</div>';
      return;
    }

    const banner = missing.length
      ? `<div class="banner warning">${missing.length} selector${missing.length === 1 ? '' : 's'} not found.
           Open <span class="mono">config/selectors.json</span>, match the selectors to the current Gemini DOM,
           then restart the app. Sign in to Gemini first if you see a login screen.</div>`
      : '';

    const items = results
      .map((result) => {
        const key = result && result.key != null ? String(result.key) : 'unknown';
        const selector = result && result.selector != null ? String(result.selector) : '';
        const isFound = !!(result && result.found);
        const selectorText = selector || 'no selector matched';
        return `<div class="list-item">
            <div class="col" style="gap:2px;min-width:0">
              <span class="item-title mono small">${esc(key)}</span>
              <span class="mono small muted" title="${esc(selectorText)}"
                    style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(selectorText)}</span>
            </div>
            <span class="badge ${isFound ? 'badge-completed' : 'badge-failed'}">${isFound ? 'Found' : 'Missing'}</span>
          </div>`;
      })
      .join('');

    diagBodyEl.innerHTML = `${banner}<div class="list">${items}</div>`;
  }

  async function runDiagnostics() {
    if (diagBusy || disposed) return;
    diagBusy = true;
    diagBtn.disabled = true;
    diagBtn.textContent = 'Checking…';
    diagPillEl.textContent = 'Running…';
    diagBodyEl.innerHTML = '<div class="muted small">Running selector diagnostics…</div>';
    try {
      const res = await window.api.runDiagnostics();
      if (disposed) return;
      if (res && res.ok === false) {
        diagPillEl.textContent = 'Not run';
        diagBodyEl.innerHTML = '';
        toast(res.error || 'Diagnostics failed', 'error');
        return;
      }
      const results = Array.isArray(res && res.results) ? res.results : Array.isArray(res) ? res : [];
      renderDiagnostics(results);
    } catch (err) {
      if (!disposed) {
        diagPillEl.textContent = 'Not run';
        diagBodyEl.innerHTML = '';
        toast(errText(err, 'Diagnostics failed'), 'error');
      }
    } finally {
      diagBusy = false;
      if (!disposed) {
        diagBtn.disabled = false;
        diagBtn.textContent = 'Diagnostics';
      }
    }
  }

  // ---- wiring --------------------------------------------------------------

  setPlaceholder();
  pageEl.textContent = pageLabel();

  streamEl.addEventListener('scroll', onScroll);
  autoScrollEl.addEventListener('change', onAutoScrollChange);
  clearBtn.addEventListener('click', clearLog);
  diagBtn.addEventListener('click', runDiagnostics);
  window.addEventListener('login-state', onLoginState);

  if (window.api && typeof window.api.onLog === 'function') {
    try {
      unsubscribe = window.api.onLog(appendLog);
    } catch (err) {
      toast('Could not subscribe to the log stream', 'error');
    }
  } else {
    window.addEventListener('log', onWindowLog);
  }

  await loadLogin();

  return () => {
    disposed = true;
    window.removeEventListener('login-state', onLoginState);
    window.removeEventListener('log', onWindowLog);
    streamEl.removeEventListener('scroll', onScroll);
    if (typeof unsubscribe === 'function') {
      try { unsubscribe(); } catch (err) { /* unsubscribe is best-effort */ }
    }
    unsubscribe = null;
  };
}
