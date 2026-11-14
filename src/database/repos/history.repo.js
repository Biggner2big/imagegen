'use strict';

const { getDb } = require('../database');

const nowIso = () => new Date().toISOString();

/**
 * Persist one structured event. Positional signature matches AGENT.md 3.3:
 * logEvent(jobId, level, category, message, meta)
 */
function logEvent(jobId, level, category, message, meta = null) {
  const safeMeta = meta && typeof meta === 'object' ? JSON.stringify(meta) : (meta ? String(meta) : null);
  getDb().prepare(`
    INSERT INTO events (job_id, batch_id, level, category, message, meta, created_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    jobId || null,
    (meta && typeof meta === 'object' && meta.batchId) ? meta.batchId : null,
    String(level || 'info'),
    String(category || 'general'),
    String(message == null ? '' : message).slice(0, 4000),
    safeMeta,
    nowIso()
  );
}

function listEvents({ level = null, limit = 100, jobId = null } = {}) {
  const clauses = [];
  const params = [];
  if (level && level !== 'ALL') { clauses.push('level = ?'); params.push(level); }
  if (jobId) { clauses.push('job_id = ?'); params.push(jobId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 20000));
  return getDb().prepare(`
    SELECT * FROM events ${where}
    ORDER BY id DESC
    LIMIT ${safeLimit}
  `).all(...params);
}

function countEvents() {
  return getDb().prepare('SELECT COUNT(*) AS count FROM events').get().count;
}

module.exports = { logEvent, listEvents, countEvents };
