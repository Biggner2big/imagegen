/**
 * History page — persisted event history from the main-process database.
 * Filterable by level/limit, exportable to CSV, refreshed by events and a 5s poll.
 */
import { esc, fmtDate, toast, debounce } from '../util.js';

const REFRESH_MS = 5000;
const JOB_DEBOUNCE_MS = 800;

function errText(err, fallback) {
  if (err && err.message) return String(err.message);
  if (typeof err === 'string' && err) return err;
  return fallback;
}

function historyList(res) {
  if (Array.isArray(res)) return res;
  if (res && res.ok === false) throw new Error(res.error || 'Could not load history');
  if (res && Array.isArray(res.history)) return res.history;
  if (res && Array.isArray(res.items)) return res.items;
  return [];
}

function levelClass(level) {
  const key = String(level || '').toLowerCase();
  if (key === 'error' || key === 'fatal' || key === 'critical') return 'badge-danger';
  if (key === 'warn' || key === 'warning') return 'badge-warning';
  return 'badge-pending';
}

function rowHtml(entry) {
  const item = entry && typeof entry === 'object' ? entry : {};
  const createdAt = item.created_at == null ? '' : String(item.created_at);
  const level = item.level == null ? 'info' : String(item.level);
  const category = item.category == null ? '' : String(item.category);
  const message = item.message == null ? '' : String(item.message);
  const jobId = item.job_id == null ? '' : String(item.job_id);
  const jobShort = jobId ? jobId.slice(0, 8) : '—';

  return `<tr>
      <td class="muted mono" title="${esc(createdAt)}">${esc(fmtDate(createdAt))}</td>
      <td><span class="badge ${levelClass(level)}">${esc(level)}</span></td>
      <td>${esc(category || '—')}</td>
      <td style="word-break:break-word" title="${esc(message)}">${esc(message)}</td>
      <td class="mono muted" title="${esc(jobId)}">${esc(jobShort)}</td>
    </tr>`;
}

export default async function render(host) {
  let disposed = false;
  let entries = [];
  let levelFilter = '';
  let limitFilter = 100;

  host.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">History</h2>
        <span class="pill" data-count>0 entries</span>
      </div>
      <div class="toolbar">
        <select class="input" data-level style="flex:1 1 140px;min-width:0" aria-label="Log level filter">
          <option value="">All levels</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
          <option value="debug">Debug</option>
        </select>
        <select class="input" data-limit style="flex:0 0 96px" aria-label="Entry limit">
          <option value="50">Last 50</option>
          <option value="100" selected>Last 100</option>
          <option value="200">Last 200</option>
          <option value="500">Last 500</option>
        </select>
        <button type="button" class="ghost sm" data-refresh>Refresh</button>
        <button type="button" class="primary sm" data-export>Export CSV</button>
      </div>
      <div class="muted small" data-summary>Loading…</div>
      <div class="table-wrap" style="margin-top:8px">
        <table class="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Level</th>
              <th>Category</th>
              <th>Message</th>
              <th>Job</th>
            </tr>
          </thead>
          <tbody data-body></tbody>
        </table>
      </div>
    </div>`;

  const bodyEl = host.querySelector('[data-body]');
  const summaryEl = host.querySelector('[data-summary]');
  const countEl = host.querySelector('[data-count]');
  const levelEl = host.querySelector('[data-level]');
  const limitEl = host.querySelector('[data-limit]');
  const refreshBtn = host.querySelector('[data-refresh]');
  const exportBtn = host.querySelector('[data-export]');

  function buildFilter() {
    const filter = { limit: limitFilter };
    if (levelFilter) filter.level = levelFilter;
    return filter;
  }

  function renderRows() {
    if (!entries.length) {
      bodyEl.innerHTML = '<tr><td class="table-empty" colspan="5">No history entries for this filter.</td></tr>';
    } else {
      bodyEl.innerHTML = entries.map(rowHtml).join('');
    }
    const noun = entries.length === 1 ? 'entry' : 'entries';
    countEl.textContent = `${entries.length} ${noun}`;
    summaryEl.textContent =
      `Showing ${entries.length} ${noun} · ${levelFilter ? `level ${levelFilter}` : 'all levels'} · limit ${limitFilter}`;
  }

  async function load() {
    if (disposed) return;
    try {
      const res = await window.api.getHistory(buildFilter());
      if (disposed) return;
      entries = historyList(res);
      renderRows();
    } catch (err) {
      if (disposed) return;
      const message = errText(err, 'Could not load history');
      toast(message, 'error');
      if (!entries.length) {
        summaryEl.textContent = message;
        bodyEl.innerHTML = `<tr><td class="table-empty" colspan="5">${esc(message)}</td></tr>`;
      }
    }
  }

  async function onExport() {
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting…';
    try {
      const res = await window.api.exportCsv(buildFilter());
      if (res && res.ok === false) {
        toast(res.error || 'Export failed', 'error');
        return;
      }
      if (res && res.canceled) return;
      if (res && res.path) toast(`Saved CSV to ${res.path}`, 'success', 6000);
      else toast('Export finished', 'success');
    } catch (err) {
      toast(errText(err, 'Export failed'), 'error');
    } finally {
      if (!disposed) {
        exportBtn.textContent = 'Export CSV';
        exportBtn.disabled = false;
      }
    }
  }

  async function onRefresh() {
    refreshBtn.disabled = true;
    try {
      await load();
    } finally {
      if (!disposed) refreshBtn.disabled = false;
    }
  }

  const reloadSoon = debounce(() => {
    if (!disposed) load();
  }, JOB_DEBOUNCE_MS);

  function onJobUpdate() {
    reloadSoon();
  }

  levelEl.addEventListener('change', () => {
    levelFilter = String(levelEl.value || '');
    load();
  });
  limitEl.addEventListener('change', () => {
    const parsed = Number(limitEl.value);
    limitFilter = Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
    load();
  });
  refreshBtn.addEventListener('click', onRefresh);
  exportBtn.addEventListener('click', onExport);
  window.addEventListener('job-update', onJobUpdate);
  const pollTimer = window.setInterval(() => {
    if (!disposed) load();
  }, REFRESH_MS);

  await load();

  return () => {
    disposed = true;
    window.removeEventListener('job-update', onJobUpdate);
    window.clearInterval(pollTimer);
  };
}
