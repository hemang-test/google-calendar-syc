const { google } = require('googleapis');
const { oauth2Client } = require('../config/google');
const pool = require('../config/db');

const DEFAULT_CALENDAR_ID = 'primary';
let googleIndexesReady = false;

async function ensureGoogleSyncIndexes() {
  if (googleIndexesReady) return;
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_calendar_events_user_status_start
    ON calendar_events (user_id, status, start_time)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_calendar_events_user_google_event
    ON calendar_events (user_id, google_event_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sync_state_user_calendar
    ON sync_state (user_id, calendar_id)
  `);
  googleIndexesReady = true;
}

/**
 * Build an authenticated OAuth client for a user
 */
async function getAuthClientForUser(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE id = $1', [userId]
  );
  const user = rows[0];
  if (!user) throw new Error('User not found');

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  client.setCredentials({
    access_token: user.access_token,
    refresh_token: user.refresh_token,
    expiry_date: user.token_expiry ? new Date(user.token_expiry).getTime() : null,
  });

  // Auto-refresh: save new tokens to DB if refreshed
  client.on('tokens', async (tokens) => {
    await pool.query(`
      UPDATE users SET access_token = $1, token_expiry = $2 WHERE id = $3
    `, [tokens.access_token, new Date(tokens.expiry_date), userId]);
    console.log('🔄 Tokens refreshed for user', userId);
  });

  return client;
}

async function getCalendarClient(userId) {
  const authClient = await getAuthClientForUser(userId);
  return google.calendar({ version: 'v3', auth: authClient });
}

function buildDateTimeField(value, timeZone = 'UTC') {
  if (!value) return undefined;
  if (value.includes('T')) {
    return { dateTime: value, timeZone };
  }
  return { date: value };
}

function isInstanceEventId(eventId) {
  return /_\d{8}(T\d{6}Z)?$/.test(eventId);
}

function getMasterEventId(eventId) {
  if (!isInstanceEventId(eventId)) return eventId;
  return eventId.replace(/_\d{8}(T\d{6}Z)?$/, '');
}

function formatRruleUntil(date) {
  const d = new Date(date);
  d.setUTCSeconds(d.getUTCSeconds() - 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function setRruleUntil(recurrence, until) {
  if (!recurrence?.length) return recurrence;
  return recurrence.map((rule) => {
    if (!rule.startsWith('RRULE:')) return rule;
    const withoutUntil = rule.replace(/;UNTIL=[^;]+/i, '');
    return `${withoutUntil};UNTIL=${until}`;
  });
}

function buildEventRequestBody({ summary, description, start, end, timeZone, recurrence, location }) {
  const body = {};
  if (summary !== undefined) body.summary = summary;
  if (description !== undefined) body.description = description;
  if (location !== undefined) body.location = location;
  if (start !== undefined) body.start = buildDateTimeField(start, timeZone);
  if (end !== undefined) body.end = buildDateTimeField(end, timeZone);
  if (recurrence !== undefined) body.recurrence = recurrence;
  return body;
}

/**
 * Persist a Google event object into the local DB
 */
async function upsertEventToDb(userId, calendarId, event) {
  if (event.status === 'cancelled') {
    await pool.query(`
      UPDATE calendar_events SET status = 'cancelled', updated_at = NOW()
      WHERE user_id = $1 AND google_event_id = $2
    `, [userId, event.id]);
    return;
  }

  await pool.query(`
    INSERT INTO calendar_events
      (user_id, google_event_id, calendar_id, summary, description,
       start_time, end_time, status, raw_data, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    ON CONFLICT (user_id, google_event_id) DO UPDATE SET
      summary = EXCLUDED.summary,
      description = EXCLUDED.description,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      status = EXCLUDED.status,
      raw_data = EXCLUDED.raw_data,
      updated_at = NOW()
  `, [
    userId,
    event.id,
    calendarId,
    event.summary || '(No title)',
    event.description || null,
    event.start?.dateTime || event.start?.date,
    event.end?.dateTime || event.end?.date,
    event.status,
    JSON.stringify(event),
  ]);
}

async function markEventCancelledInDb(userId, eventId) {
  await pool.query(`
    UPDATE calendar_events SET status = 'cancelled', updated_at = NOW()
    WHERE user_id = $1 AND google_event_id = $2
  `, [userId, eventId]);
}

async function getInstanceEvent(calendar, calendarId, masterEventId, instanceStart) {
  let timeMin;
  let timeMax;
  if (instanceStart.includes('T')) {
    const start = new Date(instanceStart);
    timeMin = new Date(start.getTime() - 1000).toISOString();
    timeMax = new Date(start.getTime() + 1000).toISOString();
  } else {
    timeMin = `${instanceStart}T00:00:00Z`;
    timeMax = `${instanceStart}T23:59:59Z`;
  }

  const { data } = await calendar.events.instances({
    calendarId,
    eventId: masterEventId,
    timeMin,
    timeMax,
    maxResults: 1,
  });
  const instance = data.items?.[0];
  if (!instance) throw new Error('Recurring event instance not found for the given start time');
  return instance;
}

async function resolveTargetEvent(calendar, calendarId, eventId, { recurringScope, instanceStart } = {}) {
  if (recurringScope === 'this' && instanceStart && !isInstanceEventId(eventId)) {
    const instance = await getInstanceEvent(calendar, calendarId, eventId, instanceStart);
    return { eventId: instance.id, event: instance };
  }

  const { data: event } = await calendar.events.get({ calendarId, eventId });
  return { eventId: event.id, event };
}

async function truncateRecurringSeriesBefore(calendar, calendarId, instanceEvent) {
  const masterId = instanceEvent.recurringEventId || getMasterEventId(instanceEvent.id);
  const { data: master } = await calendar.events.get({ calendarId, eventId: masterId });
  const instanceStart = instanceEvent.start?.dateTime || instanceEvent.start?.date;
  const until = formatRruleUntil(instanceStart);

  const { data: updated } = await calendar.events.patch({
    calendarId,
    eventId: masterId,
    requestBody: { recurrence: setRruleUntil(master.recurrence, until) },
  });

  return { masterId, updatedMaster: updated };
}

/**
 * Create a calendar event (supports recurring via recurrence RRULE array)
 */
async function createEvent(userId, eventData, calendarId = DEFAULT_CALENDAR_ID) {
  const calendar = await getCalendarClient(userId);
  const { summary, description, start, end, timeZone, recurrence, location } = eventData;

  if (!summary || !start || !end) {
    throw new Error('summary, start, and end are required');
  }

  const requestBody = buildEventRequestBody({
    summary,
    description,
    start,
    end,
    timeZone,
    recurrence,
    location,
  });

  const { data: event } = await calendar.events.insert({
    calendarId,
    requestBody,
  });

  await upsertEventToDb(userId, calendarId, event);

  // Recurring masters are expanded into instances during sync; trigger incremental refresh
  if (recurrence?.length) {
    await syncCalendarEvents(userId, calendarId);
  }

  return event;
}

/**
 * Update a calendar event.
 * recurringScope: 'all' (default) | 'this' | 'future'
 * instanceStart: required when recurringScope is 'this' or 'future' and eventId is the master id
 */
async function updateEvent(userId, eventId, eventData, options = {}) {
  const calendarId = options.calendarId || DEFAULT_CALENDAR_ID;
  const recurringScope = options.recurringScope || 'all';
  const calendar = await getCalendarClient(userId);

  const requestBody = buildEventRequestBody(eventData);
  if (!Object.keys(requestBody).length) {
    throw new Error('At least one field to update is required');
  }

  let updatedEvent;

  if (recurringScope === 'this') {
    const { eventId: targetId } = await resolveTargetEvent(calendar, calendarId, eventId, options);
    const { data } = await calendar.events.patch({ calendarId, eventId: targetId, requestBody });
    updatedEvent = data;
    await upsertEventToDb(userId, calendarId, updatedEvent);
  } else if (recurringScope === 'future') {
    const { event: instance } = await resolveTargetEvent(calendar, calendarId, eventId, options);
    const { masterId, updatedMaster } = await truncateRecurringSeriesBefore(calendar, calendarId, instance);
    await upsertEventToDb(userId, calendarId, updatedMaster);

    const newSeriesBody = {
      ...buildEventRequestBody({
        summary: eventData.summary ?? instance.summary,
        description: eventData.description ?? instance.description,
        start: eventData.start ?? (instance.start?.dateTime || instance.start?.date),
        end: eventData.end ?? (instance.end?.dateTime || instance.end?.date),
        timeZone: eventData.timeZone,
        location: eventData.location,
        recurrence: eventData.recurrence,
      }),
    };

    if (!newSeriesBody.recurrence) {
      const master = await calendar.events.get({ calendarId, eventId: masterId });
      newSeriesBody.recurrence = master.data.recurrence;
    }

    const { data: newSeries } = await calendar.events.insert({
      calendarId,
      requestBody: newSeriesBody,
    });
    updatedEvent = newSeries;
    await syncCalendarEvents(userId, calendarId);
  } else {
    const masterId = getMasterEventId(eventId);
    const { data } = await calendar.events.patch({ calendarId, eventId: masterId, requestBody });
    updatedEvent = data;
    await syncCalendarEvents(userId, calendarId);
  }

  return updatedEvent;
}

/**
 * Delete a calendar event.
 * recurringScope: 'all' (default) | 'this' | 'future'
 */
async function deleteEvent(userId, eventId, options = {}) {
  const calendarId = options.calendarId || DEFAULT_CALENDAR_ID;
  const recurringScope = options.recurringScope || 'all';
  const calendar = await getCalendarClient(userId);

  if (recurringScope === 'this') {
    const { eventId: targetId } = await resolveTargetEvent(calendar, calendarId, eventId, options);
    await calendar.events.delete({ calendarId, eventId: targetId });
    await markEventCancelledInDb(userId, targetId);
    return { deleted: targetId, scope: 'this' };
  }

  if (recurringScope === 'future') {
    const { event: instance } = await resolveTargetEvent(calendar, calendarId, eventId, options);
    const { updatedMaster } = await truncateRecurringSeriesBefore(calendar, calendarId, instance);
    await upsertEventToDb(userId, calendarId, updatedMaster);
    await syncCalendarEvents(userId, calendarId);
    return { deleted: 'future_instances', scope: 'future', masterId: updatedMaster.id };
  }

  const masterId = getMasterEventId(eventId);
  await calendar.events.delete({ calendarId, eventId: masterId });
  await markEventCancelledInDb(userId, masterId);
  await syncCalendarEvents(userId, calendarId);
  return { deleted: masterId, scope: 'all' };
}

/**
 * Get a single event from Google Calendar
 */
async function getEvent(userId, eventId, calendarId = DEFAULT_CALENDAR_ID) {
  const calendar = await getCalendarClient(userId);
  const { data: event } = await calendar.events.get({ calendarId, eventId });
  return event;
}

/**
 * Full sync (first time) or incremental sync (subsequent times)
 * Google recommends incremental sync using nextSyncToken
 */
async function syncCalendarEvents(userId, calendarId = DEFAULT_CALENDAR_ID) {
  await ensureGoogleSyncIndexes();
  const authClient = await getAuthClientForUser(userId);
  const calendar = google.calendar({ version: 'v3', auth: authClient });

  // Check if we have a syncToken from a previous sync
  const stateResult = await pool.query(
    'SELECT next_sync_token FROM sync_state WHERE user_id = $1 AND calendar_id = $2',
    [userId, calendarId]
  );

  let nextPageToken = null;
  let syncToken = stateResult.rows[0]?.next_sync_token || null;
  let totalSynced = 0;

  do {
    const params = {
      calendarId,
      maxResults: 250,
      singleEvents: true,
      pageToken: nextPageToken || undefined,
    };

    if (syncToken) {
      // INCREMENTAL SYNC: only get changes since last sync
      params.syncToken = syncToken;
    } else {
      // FULL SYNC: get events from last 30 days onward
      params.timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      params.orderBy = 'startTime';
    }

    let response;
    try {
      response = await calendar.events.list(params);
    } catch (err) {
      // syncToken expired → fall back to full sync
      if (err.code === 410) {
        console.warn('⚠️ Sync token expired, performing full sync');
        await pool.query(
          'DELETE FROM sync_state WHERE user_id = $1 AND calendar_id = $2',
          [userId, calendarId]
        );
        return syncCalendarEvents(userId, calendarId); // recursive full sync
      }
      throw err;
    }

    const events = response.data.items || [];
    nextPageToken = response.data.nextPageToken;

    for (const event of events) {
      await upsertEventToDb(userId, calendarId, event);
      if (event.status !== 'cancelled') totalSynced++;
    }

    // When last page, save the nextSyncToken for future incremental syncs
    if (!nextPageToken && response.data.nextSyncToken) {
      await pool.query(`
        INSERT INTO sync_state (user_id, calendar_id, next_sync_token, last_synced_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id, calendar_id) DO UPDATE SET
          next_sync_token = EXCLUDED.next_sync_token,
          last_synced_at = NOW()
      `, [userId, calendarId, response.data.nextSyncToken]);
    }

  } while (nextPageToken); // paginate through all results

  return { totalSynced };
}

module.exports = {
  syncCalendarEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getEvent,
  getAuthClientForUser,
};