import { esc, fmtBytes, toast } from '../util.js';

const MAX_THUMBS = 60;
const SUPPORTED_FORMATS = '.jpg .jpeg .png .webp';

function normalizeFolder(folder) {
  return String(folder || '').replace(/[\\/]+$/, '').toLowerCase();
}

function thumbHtml(image) {
  const name = String((image && image.name) || '(unnamed)');
  const safeName = esc(name);
  const size = esc(fmtBytes(image && image.size));
  const preview = image && image.thumb
    ? `<img src="${esc(image.thumb)}" alt="${safeName}" loading="lazy" />`
    : '<div class="thumb-no-preview" style="height:92px;display:flex;align-items:center;justify-content:center;background:#0a0c11;color:var(--text-muted);font-size:10px">no preview</div>';
  return `<div class="thumb" title="${safeName}">
      ${preview}
      <div class="thumb-meta">
        <div class="thumb-name" title="${safeName}">${safeName}</div>
        <div class="thumb-size">${size}</div>
      </div>
    </div>`;
}

export default async function render(host) {
  if (!window.api) {
    host.innerHTML = '<div class="banner error">Application API is unavailable. Restart the app.</div>';
    return undefined;
  }

  host.innerHTML = `
    <div data-folders>
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Input Folder</h2>
          <span class="pill" data-input-pill>0 images</span>
        </div>
        <div class="kv">
          <span class="k">Folder</span>
          <span class="v mono" data-input-path title="">Not selected</span>
          <span class="k">Total size</span>
          <span class="v" data-input-size>—</span>
        </div>
        <div class="row" style="margin-top:10px">
          <button type="button" class="primary" data-action="pick-input">Select Input Folder</button>
          <button type="button" class="ghost" data-action="rescan" disabled>Rescan</button>
        </div>
        <div class="checkbox-row" style="margin-top:10px">
          <input type="checkbox" id="folderIncludeSubfolders" data-include-subfolders />
          <label for="folderIncludeSubfolders">Include subfolders</label>
        </div>
        <p class="small muted" style="margin:0">Supported formats: ${SUPPORTED_FORMATS}</p>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Output Folder</h2>
        </div>
        <div class="kv">
          <span class="k">Folder</span>
          <span class="v mono" data-output-path title="">Not selected</span>
        </div>
        <div class="row" style="margin-top:10px">
          <button type="button" class="primary" data-action="pick-output">Select Output Folder</button>
        </div>
        <div data-output-warning></div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Images</h2>
          <span class="pill" data-images-pill>0</span>
        </div>
        <div class="grid-thumbs" data-thumbs hidden style="display:none"></div>
        <div class="small muted" data-thumbs-note hidden style="margin-top:8px"></div>
        <div class="empty" data-images-empty>No input folder selected. Choose a folder to preview its images.</div>
      </div>
    </div>
  `;

  const page = host.querySelector('[data-folders]');
  if (!page) return undefined;
  const q = (selector) => page.querySelector(selector);

  const inputPathEl = q('[data-input-path]');
  const inputPill = q('[data-input-pill]');
  const inputSizeEl = q('[data-input-size]');
  const outputPathEl = q('[data-output-path]');
  const outputWarning = q('[data-output-warning]');
  const thumbsEl = q('[data-thumbs]');
  const thumbsNoteEl = q('[data-thumbs-note]');
  const imagesEmpty = q('[data-images-empty]');
  const imagesPill = q('[data-images-pill]');
  const includeEl = q('[data-include-subfolders]');
  const rescanBtn = q('[data-action="rescan"]');
  const pickInputBtn = q('[data-action="pick-input"]');
  const pickOutputBtn = q('[data-action="pick-output"]');

  let settings = {};
  let inputFolder = '';
  let outputFolder = '';
  let images = [];
  let scanning = false;

  const setText = (node, text) => {
    if (!node) return;
    const value = String(text == null ? '' : text);
    if (node.textContent !== value) node.textContent = value;
  };
  const setPath = (node, path) => {
    if (!node) return;
    const value = path || 'Not selected';
    if (node.textContent !== value) node.textContent = value;
    node.title = path || '';
  };
  // `hidden` alone does not win against styles.css display rules (e.g. .grid-thumbs),
  // so toggle an inline display value as well and restore the stylesheet value.
  const setHidden = (node, hidden) => {
    if (!node) return;
    node.hidden = !!hidden;
    node.style.display = hidden ? 'none' : '';
  };

  function appendWarning(message) {
    if (!outputWarning) return;
    const node = document.createElement('div');
    node.className = 'banner warning';
    node.style.marginTop = '10px';
    node.style.marginBottom = '0';
    node.textContent = message;
    outputWarning.appendChild(node);
  }

  function renderOutputWarning() {
    if (!outputWarning) return;
    outputWarning.innerHTML = '';
    if (!outputFolder) {
      appendWarning('No output folder selected. Choose one so generated images have a destination.');
      return;
    }
    if (inputFolder && normalizeFolder(inputFolder) === normalizeFolder(outputFolder)) {
      appendWarning('Output folder is the same as the input folder. Generated images would be mixed with the originals — choose a different output folder.');
    }
  }

  function renderFolders() {
    setPath(inputPathEl, inputFolder);
    setPath(outputPathEl, outputFolder);
    if (includeEl) includeEl.checked = !!settings.includeSubfolders;
    if (rescanBtn) rescanBtn.disabled = !inputFolder || scanning;
    renderOutputWarning();
  }

  function renderImages() {
    const count = images.length;
    const totalBytes = images.reduce((sum, image) => sum + (Number(image && image.size) || 0), 0);

    setText(inputPill, `${count} image${count === 1 ? '' : 's'}`);
    setText(imagesPill, String(count));
    setText(inputSizeEl, count > 0 ? fmtBytes(totalBytes) : '—');

    if (!inputFolder) {
      setHidden(thumbsEl, true);
      setHidden(thumbsNoteEl, true);
      if (imagesEmpty) {
        setHidden(imagesEmpty, false);
        imagesEmpty.textContent = 'No input folder selected. Choose a folder to preview its images.';
      }
      if (thumbsEl) thumbsEl.innerHTML = '';
      return;
    }

    if (count === 0) {
      setHidden(thumbsEl, true);
      setHidden(thumbsNoteEl, true);
      if (imagesEmpty) {
        setHidden(imagesEmpty, false);
        imagesEmpty.textContent = 'No supported images found in this folder.';
      }
      if (thumbsEl) thumbsEl.innerHTML = '';
      return;
    }

    setHidden(imagesEmpty, true);
    if (thumbsEl) {
      setHidden(thumbsEl, false);
      thumbsEl.innerHTML = images.slice(0, MAX_THUMBS).map(thumbHtml).join('');
    }
    if (thumbsNoteEl) {
      if (count > MAX_THUMBS) {
        setHidden(thumbsNoteEl, false);
        thumbsNoteEl.textContent = `Showing first ${MAX_THUMBS} of ${count} images.`;
      } else {
        setHidden(thumbsNoteEl, true);
        thumbsNoteEl.textContent = '';
      }
    }
  }

  async function scan() {
    if (!inputFolder || scanning) return;
    scanning = true;
    if (rescanBtn) rescanBtn.disabled = true;
    try {
      const result = await window.api.scanFolder(inputFolder, { includeSubfolders: !!settings.includeSubfolders });
      if (!result || result.ok === false) {
        toast((result && result.error) || 'Failed to scan folder.', 'error');
        return;
      }
      images = Array.isArray(result.images) ? result.images : [];
      renderImages();
    } catch (err) {
      toast(err && err.message ? err.message : 'Failed to scan folder.', 'error');
    } finally {
      scanning = false;
      if (rescanBtn) rescanBtn.disabled = !inputFolder;
    }
  }

  pickInputBtn.addEventListener('click', async () => {
    pickInputBtn.disabled = true;
    try {
      const result = await window.api.pickInputFolder();
      if (!result) return;
      if (result.canceled) return;
      if (result.ok === false) {
        toast(result.error || 'Could not select the input folder.', 'error');
        return;
      }
      inputFolder = result.folder || inputFolder;
      images = Array.isArray(result.images) ? result.images : [];
      settings.inputFolder = inputFolder;
      renderFolders();
      renderImages();
      toast(`Input folder selected — ${images.length} image${images.length === 1 ? '' : 's'} found.`, 'success');
    } catch (err) {
      toast(err && err.message ? err.message : 'Could not select the input folder.', 'error');
    } finally {
      pickInputBtn.disabled = false;
    }
  });

  pickOutputBtn.addEventListener('click', async () => {
    pickOutputBtn.disabled = true;
    try {
      const result = await window.api.pickOutputFolder();
      if (!result) return;
      if (result.canceled) return;
      if (result.ok === false) {
        toast(result.error || 'Could not select the output folder.', 'error');
        return;
      }
      outputFolder = result.folder || outputFolder;
      settings.outputFolder = outputFolder;
      renderFolders();
      toast('Output folder selected.', 'success');
    } catch (err) {
      toast(err && err.message ? err.message : 'Could not select the output folder.', 'error');
    } finally {
      pickOutputBtn.disabled = false;
    }
  });

  rescanBtn.addEventListener('click', () => { scan(); });

  includeEl.addEventListener('change', async () => {
    const value = !!includeEl.checked;
    includeEl.disabled = true;
    try {
      const result = await window.api.setSettings({ includeSubfolders: value });
      if (!result || result.ok === false) {
        includeEl.checked = !value;
        toast((result && result.error) || 'Could not save the include-subfolders setting.', 'error');
        return;
      }
      settings.includeSubfolders = value;
      if (inputFolder) {
        await scan();
      } else {
        toast('Include subfolders updated.', 'success');
      }
    } catch (err) {
      includeEl.checked = !value;
      toast(err && err.message ? err.message : 'Could not save the include-subfolders setting.', 'error');
    } finally {
      includeEl.disabled = false;
    }
  });

  async function init() {
    try {
      const result = await window.api.getSettings();
      if (result && result.ok === false) {
        toast(result.error || 'Could not load settings.', 'error');
        return;
      }
      settings = result && typeof result === 'object' ? result : {};
      inputFolder = settings.inputFolder || '';
      outputFolder = settings.outputFolder || '';
      renderFolders();
      if (inputFolder) await scan();
      else renderImages();
    } catch (err) {
      toast(err && err.message ? err.message : 'Could not load settings.', 'error');
    }
  }

  await init();
  return undefined;
}
