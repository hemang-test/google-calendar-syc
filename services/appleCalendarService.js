const { createDAVClient } = require('tsdav');
const pool = require('../config/db');

const DEFAULT_SERVER_URL = 'https://caldav.icloud.com';

let schemaReady = false;

async function ensureAppleSchema() {
  if (schemaReady) return;

  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS apple_icloud_email VARCHAR(255),
      ADD COLUMN IF NOT EXISTS apple_app_password TEXT,
      ADD COLUMN IF NOT EXISTS apple_server_url TEXT DEFAULT '${DEFAULT_SERVER_URL}'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS apple_calendar_sync_state (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      calendar_id TEXT NOT NULL,
      last_synced_at TIMESTAMPTZ,
      sync_token TEXT,
      ctag TEXT,
      UNIQUE (user_id, calendar_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS apple_calendar_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      calendar_id TEXT NOT NULL,
      apple_event_uid TEXT NOT NULL,
      etag TEXT,
      summary TEXT,
      description TEXT,
      start_time TIMESTAMPTZ,
      end_time TIMESTAMPTZ,
      status VARCHAR(50) DEFAULT 'confirmed',
      raw_data JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, calendar_id, apple_event_uid)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_apple_events_user_status_start
    ON apple_calendar_events (user_id, status, start_time)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_apple_events_user_calendar_uid
    ON apple_calendar_events (user_id, calendar_id, apple_event_uid)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_apple_sync_state_user_calendar
    ON apple_calendar_sync_state (user_id, calendar_id)
  `);

  schemaReady = true;
}

function parseICalDateTime(rawValue) {
  if (!rawValue) return null;

  const value = rawValue.trim();
  if (/^\d{8}$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6)) - 1;
    const day = Number(value.slice(6, 8));
    return new Date(Date.UTC(year, month, day)).toISOString();
  }

  const normalized = value.endsWith('Z') ? value : `${value}Z`;
  const compactMatch = normalized.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compactMatch) {
    const [, y, m, d, h, mm, s] = compactMatch;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(mm), Number(s))).toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function extractField(icalData, key) {
  if (!icalData) return null;
  const regex = new RegExp(`^${key}(?:;[^:]+)?:([\\s\\S]*?)(?:\\r?\\n[^ \\t]|$)`, 'm');
  const match = icalData.match(regex);
  if (!match) return null;

  return match[1]
    .replace(/\r?\n[ \t]/g, '')
    .trim();
}

function mapCalendarObject(calendar, object) {
  const ical = object.data || '';
  const uid = extractField(ical, 'UID') || object.url;
  const summary = extractField(ical, 'SUMMARY') || '(No title)';
  const description = extractField(ical, 'DESCRIPTION');
  const dtStart = parseICalDateTime(extractField(ical, 'DTSTART'));
  const dtEnd = parseICalDateTime(extractField(ical, 'DTEND'));
  const status = (extractField(ical, 'STATUS') || 'CONFIRMED').toLowerCase();

  return {
    calendarId: calendar.url || calendar.href || calendar.displayName || 'default',
    uid,
    etag: object.etag || null,
    summary,
    description,
    startTime: dtStart,
    endTime: dtEnd,
    status: status === 'cancelled' ? 'cancelled' : 'confirmed',
    rawData: {
      calendar,
      calendarObject: object,
      ical,
    },
  };
}

async function getAppleCredentialsForUser(userId) {
  await ensureAppleSchema();

  const { rows } = await pool.query(
    `SELECT apple_icloud_email, apple_app_password, apple_server_url
     FROM users WHERE id = $1`,
    [userId]
  );
  const user = rows[0];

  if (!user) {
    throw new Error('User not found');
  }

  const email = user.apple_icloud_email || process.env.APPLE_ICLOUD_EMAIL;
  const appPassword = user.apple_app_password || process.env.APPLE_APP_PASSWORD;
  const serverUrl = user.apple_server_url || process.env.APPLE_SERVER_URL || DEFAULT_SERVER_URL;

  if (!email || !appPassword) {
    throw new Error('Apple Calendar is not connected. Set Apple credentials first.');
  }

  return { email, appPassword, serverUrl };
}

async function connectAppleCalendar(userId, { email, appPassword, serverUrl }) {
  await ensureAppleSchema();
  if (!email || !appPassword) {
    throw new Error('email and appPassword are required');
  }

  await pool.query(
    `UPDATE users
      SET apple_icloud_email = $1,
          apple_app_password = $2,
          apple_server_url = COALESCE($3, apple_server_url, $4)
     WHERE id = $5`,
    [email, appPassword, serverUrl || null, DEFAULT_SERVER_URL, userId]
  );

  return { connected: true, email, serverUrl: serverUrl || DEFAULT_SERVER_URL };
}

async function getAppleClient(userId) {
  const creds = await getAppleCredentialsForUser(userId);

  return createDAVClient({
    serverUrl: creds.serverUrl,
    credentials: {
      username: creds.email,
      password: creds.appPassword,
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
}

async function fetchAppleCalendars(userId) {
  const client = await getAppleClient(userId);
  const calendars = await client.fetchCalendars();
  return calendars.map((cal) => ({
    id: cal.url || cal.href,
    displayName: cal.displayName || cal.description || 'Apple Calendar',
    url: cal.url || cal.href,
    ctag: cal.ctag || null,
    syncToken: cal.syncToken || null,
  }));
}

async function upsertAppleEvent(userId, event) {
  await pool.query(
    `INSERT INTO apple_calendar_events
      (user_id, calendar_id, apple_event_uid, etag, summary, description,
       start_time, end_time, status, raw_data, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (user_id, calendar_id, apple_event_uid) DO UPDATE SET
       etag = EXCLUDED.etag,
       summary = EXCLUDED.summary,
       description = EXCLUDED.description,
       start_time = EXCLUDED.start_time,
       end_time = EXCLUDED.end_time,
       status = EXCLUDED.status,
       raw_data = EXCLUDED.raw_data,
       updated_at = NOW()`,
    [
      userId,
      event.calendarId,
      event.uid,
      event.etag,
      event.summary,
      event.description,
      event.startTime,
      event.endTime,
      event.status,
      JSON.stringify(event.rawData),
    ]
  );
}

async function markMissingEventsCancelled(userId, calendarId, activeUids) {
  if (!activeUids.length) {
    await pool.query(
      `UPDATE apple_calendar_events
       SET status = 'cancelled', updated_at = NOW()
       WHERE user_id = $1 AND calendar_id = $2 AND status != 'cancelled'`,
      [userId, calendarId]
    );
    return;
  }

  await pool.query(
    `UPDATE apple_calendar_events
     SET status = 'cancelled', updated_at = NOW()
     WHERE user_id = $1
       AND calendar_id = $2
       AND status != 'cancelled'
       AND NOT (apple_event_uid = ANY($3::text[]))`,
    [userId, calendarId, activeUids]
  );
}

async function syncAppleCalendarEvents(userId) {
  await ensureAppleSchema();
  const client = await getAppleClient(userId);
  const calendars = await client.fetchCalendars();
  let totalSynced = 0;

  for (const calendar of calendars) {
    const calendarId = calendar.url || calendar.href || calendar.displayName || 'default';
    const objects = await client.fetchCalendarObjects({ calendar });
    const activeUids = [];

    for (const object of objects) {
      const mapped = mapCalendarObject(calendar, object);
      activeUids.push(mapped.uid);
      await upsertAppleEvent(userId, mapped);
      if (mapped.status !== 'cancelled') totalSynced += 1;
    }

    await markMissingEventsCancelled(userId, calendarId, activeUids);

    await pool.query(
      `INSERT INTO apple_calendar_sync_state (user_id, calendar_id, last_synced_at, sync_token, ctag)
       VALUES ($1, $2, NOW(), $3, $4)
       ON CONFLICT (user_id, calendar_id) DO UPDATE SET
         last_synced_at = NOW(),
         sync_token = EXCLUDED.sync_token,
         ctag = EXCLUDED.ctag`,
      [userId, calendarId, calendar.syncToken || null, calendar.ctag || null]
    );
  }

  return { totalSynced, calendars: calendars.length };
}

async function getSyncedAppleEvents(userId, { from, to }) {
  await ensureAppleSchema();
  let query = `
    SELECT id, calendar_id, apple_event_uid, summary, description, start_time, end_time, status, raw_data
    FROM apple_calendar_events
    WHERE user_id = $1 AND status != 'cancelled'
  `;
  const params = [userId];

  if (from) {
    query += ` AND start_time >= $${params.length + 1}`;
    params.push(from);
  }
  if (to) {
    query += ` AND end_time <= $${params.length + 1}`;
    params.push(to);
  }

  query += ' ORDER BY start_time ASC';
  const { rows } = await pool.query(query, params);
  return rows;
}

module.exports = {
  ensureAppleSchema,
  connectAppleCalendar,
  fetchAppleCalendars,
  syncAppleCalendarEvents,
  getSyncedAppleEvents,
};
