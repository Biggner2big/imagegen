'use strict';

const { getDb } = require('../database');
const { assertTransition } = require('../../automation/state-machine');
const { v4: uuidv4 } = require('uuid');

const BATCH_STATUSES = ['running', 'paused', 'interrupted', 'stopped', 'completed', 'completed_with_errors'];
const JOB_FIELDS = ['output_path', 'output_name', 'error_code', 'error_message', 'retry_count', 'started_at', 'completed_at', 'duration_ms'];

const nowIso = () => new Date().toISOString();

function getBatch(batchId) {
  return getDb().prepare('SELECT * FROM batches WHERE id = ?').get(batchId) || null;
}

function getJob(jobId) {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) || null;
}

/* ------------------------------------------------------------------ */
/* Batches                                                             */
/* ------------------------------------------------------------------ */

function createBatch({ inputFolder, outputFolder, promptId = null, promptName = null, promptBody = null, total = 0, status = 'running' }) {
  const db = getDb();
  const id = uuidv4();
  const now = nowIso();
  db.prepare(`
    INSERT INTO batches
      (id, input_folder, output_folder, prompt_id, prompt_name, prompt_body, status, total, completed, failed, skipped, created_at, started_at)
    VALUES (?,?,?,?,?,?,?,?,0,0,0,?,?)
  `).run(id, inputFolder, outputFolder, promptId, promptName, promptBody, status, total, now, now);
  return getBatch(id);
}

function updateBatchStatus(batchId, status, extra = {}) {
  if (!BATCH_STATUSES.includes(status)) throw new Error(`Unknown batch status: ${status}`);
  const db = getDb();
  const sets = ['status = ?'];
  const values = [status];
  if (extra.finished_at) { sets.push('finished_at = ?'); values.push(extra.finished_at); }
  if (extra.started_at) { sets.push('started_at = ?'); values.push(extra.started_at); }
  if (extra.total !== undefined) { sets.push('total = ?'); values.push(extra.total); }
  if (extra.completed !== undefined) { sets.push('completed = ?'); values.push(extra.completed); }
  if (extra.failed !== undefined) { sets.push('failed = ?'); values.push(extra.failed); }
  if (extra.skipped !== undefined) { sets.push('skipped = ?'); values.push(extra.skipped); }
  values.push(batchId);
  db.prepare(`UPDATE batches SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getBatch(batchId);
}

function finalizeBatch(batchId, status) {
  return updateBatchStatus(batchId, status, { finished_at: nowIso() });
}

function getActiveBatch() {
  return getDb().prepare(`
    SELECT * FROM batches
    WHERE status IN ('running', 'paused', 'interrupted')
    ORDER BY created_at DESC LIMIT 1
  `).get() || null;
}

function getLatestBatch() {
  return getDb().prepare('SELECT * FROM batches ORDER BY created_at DESC LIMIT 1').get() || null;
}

function incrementBatchCompleted(batchId) {
  getDb().prepare('UPDATE batches SET completed = completed + 1 WHERE id = ?').run(batchId);
}

function incrementBatchFailed(batchId) {
  getDb().prepare('UPDATE batches SET failed = failed + 1 WHERE id = ?').run(batchId);
}

function incrementBatchSkipped(batchId) {
  getDb().prepare('UPDATE batches SET skipped = skipped + 1 WHERE id = ?').run(batchId);
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

function createJobs(batchId, images) {
  const db = getDb();
  const now = nowIso();
  const insert = db.prepare(`
    INSERT INTO jobs
      (id, batch_id, queue_index, original_path, original_name, original_ext, status, retry_count, created_at, updated_at)
    VALUES (?,?,?,?,?,?,'PENDING',0,?,?)
  `);
  const tx = db.transaction((rows) => {
    rows.forEach((img, index) => {
      insert.run(uuidv4(), batchId, index, img.path, img.name, img.ext || '', now, now);
    });
  });
  tx(images);
  db.prepare('UPDATE batches SET total = ? WHERE id = ?').run(images.length, batchId);
  return images.length;
}

function updateJobStatus(jobId, newStatus, extra = {}) {
  const db = getDb();
  const job = getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  assertTransition(job.status, newStatus);

  if (newStatus === 'COMPLETED' && !(extra.output_path || job.output_path)) {
    throw new Error('Refusing to mark a job COMPLETED without an output file');
  }

  const sets = ['status = ?', 'updated_at = ?'];
  const values = [newStatus, nowIso()];
  for (const field of JOB_FIELDS) {
    if (extra[field] !== undefined) {
      sets.push(`${field} = ?`);
      values.push(extra[field] === null ? null : extra[field]);
    }
  }
  values.push(jobId);
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getJob(jobId);
}

function getNextPendingJob(batchId) {
  return getDb().prepare(`
    SELECT * FROM jobs
    WHERE batch_id = ? AND status = 'PENDING'
    ORDER BY queue_index ASC, created_at ASC
    LIMIT 1
  `).get(batchId) || null;
}

function listJobs({ batchId = null, status = null, limit = 500 } = {}) {
  const clauses = [];
  const params = [];
  if (batchId) { clauses.push('batch_id = ?'); params.push(batchId); }
  if (status && status !== 'ALL') { clauses.push('status = ?'); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 5000));
  return getDb().prepare(`
    SELECT * FROM jobs ${where}
    ORDER BY created_at DESC, queue_index DESC
    LIMIT ${safeLimit}
  `).all(...params);
}

function listCompletedJobs({ limit = 500 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 5000));
  return getDb().prepare(`
    SELECT j.*, b.input_folder, b.output_folder, b.prompt_name
    FROM jobs j
    JOIN batches b ON b.id = j.batch_id
    WHERE j.status = 'COMPLETED' AND j.output_path IS NOT NULL
    ORDER BY j.completed_at DESC
    LIMIT ${safeLimit}
  `).all();
}

function countByStatus(batchId) {
  const rows = getDb().prepare('SELECT status, COUNT(*) AS count FROM jobs WHERE batch_id = ? GROUP BY status').all(batchId);
  const counts = { total: 0, completed: 0, failed: 0, pending: 0, processing: 0, skipped: 0, paused: 0, byStatus: {} };
  for (const row of rows) {
    counts.byStatus[row.status] = row.count;
    counts.total += row.count;
  }
  counts.completed = counts.byStatus.COMPLETED || 0;
  counts.failed = counts.byStatus.FAILED || 0;
  counts.pending = counts.byStatus.PENDING || 0;
  counts.skipped = counts.byStatus.SKIPPED || 0;
  counts.paused = counts.byStatus.PAUSED || 0;
  counts.processing = ['PREPARING', 'UPLOADING', 'UPLOADED', 'PROMPT_SUBMITTED', 'GENERATING', 'GENERATED', 'DOWNLOADING', 'VERIFYING']
    .reduce((sum, status) => sum + (counts.byStatus[status] || 0), 0);
  return counts;
}

function getPendingCount(batchId) {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM jobs WHERE batch_id = ? AND status = 'PENDING'").get(batchId);
  return row ? row.count : 0;
}

function getAverageDuration(batchId) {
  const row = getDb().prepare(`
    SELECT AVG(duration_ms) AS avg FROM jobs
    WHERE batch_id = ? AND status = 'COMPLETED' AND duration_ms IS NOT NULL
  `).get(batchId);
  return row && row.avg ? Math.round(row.avg) : null;
}

function getLastError(batchId) {
  const job = getDb().prepare(`
    SELECT id, error_code, error_message, updated_at FROM jobs
    WHERE batch_id = ? AND error_message IS NOT NULL AND status = 'FAILED'
    ORDER BY updated_at DESC LIMIT 1
  `).get(batchId);
  if (!job) return null;
  return { jobId: job.id, code: job.error_code, message: job.error_message, at: job.updated_at };
}

/**
 * Move every FAILED job in a batch back to PENDING (RETRY FAILED button).
 * Uses the state machine, so FAILED -> PENDING is the only allowed route.
 */
function requeueFailed(batchId) {
  const db = getDb();
  const failed = db.prepare("SELECT * FROM jobs WHERE batch_id = ? AND status = 'FAILED' ORDER BY queue_index ASC").all(batchId);
  let requeued = 0;
  const tx = db.transaction(() => {
    for (const job of failed) {
      updateJobStatus(job.id, 'PENDING', {
        retry_count: 0,
        error_code: null,
        error_message: null,
        completed_at: null,
        started_at: null
      });
      requeued += 1;
    }
    if (requeued > 0) {
      db.prepare('UPDATE batches SET failed = MAX(failed - ?, 0) WHERE id = ?').run(requeued, batchId);
    }
  });
  tx();
  return requeued;
}

function retryJobById(jobId) {
  const job = getJob(jobId);
  if (!job) throw new Error('Job not found');
  if (job.status === 'COMPLETED') throw new Error('Completed jobs cannot be retried');
  if (job.status === 'PENDING') throw new Error('Job is already pending');
  if (job.status !== 'FAILED' && job.status !== 'SKIPPED') {
    throw new Error(`Only failed or skipped jobs can be retried (current: ${job.status})`);
  }
  return updateJobStatus(jobId, 'PENDING', {
    retry_count: 0,
    error_code: null,
    error_message: null,
    completed_at: null,
    started_at: null
  });
}

function skipJobById(jobId) {
  const job = getJob(jobId);
  if (!job) throw new Error('Job not found');
  if (job.status !== 'PENDING') throw new Error(`Only pending jobs can be skipped (current: ${job.status})`);
  return updateJobStatus(jobId, 'SKIPPED', { error_code: 'SKIPPED', error_message: 'Skipped by user' });
}

module.exports = {
  BATCH_STATUSES,
  nowIso,
  getBatch,
  getJob,
  createBatch,
  updateBatchStatus,
  finalizeBatch,
  getActiveBatch,
  getLatestBatch,
  incrementBatchCompleted,
  incrementBatchFailed,
  incrementBatchSkipped,
  createJobs,
  updateJobStatus,
  getNextPendingJob,
  listJobs,
  listCompletedJobs,
  countByStatus,
  getPendingCount,
  getAverageDuration,
  getLastError,
  requeueFailed,
  retryJobById,
  skipJobById
};
