const { google } = require('googleapis');
const pool = require('../config/db');

async function getAuthClientForUser(userId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = rows[0];

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({
    access_token: user.access_token,
    refresh_token: user.refresh_token,
  });
  return client;
}

/**
 * Query FreeBusy API
 * Returns busy time slots for the given time range
 */
async function checkFreeBusy(userId, timeMin, timeMax, calendarIds = ['primary']) {
  const authClient = await getAuthClientForUser(userId);
  const calendar = google.calendar({ version: 'v3', auth: authClient });

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin,   // ISO 8601 e.g. "2025-06-01T00:00:00Z"
      timeMax,   // ISO 8601 e.g. "2025-06-07T23:59:59Z"
      timeZone: 'UTC',
      items: calendarIds.map(id => ({ id })),
    },
  });

  const busySlots = response.data.calendars;

  // Format for easy reading
  const result = {};
  for (const [calId, data] of Object.entries(busySlots)) {
    result[calId] = {
      busy: data.busy || [],       // array of { start, end }
      errors: data.errors || [],
    };
  }

  return result;
}

module.exports = { checkFreeBusy };