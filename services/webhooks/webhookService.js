const crypto = require('crypto');
const axios = require('axios');
const pool = require('../../config/db');

let schemaReady = false;

const WEBHOOK_EVENTS = {
  SYNC_COMPLETED: 'sync.completed',
  SYNC_FAILED: 'sync.failed',
  CONFLICT_DETECTED: 'conflict.detected',
  SYNC_QUEUED: 'sync.queued',
};

const ALL_EVENTS = Object.values(WEBHOOK_EVENTS);

async function ensureWebhookSchema() {
  if (schemaReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT[] NOT NULL DEFAULT '{}',
      description TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id SERIAL PRIMARY KEY,
      webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      event_type VARCHAR(50) NOT NULL,
      payload JSONB NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      response_status INTEGER,
      response_body TEXT,
      error TEXT,
      next_retry_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_webhooks_user_active
    ON webhooks (user_id, active)
    WHERE active = TRUE
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status
    ON webhook_deliveries (status, next_retry_at)
    WHERE status IN ('pending', 'retry')
  `);

  schemaReady = true;
}

function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function signPayload(secret, payload, timestamp) {
  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return signature;
}

function isValidEvent(event) {
  return ALL_EVENTS.includes(event);
}

async function registerWebhook(userId, { url, events, description }) {
  await ensureWebhookSchema();

  if (!url || !events?.length) {
    throw new Error('url and events are required');
  }

  const invalidEvents = events.filter((e) => !isValidEvent(e));
  if (invalidEvents.length) {
    throw new Error(`Invalid events: ${invalidEvents.join(', ')}. Valid: ${ALL_EVENTS.join(', ')}`);
  }

  const secret = generateSecret();
  const { rows } = await pool.query(
    `INSERT INTO webhooks (user_id, url, secret, events, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, url, events, description, active, created_at`,
    [userId, url, secret, events, description || null]
  );

  return { ...rows[0], secret };
}

async function listWebhooks(userId) {
  await ensureWebhookSchema();
  const { rows } = await pool.query(
    `SELECT id, url, events, description, active, created_at, updated_at
     FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

async function getWebhook(userId, webhookId) {
  await ensureWebhookSchema();
  const { rows } = await pool.query(
    `SELECT id, url, events, description, active, created_at
     FROM webhooks WHERE id = $1 AND user_id = $2`,
    [webhookId, userId]
  );
  return rows[0] || null;
}

async function deleteWebhook(userId, webhookId) {
  await ensureWebhookSchema();
  const { rowCount } = await pool.query(
    `DELETE FROM webhooks WHERE id = $1 AND user_id = $2`,
    [webhookId, userId]
  );
  if (!rowCount) throw new Error('Webhook not found');
  return { deleted: true };
}

async function toggleWebhook(userId, webhookId, active) {
  await ensureWebhookSchema();
  const { rows } = await pool.query(
    `UPDATE webhooks SET active = $3, updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING id, url, events, active`,
    [webhookId, userId, active]
  );
  if (!rows[0]) throw new Error('Webhook not found');
  return rows[0];
}

async function getActiveWebhooksForEvent(userId, eventType) {
  await ensureWebhookSchema();
  const { rows } = await pool.query(
    `SELECT id, url, secret, events
     FROM webhooks
     WHERE user_id = $1 AND active = TRUE AND $2 = ANY(events)`,
    [userId, eventType]
  );
  return rows;
}

async function createDeliveryRecord(webhookId, eventType, payload) {
  await ensureWebhookSchema();
  const maxAttempts = parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '5', 10);
  const { rows } = await pool.query(
    `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, max_attempts)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [webhookId, eventType, JSON.stringify(payload), maxAttempts]
  );
  return rows[0].id;
}

async function deliverWebhook(webhookId, eventType, data, deliveryId) {
  await ensureWebhookSchema();

  const { rows } = await pool.query(
    `SELECT w.id, w.url, w.secret, w.active
     FROM webhooks w WHERE w.id = $1`,
    [webhookId]
  );
  const webhook = rows[0];
  if (!webhook) throw new Error('Webhook not found');
  if (!webhook.active) throw new Error('Webhook is inactive');

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    id: deliveryId || crypto.randomUUID(),
    event: eventType,
    timestamp,
    data,
  };

  const signature = signPayload(webhook.secret, payload, timestamp);

  let response;
  try {
    response = await axios.post(webhook.url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Timestamp': String(timestamp),
        'X-Webhook-Event': eventType,
        'User-Agent': 'gcal-sync-demo-webhook/1.0',
      },
      timeout: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10),
      validateStatus: (status) => status >= 200 && status < 300,
    });
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data ? JSON.stringify(err.response.data) : null;
    if (deliveryId) {
      await pool.query(
        `UPDATE webhook_deliveries
         SET status = 'failed', attempts = attempts + 1,
             response_status = $2, response_body = $3, error = $4
         WHERE id = $1`,
        [deliveryId, status || null, body, err.message]
      );
    }
    throw err;
  }

  if (deliveryId) {
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'delivered', delivered_at = NOW(), attempts = attempts + 1,
           response_status = $2, response_body = $3
       WHERE id = $1`,
      [deliveryId, response.status, JSON.stringify(response.data).slice(0, 2000)]
    );
  }

  return { delivered: true, status: response.status, webhookId };
}

async function getDeliveryHistory(userId, limit = 20) {
  await ensureWebhookSchema();
  const { rows } = await pool.query(
    `SELECT d.id, d.event_type, d.status, d.attempts, d.response_status,
            d.error, d.delivered_at, d.created_at, w.url
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE w.user_id = $1
     ORDER BY d.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

module.exports = {
  WEBHOOK_EVENTS,
  ALL_EVENTS,
  ensureWebhookSchema,
  registerWebhook,
  listWebhooks,
  getWebhook,
  deleteWebhook,
  toggleWebhook,
  getActiveWebhooksForEvent,
  createDeliveryRecord,
  deliverWebhook,
  getDeliveryHistory,
  signPayload,
};
