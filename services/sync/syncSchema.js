const pool = require('../../config/db');

let schemaReady = false;

async function ensureSyncSchema() {
  if (schemaReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_event_state (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL,
      external_id TEXT NOT NULL,
      calendar_id TEXT,
      last_remote_version TEXT,
      last_synced_at TIMESTAMPTZ,
      pending_push BOOLEAN DEFAULT FALSE,
      fingerprint TEXT,
      UNIQUE (user_id, provider, external_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_jobs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      job_type VARCHAR(50) NOT NULL DEFAULT 'scheduled',
      sync_strategy VARCHAR(50) NOT NULL DEFAULT 'two_way',
      conflict_strategy VARCHAR(50) NOT NULL DEFAULT 'last_write_wins',
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL,
      external_id TEXT NOT NULL,
      calendar_id TEXT,
      conflict_type VARCHAR(50) NOT NULL,
      field_conflicts JSONB,
      local_snapshot JSONB,
      remote_snapshot JSONB,
      resolution VARCHAR(50),
      resolved_by VARCHAR(50),
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_links (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_provider VARCHAR(50) NOT NULL,
      source_external_id TEXT NOT NULL,
      target_provider VARCHAR(50) NOT NULL,
      target_external_id TEXT NOT NULL,
      fingerprint TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, source_provider, source_external_id, target_provider)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sync_jobs_user_status
    ON sync_jobs (user_id, status, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sync_conflicts_user_unresolved
    ON sync_conflicts (user_id, resolved_at)
    WHERE resolved_at IS NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sync_event_state_pending
    ON sync_event_state (user_id, pending_push)
    WHERE pending_push = TRUE
  `);

  schemaReady = true;
}

module.exports = { ensureSyncSchema };
