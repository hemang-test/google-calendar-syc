const pool = require('../../../config/db');
const BaseCalendarProvider = require('./BaseCalendarProvider');
const {
  syncAppleCalendarEvents,
  createAppleEvent,
  updateAppleEvent,
  ensureAppleSchema,
} = require('../../appleCalendarService');

class AppleCalendarProvider extends BaseCalendarProvider {
  constructor() {
    super('apple', 'Apple iCloud');
  }

  async isConnected(userId) {
    await ensureAppleSchema();
    const { rows } = await pool.query(
      `SELECT apple_icloud_email, apple_app_password
       FROM users WHERE id = $1`,
      [userId]
    );
    const user = rows[0];
    if (!user) return false;
    const email = user.apple_icloud_email || process.env.APPLE_ICLOUD_EMAIL;
    const password = user.apple_app_password || process.env.APPLE_APP_PASSWORD;
    return Boolean(email && password);
  }

  async pullChanges(userId) {
    return syncAppleCalendarEvents(userId);
  }

  async pushChange(userId, change) {
    const { type, event } = change;
    const payload = {
      summary: event.summary,
      description: event.description,
      start: event.startTime,
      end: event.endTime,
      calendarId: event.calendarId,
    };

    if (type === 'create') {
      return createAppleEvent(userId, payload, event.calendarId);
    }
    return updateAppleEvent(userId, event.externalId, payload, {
      calendarId: event.calendarId,
    });
  }

  async listLocalEvents(userId, options = {}) {
    await ensureAppleSchema();
    let query = `
      SELECT apple_event_uid, calendar_id, summary, description,
             start_time, end_time, status, etag, raw_data, updated_at
      FROM apple_calendar_events
      WHERE user_id = $1 AND status != 'cancelled'
    `;
    const params = [userId];

    if (options.from) {
      query += ` AND start_time >= $${params.length + 1}`;
      params.push(options.from);
    }
    if (options.to) {
      query += ` AND end_time <= $${params.length + 1}`;
      params.push(options.to);
    }

    const { rows } = await pool.query(query, params);
    return rows.map((row) => this.normalizeEvent(row));
  }

  normalizeEvent(row) {
    const raw = typeof row.raw_data === 'string'
      ? JSON.parse(row.raw_data)
      : (row.raw_data || {});

    return {
      provider: this.id,
      externalId: row.apple_event_uid,
      calendarId: row.calendar_id,
      summary: row.summary || '',
      description: row.description || null,
      startTime: row.start_time ? new Date(row.start_time).toISOString() : null,
      endTime: row.end_time ? new Date(row.end_time).toISOString() : null,
      status: row.status || 'confirmed',
      version: row.etag || null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      raw,
    };
  }
}

module.exports = AppleCalendarProvider;
