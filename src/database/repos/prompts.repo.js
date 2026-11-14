'use strict';

const { getDb } = require('../database');
const { v4: uuidv4 } = require('uuid');

const nowIso = () => new Date().toISOString();

function listPrompts() {
  return getDb().prepare('SELECT * FROM prompts ORDER BY is_default DESC, updated_at DESC').all();
}

function getPrompt(id) {
  if (!id) return null;
  return getDb().prepare('SELECT * FROM prompts WHERE id = ?').get(id) || null;
}

function getDefaultPrompt() {
  return getDb().prepare('SELECT * FROM prompts WHERE is_default = 1 ORDER BY updated_at DESC LIMIT 1').get()
    || getDb().prepare('SELECT * FROM prompts ORDER BY updated_at DESC LIMIT 1').get()
    || null;
}

function setDefaultPrompt(id) {
  const db = getDb();
  const prompt = getPrompt(id);
  if (!prompt) throw new Error('Prompt not found');
  const tx = db.transaction(() => {
    db.prepare('UPDATE prompts SET is_default = 0').run();
    db.prepare('UPDATE prompts SET is_default = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
  });
  tx();
  return getPrompt(id);
}

function savePrompt({ id = null, name, body, isDefault = false }) {
  const db = getDb();
  const cleanName = String(name || '').trim() || 'Master Prompt';
  const cleanBody = String(body == null ? '' : body);
  if (!cleanBody.trim()) throw new Error('Prompt body cannot be empty');
  const now = nowIso();

  if (id) {
    const existing = getPrompt(id);
    if (!existing) throw new Error('Prompt not found');
    db.prepare('UPDATE prompts SET name = ?, body = ?, updated_at = ? WHERE id = ?').run(cleanName, cleanBody, now, id);
    if (isDefault) setDefaultPrompt(id);
    return getPrompt(id);
  }

  const newId = uuidv4();
  const count = db.prepare('SELECT COUNT(*) AS count FROM prompts').get().count;
  const makeDefault = isDefault || count === 0 ? 1 : 0;
  const tx = db.transaction(() => {
    if (makeDefault === 1) db.prepare('UPDATE prompts SET is_default = 0').run();
    db.prepare('INSERT INTO prompts (id, name, body, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(newId, cleanName, cleanBody, makeDefault, now, now);
  });
  tx();
  return getPrompt(newId);
}

function deletePrompt(id) {
  const db = getDb();
  const prompt = getPrompt(id);
  if (!prompt) throw new Error('Prompt not found');
  if (prompt.is_default) {
    throw new Error('Cannot delete the default prompt. Set another prompt as default first.');
  }
  db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  return true;
}

function countPrompts() {
  return getDb().prepare('SELECT COUNT(*) AS count FROM prompts').get().count;
}

module.exports = {
  listPrompts,
  getPrompt,
  getDefaultPrompt,
  setDefaultPrompt,
  savePrompt,
  deletePrompt,
  countPrompts
};
