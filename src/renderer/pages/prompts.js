import { esc, toast } from '../util.js';

function promptTimestamp(prompt) {
  const raw = prompt && (prompt.updated_at || prompt.created_at);
  const time = new Date(raw || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export default async function render(host) {
  if (!window.api) {
    host.innerHTML = '<div class="banner error">Application API is unavailable. Restart the app.</div>';
    return undefined;
  }

  host.innerHTML = `
    <div data-prompts>
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Master Prompt</h2>
        </div>
        <p class="card-sub" style="margin:0 0 10px">
          The same prompt is used verbatim for every image in a batch.
        </p>
        <div data-editor-warning></div>
        <div class="field">
          <label for="promptName">Prompt name</label>
          <input class="input" id="promptName" data-prompt-name placeholder="Master Prompt" maxlength="200" />
        </div>
        <div class="field">
          <label for="promptBody">Prompt body</label>
          <textarea class="textarea" id="promptBody" data-prompt-body spellcheck="false"
                    placeholder="Describe the transformation to apply to every image…"></textarea>
        </div>
        <div class="row" style="justify-content:space-between;margin-top:10px">
          <span class="small muted" data-char-count>0 characters</span>
          <div class="row" style="gap:8px">
            <button type="button" class="ghost" data-action="new">New</button>
            <button type="button" class="primary" data-action="save">Save Prompt</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Saved Prompts</h2>
          <span class="pill" data-prompt-count>0</span>
        </div>
        <div class="list" data-prompt-list></div>
        <div class="empty" data-prompt-empty hidden>No prompts saved yet — write one above and press Save.</div>
      </div>
    </div>
  `;

  const page = host.querySelector('[data-prompts]');
  if (!page) return undefined;
  const q = (selector) => page.querySelector(selector);

  const nameEl = q('[data-prompt-name]');
  const bodyEl = q('[data-prompt-body]');
  const saveBtn = q('[data-action="save"]');
  const newBtn = q('[data-action="new"]');
  const charCountEl = q('[data-char-count]');
  const warningEl = q('[data-editor-warning]');
  const listEl = q('[data-prompt-list]');
  const emptyEl = q('[data-prompt-empty]');
  const countEl = q('[data-prompt-count]');

  let prompts = [];
  let editingId = null;

  const setText = (node, text) => {
    if (!node) return;
    const value = String(text == null ? '' : text);
    if (node.textContent !== value) node.textContent = value;
  };
  // `hidden` alone does not win against styles.css display rules (e.g. .list),
  // so toggle an inline display value as well and restore the stylesheet value.
  const setHidden = (node, hidden) => {
    if (!node) return;
    node.hidden = !!hidden;
    node.style.display = hidden ? 'none' : '';
  };

  function findPrompt(id) {
    return prompts.find((prompt) => prompt && String(prompt.id) === String(id)) || null;
  }

  function updateCharCount() {
    const length = bodyEl.value.length;
    setText(charCountEl, `${length} character${length === 1 ? '' : 's'}`);
  }

  function renderList() {
    setText(countEl, String(prompts.length));
    if (!listEl) return;
    if (prompts.length === 0) {
      listEl.innerHTML = '';
      setHidden(listEl, true);
      setHidden(emptyEl, false);
      return;
    }
    setHidden(emptyEl, true);
    setHidden(listEl, false);
    listEl.innerHTML = prompts.map((prompt) => {
      const isDefault = !!prompt.is_default;
      const isActive = isDefault || (editingId != null && String(prompt.id) === String(editingId));
      const name = esc(prompt.name || 'Untitled prompt');
      return `<div class="list-item${isActive ? ' active' : ''}">
          <div class="col" style="gap:4px;min-width:0">
            <span class="item-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${name}">${name}</span>
            ${isDefault ? '<span class="badge badge-success">Default</span>' : ''}
          </div>
          <div class="row" style="gap:6px;flex-wrap:nowrap">
            <button type="button" class="ghost sm" data-list-action="load" data-prompt-id="${esc(prompt.id)}">Load</button>
            <button type="button" class="ghost sm" data-list-action="default" data-prompt-id="${esc(prompt.id)}">Set Default</button>
            <button type="button" class="danger sm" data-list-action="delete" data-prompt-id="${esc(prompt.id)}">Delete</button>
          </div>
        </div>`;
    }).join('');
  }

  function updateDirtyWarning() {
    if (!warningEl) return;
    warningEl.innerHTML = '';
    const defaultPrompt = prompts.find((prompt) => prompt && prompt.is_default) || null;
    if (!defaultPrompt || editingId == null || String(defaultPrompt.id) !== String(editingId)) return;
    if (bodyEl.value === (defaultPrompt.body || '')) return;

    const node = document.createElement('div');
    node.className = 'banner warning';
    const message = document.createElement('span');
    message.className = 'small';
    message.style.flex = '1';
    message.textContent = 'You are editing the default prompt. The next batch will keep using the saved version until you press Save Prompt.';
    node.appendChild(message);
    warningEl.appendChild(node);
  }

  function loadIntoEditor(prompt) {
    if (!prompt) return;
    editingId = prompt.id != null ? prompt.id : null;
    nameEl.value = prompt.name || '';
    bodyEl.value = prompt.body || '';
    updateCharCount();
    renderList();
    updateDirtyWarning();
  }

  async function refreshList() {
    try {
      const result = await window.api.listPrompts();
      if (!Array.isArray(result)) {
        toast((result && result.error) || 'Could not load prompts.', 'error');
        return;
      }
      prompts = result;
      renderList();
    } catch (err) {
      toast(err && err.message ? err.message : 'Could not load prompts.', 'error');
    }
  }

  async function saveCurrent() {
    const name = nameEl.value.trim() || 'Master Prompt';
    const body = bodyEl.value;
    if (!body.trim()) {
      toast('Prompt body cannot be empty.', 'error');
      bodyEl.focus();
      return;
    }
    if (nameEl.value !== name) nameEl.value = name;

    const payload = { name, body };
    if (editingId != null) payload.id = editingId;

    saveBtn.disabled = true;
    try {
      const result = await window.api.savePrompt(payload);
      if (!result || result.ok === false) {
        toast((result && result.error) || 'Could not save the prompt.', 'error');
        return;
      }
      if (result.id != null) editingId = result.id;
      toast('Prompt saved.', 'success');
      await refreshList();
      updateDirtyWarning();
    } catch (err) {
      toast(err && err.message ? err.message : 'Could not save the prompt.', 'error');
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function setDefaultPrompt(prompt) {
    try {
      const result = await window.api.setDefault(prompt.id);
      if (!result || result.ok === false) {
        toast((result && result.error) || 'Could not set the default prompt.', 'error');
        return;
      }
      toast(`"${prompt.name || 'Prompt'}" is now the default prompt.`, 'success');
      await refreshList();
      updateDirtyWarning();
    } catch (err) {
      toast(err && err.message ? err.message : 'Could not set the default prompt.', 'error');
    }
  }

  async function deletePromptById(prompt) {
    if (!window.confirm(`Delete prompt "${prompt.name || 'Untitled prompt'}"? This cannot be undone.`)) return;
    try {
      const result = await window.api.deletePrompt(prompt.id);
      if (!result || result.ok === false) {
        toast((result && result.error) || 'Could not delete the prompt.', 'error');
        await refreshList();
        updateDirtyWarning();
        return;
      }
      toast('Prompt deleted.', 'success');
      if (editingId != null && String(editingId) === String(prompt.id)) {
        editingId = null;
        nameEl.value = '';
        bodyEl.value = '';
        updateCharCount();
      }
      await refreshList();
      updateDirtyWarning();
    } catch (err) {
      toast(err && err.message ? err.message : 'Could not delete the prompt.', 'error');
    }
  }

  function startNew() {
    editingId = null;
    nameEl.value = '';
    bodyEl.value = '';
    updateCharCount();
    renderList();
    updateDirtyWarning();
    nameEl.focus();
  }

  function onListClick(event) {
    const button = event.target.closest('button[data-list-action]');
    if (!button) return;
    const prompt = findPrompt(button.getAttribute('data-prompt-id'));
    if (!prompt) return;
    const action = button.getAttribute('data-list-action');
    if (action === 'load') loadIntoEditor(prompt);
    else if (action === 'default') setDefaultPrompt(prompt);
    else if (action === 'delete') deletePromptById(prompt);
  }

  saveBtn.addEventListener('click', saveCurrent);
  newBtn.addEventListener('click', startNew);
  listEl.addEventListener('click', onListClick);
  nameEl.addEventListener('input', updateDirtyWarning);
  bodyEl.addEventListener('input', () => {
    updateCharCount();
    updateDirtyWarning();
  });

  await refreshList();

  if (prompts.length > 0) {
    const defaultPrompt = prompts.find((prompt) => prompt && prompt.is_default) || null;
    const mostRecent = prompts
      .slice()
      .sort((a, b) => promptTimestamp(b) - promptTimestamp(a))[0] || null;
    const initial = defaultPrompt || mostRecent;
    if (initial) loadIntoEditor(initial);
  } else {
    updateCharCount();
  }

  return function cleanup() {
    listEl.removeEventListener('click', onListClick);
  };
}
