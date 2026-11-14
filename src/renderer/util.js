/**
 * Shared renderer helpers. Import in pages as:
 *   import { esc, toast, badgeHtml, fmtDate } from '../util.js';
 */

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDuration(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '—';
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const STATUS_LABELS = {
  DISCOVERED: 'Discovered',
  PENDING: 'Pending',
  PREPARING: 'Preparing',
  UPLOADING: 'Uploading',
  UPLOADED: 'Uploaded',
  PROMPT_SUBMITTED: 'Prompt Sent',
  GENERATING: 'Generating',
  GENERATED: 'Generated',
  DOWNLOADING: 'Downloading',
  VERIFYING: 'Verifying',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  PAUSED: 'Paused'
};

export function statusLabel(status) {
  const key = String(status || '').toUpperCase();
  return STATUS_LABELS[key] || status || '—';
}

export function badgeHtml(status) {
  const cls = String(status || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '');
  return `<span class="badge badge-${cls}">${esc(statusLabel(status))}</span>`;
}

export function toast(message, type = 'info', timeout = 4500) {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = String(message);
  host.appendChild(node);
  window.setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity 0.25s';
    window.setTimeout(() => node.remove(), 300);
  }, timeout);
}

export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html).trim();
  return tpl.content.firstElementChild;
}

export function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), wait);
  };
}
