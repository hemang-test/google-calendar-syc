const { google } = require('googleapis');
const { oauth2Client } = require('../config/google');
const pool = require('../config/db');

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

/**
 * Full sync (first time) or incremental sync (subsequent times)
 * Google recommends incremental sync using nextSyncToken
 */
async function syncCalendarEvents(userId, calendarId = 'primary') {
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

    // Upsert each event into DB
    for (const event of events) {
      if (event.status === 'cancelled') {
        // Mark deleted events
        await pool.query(`
          UPDATE calendar_events SET status = 'cancelled', updated_at = NOW()
          WHERE user_id = $1 AND google_event_id = $2
        `, [userId, event.id]);
      } else {
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
        totalSynced++;
      }
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

module.exports = { syncCalendarEvents };