const pool = require('../../config/db');

let schemaReady = false;

async function ensureQueueSchema() {
  if (schemaReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id SERIAL PRIMARY KEY,
      job_type VARCHAR(50) NOT NULL,
      idempotency_key TEXT,
      payload JSONB NOT NULL DEFAULT '{}',
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      retry_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_queue_idempotency
    ON job_queue (job_type, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND status NOT IN ('failed', 'dead_letter')
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_job_queue_pending
    ON job_queue (status, retry_at, priority DESC, created_at ASC)
    WHERE status IN ('pending', 'retry')
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_job_queue_type_status
    ON job_queue (job_type, status, created_at DESC)
  `);

  schemaReady = true;
}

module.exports = { ensureQueueSchema };
