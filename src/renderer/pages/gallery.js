/**
 * Gallery page — grid of completed images.
 *
 * Thumbnails arrive as 120px JPEG data URLs from the main process. The lightbox
 * scales the same data URL because file:// URLs are blocked by the page CSP
 * (img-src 'self' data: blob:), so no full-resolution preview is attempted here.
 */
import { esc, fmtDate, fmtBytes, toast, debounce } from '../util.js';

function errText(err, fallback) {
  if (err && err.message) return String(err.message);
  if (typeof err === 'string' && err) return err;
  return fallback;
}

function jobIdOf(item) {
  if (!item || item.jobId == null) return '';
  return String(item.jobId);
}

function galleryList(res) {
  if (Array.isArray(res)) return res;
  if (res && res.ok === false) throw new Error(res.error || 'Could not load the gallery');
  if (res && Array.isArray(res.gallery)) return res.gallery;
  if (res && Array.isArray(res.items)) return res.items;
  return [];
}

function isDataImage(value) {
  return typeof value === 'string' && /^data:image\//i.test(value);
}

export default async function render(host) {
  let disposed = false;
  let images = [];
  let overlay = null;
  let lastFocus = null;
  const selected = new Set();

  host.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Gallery</h2>
        <span class="pill" data-count>0 images</span>
      </div>
      <div class="toolbar">
        <button type="button" class="ghost sm" data-refresh>Refresh</button>
        <button type="button" class="ghost sm" data-select-all disabled>Select all</button>
        <span class="muted small" data-selected>0 selected</span>
        <span class="spacer"></span>
        <button type="button" class="primary sm" data-export disabled>Export ZIP</button>
      </div>
      <div class="grid-thumbs" data-grid style="display:none"></div>
      <div class="empty" data-empty>Loading…</div>
      <div class="muted small">Previews use the 120px thumbnail image; full-size files stay in the output folder.</div>
    </div>`;

  const gridEl = host.querySelector('[data-grid]');
  const emptyEl = host.querySelector('[data-empty]');
  const countEl = host.querySelector('[data-count]');
  const selectedEl = host.querySelector('[data-selected]');
  const refreshBtn = host.querySelector('[data-refresh]');
  const selectAllBtn = host.querySelector('[data-select-all]');
  const exportBtn = host.querySelector('[data-export]');

  // ---- rendering -----------------------------------------------------------

  function updateSelectionUi() {
    const count = selected.size;
    const total = images.length;
    const all = total > 0 && images.every((item) => selected.has(jobIdOf(item)));
    countEl.textContent = `${total} image${total === 1 ? '' : 's'}`;
    selectedEl.textContent = `${count} selected`;
    exportBtn.disabled = count === 0;
    selectAllBtn.disabled = total === 0;
    selectAllBtn.textContent = all ? 'Clear' : 'Select all';
  }

  function thumbHtml(item) {
    const id = jobIdOf(item);
    const name = item && item.outputName != null ? String(item.outputName) : '';
    const label = name || 'Untitled';
    const previewSrc = item && isDataImage(item.thumb) ? item.thumb : '';
    const hasThumb = previewSrc !== '';
    const picked = selected.has(id);
    const dateText = fmtDate(item && item.createdAt);
    const sizeText = item && item.size != null ? fmtBytes(item.size) : '—';

    const preview = hasThumb
      ? `<img src="${esc(previewSrc)}" alt="${esc(label)}" loading="lazy" />`
      : `<div class="thumb-meta muted small" style="height:92px;display:flex;align-items:center;justify-content:center">No preview</div>`;

    return `<div class="thumb${hasThumb ? ' clickable' : ''}" data-job-id="${esc(id)}">
        ${preview}
        <div class="thumb-meta">
          <div class="thumb-name" title="${esc(label)}">${esc(label)}</div>
          <div class="thumb-size">${esc(dateText)} · ${esc(sizeText)}</div>
          <div class="row" style="margin-top:3px;justify-content:space-between">
            <label class="checkbox-row" style="margin:0;gap:5px" data-pick-wrap>
              <input type="checkbox" data-pick${picked ? ' checked' : ''} aria-label="Select for ZIP export" />
              <span class="thumb-size">ZIP</span>
            </label>
            <button type="button" class="ghost sm" data-reveal>Reveal</button>
          </div>
        </div>
      </div>`;
  }

  function renderGrid() {
    const hasImages = images.length > 0;
    gridEl.style.display = hasImages ? '' : 'none';
    emptyEl.style.display = hasImages ? 'none' : '';
    if (!hasImages) {
      gridEl.innerHTML = '';
      emptyEl.textContent = 'No completed images yet. Finished downloads will appear here.';
    } else {
      gridEl.innerHTML = images.map(thumbHtml).join('');
    }
    updateSelectionUi();
  }

  // ---- lightbox ------------------------------------------------------------

  function closeLightbox() {
    if (!overlay) return;
    overlay.removeEventListener('click', onOverlayClick);
    overlay.remove();
    overlay = null;
    if (lastFocus && document.contains(lastFocus) && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (err) { /* focus restore is best-effort */ }
    }
    lastFocus = null;
  }

  function onOverlayClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('[data-close]')) {
      closeLightbox();
      return;
    }
    if (target === overlay) closeLightbox();
  }

  function onKeyDown(event) {
    if (!overlay) return;
    if (event.key === 'Escape' || event.key === 'Esc') {
      event.preventDefault();
      closeLightbox();
    }
  }

  function openLightbox(item) {
    if (!item || !isDataImage(item.thumb)) return;
    closeLightbox();
    const name = item.outputName != null ? String(item.outputName) : '';
    const label = name || 'Generated image';
    lastFocus = document.activeElement;
    overlay = document.createElement('div');
    overlay.className = 'lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', label);
    overlay.innerHTML = `
      <button type="button" class="ghost icon-btn close" data-close aria-label="Close preview">✕</button>
      <img src="${esc(item.thumb)}" alt="${esc(label)}" />
      <div class="caption">${esc(label)} · ${esc(fmtDate(item.createdAt))} · ${esc(item.size != null ? fmtBytes(item.size) : '—')}</div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', onOverlayClick);
    const closeBtn = overlay.querySelector('[data-close]');
    if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
  }

  // ---- actions -------------------------------------------------------------

  async function revealItem(jobId) {
    if (!jobId) return;
    try {
      const res = await window.api.revealJob(jobId);
      if (res && res.ok === false) toast(res.error || 'Could not reveal the file', 'error');
    } catch (err) {
      toast(errText(err, 'Could not reveal the file'), 'error');
    }
  }

  async function exportSelection() {
    const ids = images.map(jobIdOf).filter((id) => id && selected.has(id));
    if (!ids.length) return;
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting…';
    try {
      const res = await window.api.exportZip(ids);
      if (res && res.ok === false) {
        toast(res.error || 'Export failed', 'error');
        return;
      }
      if (res && res.canceled) return;
      if (res && res.path) toast(`Saved ZIP to ${res.path}`, 'success', 6000);
      else toast('Export finished', 'success');
    } catch (err) {
      toast(errText(err, 'Export failed'), 'error');
    } finally {
      if (!disposed) {
        exportBtn.textContent = 'Export ZIP';
        exportBtn.disabled = selected.size === 0;
      }
    }
  }

  function onSelectAll() {
    if (!images.length) return;
    const all = images.every((item) => selected.has(jobIdOf(item)));
    selected.clear();
    if (!all) {
      images.forEach((item) => {
        const id = jobIdOf(item);
        if (id) selected.add(id);
      });
    }
    gridEl.querySelectorAll('[data-job-id]').forEach((thumb) => {
      const pick = thumb.querySelector('[data-pick]');
      if (pick) pick.checked = selected.has(thumb.dataset.jobId);
    });
    updateSelectionUi();
  }

  function onGridClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    if (target.closest('[data-pick-wrap]')) {
      event.stopPropagation();
      return;
    }

    const revealBtn = target.closest('[data-reveal]');
    if (revealBtn) {
      event.stopPropagation();
      const thumb = revealBtn.closest('[data-job-id]');
      revealItem(thumb ? thumb.dataset.jobId : '');
      return;
    }

    const thumb = target.closest('.thumb[data-job-id]');
    if (!thumb || !thumb.classList.contains('clickable')) return;
    const item = images.find((entry) => jobIdOf(entry) === thumb.dataset.jobId);
    if (item) openLightbox(item);
  }

  function onGridChange(event) {
    const pick = event.target;
    if (!pick || typeof pick.matches !== 'function' || !pick.matches('[data-pick]')) return;
    const thumb = pick.closest('[data-job-id]');
    const id = thumb ? thumb.dataset.jobId : '';
    if (!id) return;
    if (pick.checked) selected.add(id);
    else selected.delete(id);
    updateSelectionUi();
  }

  async function onRefresh() {
    refreshBtn.disabled = true;
    try {
      await load();
    } finally {
      if (!disposed) refreshBtn.disabled = false;
    }
  }

  // ---- data ----------------------------------------------------------------

  async function load() {
    if (disposed) return;
    try {
      const res = await window.api.getGallery();
      if (disposed) return;
      images = galleryList(res);
      const live = new Set(images.map(jobIdOf));
      for (const id of Array.from(selected)) {
        if (!live.has(id)) selected.delete(id);
      }
      renderGrid();
    } catch (err) {
      if (disposed) return;
      const message = errText(err, 'Could not load the gallery');
      toast(message, 'error');
      if (!images.length) {
        gridEl.style.display = 'none';
        emptyEl.style.display = '';
        emptyEl.textContent = message;
      }
    }
  }

  const reloadSoon = debounce(() => {
    if (!disposed) load();
  }, 600);

  function onJobUpdate() {
    reloadSoon();
  }

  // ---- wiring --------------------------------------------------------------

  gridEl.addEventListener('click', onGridClick);
  gridEl.addEventListener('change', onGridChange);
  refreshBtn.addEventListener('click', onRefresh);
  selectAllBtn.addEventListener('click', onSelectAll);
  exportBtn.addEventListener('click', exportSelection);
  window.addEventListener('job-update', onJobUpdate);
  document.addEventListener('keydown', onKeyDown);

  await load();

  return () => {
    disposed = true;
    window.removeEventListener('job-update', onJobUpdate);
    document.removeEventListener('keydown', onKeyDown);
    closeLightbox();
  };
}
