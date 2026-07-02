const pool = require('../../config/db');
const { ensureQueueSchema } = require('./queueSchema');
const { getMaxAttempts, getRetryAt } = require('./retryPolicy');

const JOB_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  RETRY: 'retry',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DEAD_LETTER: 'dead_letter',
};

const JOB_TYPES = {
  SYNC_USER: 'sync_user',
  SYNC_ALL: 'sync_all',
  WEBHOOK_DELIVERY: 'webhook_delivery',
};

/**
 * Enqueue a background job. Returns existing job if idempotency_key matches.
 */
async function enqueueJob(jobType, payload, options = {}) {
  await ensureQueueSchema();

  const maxAttempts = options.maxAttempts ?? getMaxAttempts(jobType);
  const priority = options.priority ?? 0;
  const idempotencyKey = options.idempotencyKey || null;

  if (idempotencyKey) {
    const existing = await pool.query(
      `SELECT id, status, result, error, created_at
       FROM job_queue
       WHERE job_type = $1 AND idempotency_key = $2
         AND status NOT IN ('failed', 'dead_letter')
       ORDER BY created_at DESC
       LIMIT 1`,
      [jobType, idempotencyKey]
    );
    if (existing.rows[0]) {
      return { ...existing.rows[0], duplicate: true };
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO job_queue
       (job_type, idempotency_key, payload, status, priority, max_attempts, retry_at)
     VALUES ($1, $2, $3, 'pending', $4, $5, NOW())
     RETURNING id, job_type, status, created_at`,
    [jobType, idempotencyKey, JSON.stringify(payload), priority, maxAttempts]
  );

  return { ...rows[0], duplicate: false };
}

/**
 * Claim the next available job using row-level locking (SKIP LOCKED).
 */
async function claimNextJob() {
  await ensureQueueSchema();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, job_type, payload, attempts, max_attempts, idempotency_key
       FROM job_queue
       WHERE status IN ('pending', 'retry')
         AND (retry_at IS NULL OR retry_at <= NOW())
       ORDER BY priority DESC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );

    if (!rows[0]) {
      await client.query('COMMIT');
      return null;
    }

    const job = rows[0];
    await client.query(
      `UPDATE job_queue
       SET status = 'processing', started_at = NOW(), attempts = attempts + 1
       WHERE id = $1`,
      [job.id]
    );

    await client.query('COMMIT');
    return {
      ...job,
      payload: typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function completeJob(jobId, result) {
  await pool.query(
    `UPDATE job_queue
     SET status = 'completed', completed_at = NOW(), result = $2, error = NULL
     WHERE id = $1`,
    [jobId, JSON.stringify(result)]
  );
}

async function failJob(jobId, error, { attempts, maxAttempts } = {}) {
  const shouldRetry = attempts < maxAttempts;

  if (shouldRetry) {
    const retryAt = getRetryAt(attempts - 1);
    await pool.query(
      `UPDATE job_queue
       SET status = 'retry', error = $2, retry_at = $3
       WHERE id = $1`,
      [jobId, error, retryAt]
    );
    return { retried: true, retryAt };
  }

  await pool.query(
    `UPDATE job_queue
     SET status = 'dead_letter', completed_at = NOW(), error = $2
     WHERE id = $1`,
    [jobId, error]
  );
  return { retried: false, deadLetter: true };
}

async function getJob(jobId) {
  await ensureQueueSchema();
  const { rows } = await pool.query(
    `SELECT id, job_type, idempotency_key, payload, status, attempts, max_attempts,
            retry_at, started_at, completed_at, result, error, created_at
     FROM job_queue WHERE id = $1`,
    [jobId]
  );
  if (!rows[0]) return null;
  const job = rows[0];
  job.payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
  job.result = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
  return job;
}

async function getJobsByPayloadField(field, value, limit = 20) {
  await ensureQueueSchema();
  const { rows } = await pool.query(
    `SELECT id, job_type, status, attempts, max_attempts, result, error, created_at, completed_at
     FROM job_queue
     WHERE payload->>$1 = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [field, String(value), limit]
  );
  return rows;
}

async function getQueueStats() {
  await ensureQueueSchema();
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS count
     FROM job_queue
     GROUP BY status`
  );
  const stats = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  return stats;
}

module.exports = {
  JOB_STATUS,
  JOB_TYPES,
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  getJob,
  getJobsByPayloadField,
  getQueueStats,
};
