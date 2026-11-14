import { esc, statusLabel, badgeHtml, fmtDuration, toast, debounce } from '../util.js';

const STATUSES = [
  'PENDING',
  'PREPARING',
  'UPLOADING',
  'UPLOADED',
  'PROMPT_SUBMITTED',
  'GENERATING',
  'GENERATED',
  'DOWNLOADING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'SKIPPED'
];

function jobRowHtml(job, index) {
  const id = String(job && job.id != null ? job.id : '');
  const status = String((job && job.status) || 'PENDING').toUpperCase();
  const fileName = String((job && (job.original_name || job.output_name)) || '(unnamed)');
  const safeName = esc(fileName);
  const retryCount = job && job.retry_count != null ? String(job.retry_count) : '0';

  const code = job && job.error_code ? String(job.error_code) : '';
  const message = job && job.error_message ? String(job.error_message) : '';
  let errorHtml = '<span class="muted">—</span>';
  if (code || message) {
    const title = esc([code, message].filter(Boolean).join(': '));
    const shortMessage = message.length > 34 ? `${message.slice(0, 34)}…` : message;
    const parts = [];
    if (code) parts.push(`<span class="mono small">${esc(code)}</span>`);
    if (shortMessage) parts.push(`<span class="small muted" title="${title}">${esc(shortMessage)}</span>`);
    errorHtml = `<div class="col" style="gap:1px;max-width:120px">${parts.join('')}</div>`;
  }

  const actions = [];
  if (status === 'FAILED' || status === 'SKIPPED') {
    actions.push(`<button type="button" class="ghost sm" data-row-action="retry" data-job-id="${esc(id)}">Retry</button>`);
  }
  if (status === 'PENDING') {
    actions.push(`<button type="button" class="ghost sm" data-row-action="skip" data-job-id="${esc(id)}">Skip</button>`);
  }
  if (status === 'COMPLETED' && job && job.output_name) {
    actions.push(`<button type="button" class="ghost sm" data-row-action="reveal" data-job-id="${esc(id)}" title="${esc(job.output_name)}">Reveal</button>`);
  }
  const actionsHtml = actions.length > 0
    ? `<div class="row" style="gap:4px;flex-wrap:nowrap">${actions.join('')}</div>`
    : '<span class="muted">—</span>';

  return `<tr>
      <td class="muted">${index + 1}</td>
      <td>
        <div style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${safeName}">${safeName}</div>
      </td>
      <td>${badgeHtml(status)}</td>
      <td>${esc(retryCount)}</td>
      <td>${errorHtml}</td>
      <td>${esc(fmtDuration(job && job.duration_ms))}</td>
      <td>${actionsHtml}</td>
    </tr>`;
}

export default async function render(host) {
  if (!window.api) {
    host.innerHTML = '<div class="banner error">Application API is unavailable. Restart the app.</div>';
    return undefined;
  }

  host.innerHTML = `
    <div class="card" data-queue>
      <div class="card-header">
        <h2 class="card-title">Job Queue</h2>
      </div>
      <div class="toolbar">
        <select class="input" data-status-filter style="width:auto;min-width:150px">
          <option value="">All</option>
          ${STATUSES.map((status) => `<option value="${status}">${esc(statusLabel(status))}</option>`).join('')}
        </select>
        <button type="button" class="ghost" data-action="refresh">Refresh</button>
        <span class="small muted" data-count-label style="align-self:center">Loading…</span>
      </div>
      <div class="table-wrap" data-table-wrap>
        <table class="table">
          <thead>
            <tr>
              <th>#</th>
              <th>File</th>
              <th>Status</th>
              <th>Retry</th>
              <th>Error</th>
              <th>Duration</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody data-rows></tbody>
        </table>
      </div>
      <div class="empty" data-empty hidden>No jobs yet — choose folders and press START on the Dashboard.</div>
    </div>
  `;

  const page = host.querySelector('[data-queue]');
  if (!page) return undefined;
  const q = (selector) => page.querySelector(selector);

  const filterEl = q('[data-status-filter]');
  const refreshBtn = q('[data-action="refresh"]');
  const countEl = q('[data-count-label]');
  const tableWrap = q('[data-table-wrap]');
  const rowsEl = q('[data-rows]');
  const emptyEl = q('[data-empty]');

  let jobs = [];
  let lastSignature = '';
  let disposed = false;
  let pollErrorShown = false;

  const setText = (node, text) => {
    if (!node) return;
    const value = String(text == null ? '' : text);
    if (node.textContent !== value) node.textContent = value;
  };
  // `hidden` alone does not win against styles.css display rules,
  // so toggle an inline display value as well and restore the stylesheet value.
  const setHidden = (node, hidden) => {
    if (!node) return;
    node.hidden = !!hidden;
    node.style.display = hidden ? 'none' : '';
  };

  function signatureFor(list, status) {
    return `${status || 'ALL'}|${JSON.stringify(list.map((job) => [
      job && job.id,
      job && job.status,
      job && job.retry_count,
      job && job.error_code,
      job && job.error_message,
      job && job.output_name,
      job && job.duration_ms
    ]))}`;
  }

  function renderJobs(list) {
    const status = filterEl.value;
    if (list.length === 0) {
      if (emptyEl) {
        setHidden(emptyEl, false);
        emptyEl.textContent = status
          ? 'No jobs match the selected filter.'
          : 'No jobs yet — choose folders and press START on the Dashboard.';
      }
      setHidden(tableWrap, true);
      if (rowsEl) rowsEl.innerHTML = '';
      return;
    }
    setHidden(emptyEl, true);
    if (!tableWrap || !rowsEl) return;
    setHidden(tableWrap, false);
    const scrollTop = tableWrap.scrollTop;
    rowsEl.innerHTML = list.map(jobRowHtml).join('');
    tableWrap.scrollTop = scrollTop;
  }

  async function refresh() {
    if (disposed) return;
    const status = filterEl ? filterEl.value : '';
    const filter = {};
    if (status) filter.status = status;

    try {
      const result = await window.api.getJobs(filter);
      if (disposed) return;
      if (!Array.isArray(result)) {
        if (!pollErrorShown) {
          pollErrorShown = true;
          setText(countEl, '—');
          toast((result && result.error) || 'Could not load jobs.', 'error');
        }
        return;
      }
      pollErrorShown = false;
      jobs = result;
      const count = result.length;
      setText(countEl, `${count} job${count === 1 ? '' : 's'}${status ? ' matching' : ''}`);
      const signature = signatureFor(result, status);
      if (signature !== lastSignature) {
        lastSignature = signature;
        renderJobs(result);
      }
    } catch (err) {
      if (!pollErrorShown && !disposed) {
        pollErrorShown = true;
        toast(err && err.message ? err.message : 'Could not load jobs.', 'error');
      }
    }
  }

  async function onRowAction(event) {
    const button = event.target.closest('button[data-row-action]');
    if (!button) return;
    const action = button.getAttribute('data-row-action');
    const rawId = button.getAttribute('data-job-id') || '';
    const job = jobs.find((entry) => entry && String(entry.id) === rawId) || null;
    const jobId = job ? job.id : rawId;
    if (jobId == null) return;

    button.disabled = true;
    try {
      let result;
      if (action === 'retry') result = await window.api.retryJob(jobId);
      else if (action === 'skip') result = await window.api.skipJob(jobId);
      else if (action === 'reveal') result = await window.api.revealJob(jobId);
      else return;

      if (!result || result.ok === false) {
        toast((result && result.error) || 'Action failed.', 'error');
        return;
      }
      toast(
        action === 'retry' ? 'Job queued for retry.'
          : action === 'skip' ? 'Job skipped.'
            : 'File revealed.',
        'success'
      );
      await refresh();
    } catch (err) {
      toast(err && err.message ? err.message : 'Action failed.', 'error');
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  function onFilterChange() {
    lastSignature = '';
    refresh();
  }

  async function onRefreshClick() {
    refreshBtn.disabled = true;
    try {
      await refresh();
    } finally {
      refreshBtn.disabled = false;
    }
  }

  const refreshSoon = debounce(() => { refresh(); }, 500);
  function onJobUpdate() {
    refreshSoon();
  }

  refreshBtn.addEventListener('click', onRefreshClick);
  filterEl.addEventListener('change', onFilterChange);
  rowsEl.addEventListener('click', onRowAction);
  window.addEventListener('job-update', onJobUpdate);

  await refresh();
  if (disposed) return undefined;

  const pollTimer = window.setInterval(() => { refresh(); }, 4000);

  return function cleanup() {
    disposed = true;
    window.clearInterval(pollTimer);
    window.removeEventListener('job-update', onJobUpdate);
    refreshBtn.removeEventListener('click', onRefreshClick);
    filterEl.removeEventListener('change', onFilterChange);
    rowsEl.removeEventListener('click', onRowAction);
  };
}
