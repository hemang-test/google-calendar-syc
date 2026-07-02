const pool = require('../../config/db');

let schemaReady = false;

const DEFAULT_TTL_HOURS = 24;

async function ensureIdempotencySchema() {
  if (schemaReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      request_method TEXT NOT NULL,
      request_path TEXT NOT NULL,
      request_hash TEXT,
      response_status INTEGER,
      response_body JSONB,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, idempotency_key)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires
    ON idempotency_keys (expires_at)
  `);

  schemaReady = true;
}

function getTtlHours() {
  return parseInt(process.env.IDEMPOTENCY_TTL_HOURS || String(DEFAULT_TTL_HOURS), 10);
}

function hashRequestBody(body) {
  const crypto = require('crypto');
  const normalized = JSON.stringify(body || {});
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Look up a stored idempotent response. Returns null if not found or expired.
 */
async function findIdempotentResponse(userId, idempotencyKey) {
  await ensureIdempotencySchema();

  const { rows } = await pool.query(
    `SELECT response_status, response_body, request_method, request_path, request_hash
     FROM idempotency_keys
     WHERE user_id = $1 AND idempotency_key = $2 AND expires_at > NOW()`,
    [userId, idempotencyKey]
  );

  return rows[0] || null;
}

/**
 * Store the response for an idempotent request.
 */
async function storeIdempotentResponse(userId, idempotencyKey, {
  method, path, requestHash, status, body,
}) {
  await ensureIdempotencySchema();

  const ttlHours = getTtlHours();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO idempotency_keys
       (user_id, idempotency_key, request_method, request_path, request_hash,
        response_status, response_body, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, idempotency_key) DO UPDATE SET
       response_status = EXCLUDED.response_status,
       response_body = EXCLUDED.response_body,
       expires_at = EXCLUDED.expires_at`,
    [userId, idempotencyKey, method, path, requestHash, status, JSON.stringify(body), expiresAt]
  );
}

/**
 * Reserve an idempotency key while processing (prevents concurrent duplicates).
 */
async function reserveIdempotencyKey(userId, idempotencyKey, { method, path, requestHash }) {
  await ensureIdempotencySchema();

  const ttlHours = getTtlHours();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  try {
    await pool.query(
      `INSERT INTO idempotency_keys
         (user_id, idempotency_key, request_method, request_path, request_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, idempotencyKey, method, path, requestHash, expiresAt]
    );
    return { reserved: true };
  } catch (err) {
    if (err.code !== '23505') throw err;

    const existing = await findIdempotentResponse(userId, idempotencyKey);
    if (!existing) {
      return { reserved: false, inProgress: true };
    }

    if (existing.request_hash && existing.request_hash !== requestHash) {
      const error = new Error('Idempotency key was already used with a different request body');
      error.code = 'IDEMPOTENCY_MISMATCH';
      throw error;
    }

    if (existing.response_status) {
      return {
        reserved: false,
        cached: true,
        status: existing.response_status,
        body: typeof existing.response_body === 'string'
          ? JSON.parse(existing.response_body)
          : existing.response_body,
      };
    }

    return { reserved: false, inProgress: true };
  }
}

module.exports = {
  ensureIdempotencySchema,
  findIdempotentResponse,
  storeIdempotentResponse,
  reserveIdempotencyKey,
  hashRequestBody,
};
