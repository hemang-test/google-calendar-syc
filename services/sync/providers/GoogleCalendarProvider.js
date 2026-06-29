const pool = require('../../../config/db');
const BaseCalendarProvider = require('./BaseCalendarProvider');
const {
  syncCalendarEvents,
  createEvent,
  updateEvent,
} = require('../../calendarService');

const DEFAULT_CALENDAR_ID = 'primary';

class GoogleCalendarProvider extends BaseCalendarProvider {
  constructor() {
    super('google', 'Google Calendar');
  }

  async isConnected(userId) {
    const { rows } = await pool.query(
      'SELECT access_token FROM users WHERE id = $1',
      [userId]
    );
    return Boolean(rows[0]?.access_token);
  }

  async pullChanges(userId, options = {}) {
    const calendarId = options.calendarId || DEFAULT_CALENDAR_ID;
    return syncCalendarEvents(userId, calendarId);
  }

  async pushChange(userId, change) {
    const { type, event } = change;
    const calendarId = event.calendarId || DEFAULT_CALENDAR_ID;
    const payload = {
      summary: event.summary,
      description: event.description,
      start: event.startTime,
      end: event.endTime,
      calendarId,
    };

    if (type === 'create') {
      return createEvent(userId, payload, calendarId);
    }
    return updateEvent(userId, event.externalId, payload, { calendarId });
  }

  async listLocalEvents(userId, options = {}) {
    let query = `
      SELECT google_event_id, calendar_id, summary, description,
             start_time, end_time, status, raw_data, updated_at
      FROM calendar_events
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
      externalId: row.google_event_id,
      calendarId: row.calendar_id || DEFAULT_CALENDAR_ID,
      summary: row.summary || '',
      description: row.description || null,
      startTime: row.start_time ? new Date(row.start_time).toISOString() : null,
      endTime: row.end_time ? new Date(row.end_time).toISOString() : null,
      status: row.status || 'confirmed',
      version: raw.updated || null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      raw,
    };
  }
}

module.exports = GoogleCalendarProvider;
