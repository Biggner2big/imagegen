'use strict';

const { getDb } = require('../database/database');
const historyRepo = require('../database/repos/history.repo');

const TRANSIENT_STATUSES = ['PREPARING', 'UPLOADING', 'PROMPT_SUBMITTED', 'GENERATING', 'DOWNLOADING', 'VERIFYING'];

/**
 * Runs once at startup, before the UI is shown. Jobs that were mid-flight when
 * the app crashed are put back to PENDING so they can be retried safely; their
 * batch is marked interrupted so the Resume flow can pick it up.
 */
function recoverStuckJobs(logger) {
  const db = getDb();
  const now = new Date().toISOString();
  const placeholders = TRANSIENT_STATUSES.map(() => '?').join(', ');

  const jobsResult = db.prepare(`
    UPDATE jobs
    SET status = 'PENDING',
        error_code = 'RECOVERED',
        error_message = 'Recovered from crash',
        updated_at = ?,
        started_at = NULL
    WHERE status IN (${placeholders})
  `).run(now, ...TRANSIENT_STATUSES);

  const batchesResult = db.prepare(`
    UPDATE batches
    SET status = 'interrupted'
    WHERE status IN ('running', 'paused')
  `).run();

  const summary = { jobs: jobsResult.changes, batches: batchesResult.changes };
  if (summary.jobs > 0 || summary.batches > 0) {
    historyRepo.logEvent(null, 'warn', 'recovery',
      `Recovered ${summary.jobs} interrupted job(s) across ${summary.batches} batch(es)`,
      { recoveredJobs: summary.jobs, recoveredBatches: summary.batches });
    if (logger) logger.info(summary, 'startup recovery complete');
  }
  return summary;
}

module.exports = { recoverStuckJobs, TRANSIENT_STATUSES };
