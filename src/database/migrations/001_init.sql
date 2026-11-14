-- Gemini Bulk Image Studio - schema v1
-- Every statement is idempotent so the migration can run on every launch.

CREATE TABLE IF NOT EXISTS batches (
  id             TEXT PRIMARY KEY,
  input_folder   TEXT NOT NULL,
  output_folder  TEXT NOT NULL,
  prompt_id      TEXT,
  prompt_name    TEXT,
  prompt_body    TEXT,
  status         TEXT NOT NULL DEFAULT 'running',
  total          INTEGER NOT NULL DEFAULT 0,
  completed      INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  skipped        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);

CREATE TABLE IF NOT EXISTS prompts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  batch_id       TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  queue_index    INTEGER NOT NULL DEFAULT 0,
  original_path  TEXT NOT NULL,
  original_name  TEXT NOT NULL,
  original_ext   TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'PENDING',
  retry_count    INTEGER NOT NULL DEFAULT 0,
  error_code     TEXT,
  error_message  TEXT,
  output_path    TEXT,
  output_name    TEXT,
  duration_ms    INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  started_at     TEXT,
  completed_at   TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT,
  batch_id    TEXT,
  level       TEXT NOT NULL DEFAULT 'info',
  category    TEXT NOT NULL DEFAULT 'general',
  message     TEXT NOT NULL,
  meta        TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_batch_id       ON jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status         ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_batch_queue    ON jobs(batch_id, status, queue_index);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at     ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_batches_status      ON batches(status);
CREATE INDEX IF NOT EXISTS idx_prompts_is_default  ON prompts(is_default);
CREATE INDEX IF NOT EXISTS idx_events_created_at   ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_level        ON events(level);
CREATE INDEX IF NOT EXISTS idx_events_job_id       ON events(job_id);
