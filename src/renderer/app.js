import { toast, esc } from './util.js';

const pages = {
  dashboard: () => import('./pages/dashboard.js'),
  folders:   () => import('./pages/folders.js'),
  prompts:   () => import('./pages/prompts.js'),
  queue:     () => import('./pages/queue.js'),
  gallery:   () => import('./pages/gallery.js'),
  history:   () => import('./pages/history.js'),
  settings:  () => import('./pages/settings.js'),
  logs:      () => import('./pages/logs.js')
};

let currentCleanup = null;
let navToken = 0;
let currentPageName = null;

const host = () => document.getElementById('page-host');

async function navigate(pageName) {
  if (!pages[pageName]) return;

  document.querySelectorAll('.nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.page === pageName);
  });

  const token = ++navToken;
  currentPageName = pageName;

  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch (err) { /* page cleanup must never break navigation */ }
  }
  currentCleanup = null;

  const target = host();
  if (!target) return;
  target.innerHTML = '<div class="card"><div class="muted small">Loading…</div></div>';

  try {
    const mod = await pages[pageName]();
    if (token !== navToken) return;
    target.innerHTML = '';
    const cleanup = await mod.default(target);
    if (token !== navToken) {
      if (typeof cleanup === 'function') cleanup();
      return;
    }
    if (typeof cleanup === 'function') currentCleanup = cleanup;
  } catch (err) {
    if (token !== navToken) return;
    target.innerHTML =
      `<div class="banner error">Failed to load "${esc(pageName)}": ${esc(err && err.message ? err.message : err)}</div>`;
  }
}

// Single delegated listener: nav buttons are never re-bound.
document.querySelectorAll('.nav button').forEach((btn) => {
  btn.addEventListener('click', () => navigate(btn.dataset.page));
});

// ---- main-process event bridge (pages listen on window) ----
window.api.onJobUpdate((update) => {
  window.dispatchEvent(new CustomEvent('job-update', { detail: update }));
});

window.api.onLog((msg) => {
  window.dispatchEvent(new CustomEvent('log', { detail: msg }));
});

window.api.onNotice((notice) => {
  window.dispatchEvent(new CustomEvent('notice', { detail: notice }));
});

window.api.onBatchState((state) => {
  window.dispatchEvent(new CustomEvent('batch-state', { detail: state }));
});

function applyLoginState(state) {
  const loginEl = document.getElementById('loginStatus');
  const geminiEl = document.getElementById('geminiStatus');
  if (loginEl) {
    loginEl.textContent =
      state === 'logged_in' ? '✅ Logged In'
        : state === 'needs_login' ? '⚠️ Sign In Required'
          : 'Unknown';
  }
  if (geminiEl) {
    geminiEl.textContent =
      state === 'logged_in' ? 'Ready'
        : state === 'needs_login' ? 'Waiting for sign-in'
          : '—';
  }
  window.dispatchEvent(new CustomEvent('login-state', { detail: state }));
}

window.api.onLoginState((state) => applyLoginState(state));

// ---- initial boot ----
(async () => {
  try {
    const state = await window.api.getLoginStatus();
    applyLoginState(state);
  } catch (err) {
    applyLoginState('unknown');
  }
  await navigate('dashboard');
})();

// Surface unexpected renderer errors instead of failing silently.
window.addEventListener('error', (event) => {
  const msg = event && event.message ? event.message : 'Renderer error';
  toast(msg, 'error');
});

// Expose a tiny hook for diagnostics while developing.
window.__gbs = { navigate, get currentPage() { return currentPageName; } };
