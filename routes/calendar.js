const express = require('express');
const router = express.Router();
const {
  syncCalendarEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getEvent,
} = require('../services/calendarService');
const { checkFreeBusy } = require('../services/freebusyService');
const pool = require('../config/db');

// Auth middleware
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/google' });
  }
  next();
}

function formatEventRow(row) {
  const raw = typeof row.raw_data === 'string'
    ? JSON.parse(row.raw_data)
    : (row.raw_data || {});
  return {
    id: row.id,
    google_event_id: row.google_event_id,
    summary: row.summary,
    description: row.description,
    start_time: row.start_time,
    end_time: row.end_time,
    status: row.status,
    recurrence: raw.recurrence || null,
    recurring_event_id: raw.recurringEventId || null,
    is_recurring_instance: Boolean(raw.recurringEventId),
  };
}

// Trigger a sync
router.get('/sync', requireLogin, async (req, res) => {
  try {
    const result = await syncCalendarEvents(req.session.userId);
    res.json({ success: true, message: `Synced ${result.totalSynced} events` });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get synced events from local DB
router.get('/events', requireLogin, async (req, res) => {
  const { from, to } = req.query;

  let query = `
    SELECT id, google_event_id, summary, description, start_time, end_time, status, raw_data
    FROM calendar_events
    WHERE user_id = $1 AND status != 'cancelled'
  `;
  const params = [req.session.userId];

  if (from) { query += ` AND start_time >= $${params.length + 1}`; params.push(from); }
  if (to)   { query += ` AND end_time <= $${params.length + 1}`; params.push(to); }

  query += ' ORDER BY start_time ASC';

  const { rows } = await pool.query(query, params);
  res.json({ events: rows.map(formatEventRow), count: rows.length });
});

// Get a single event from Google Calendar
router.get('/events/:eventId', requireLogin, async (req, res) => {
  try {
    const event = await getEvent(req.session.userId, req.params.eventId);
    res.json({ event });
  } catch (err) {
    console.error('Get event error:', err);
    res.status(err.code === 404 ? 404 : 500).json({ error: err.message });
  }
});

// Create a calendar event (supports recurrence via RRULE array)
router.post('/events', requireLogin, async (req, res) => {
  try {
    const event = await createEvent(req.session.userId, req.body, req.body.calendarId);
    res.status(201).json({ success: true, event });
  } catch (err) {
    console.error('Create event error:', err);
    res.status(400).json({ error: err.message });
  }
});

// Update a calendar event
// Query: recurringScope = all | this | future, instanceStart (ISO) for this/future on a series
router.put('/events/:eventId', requireLogin, async (req, res) => {
  try {
    const { recurringScope, instanceStart, calendarId, ...eventData } = req.body;
    const event = await updateEvent(req.session.userId, req.params.eventId, eventData, {
      recurringScope,
      instanceStart,
      calendarId,
    });
    res.json({ success: true, event });
  } catch (err) {
    console.error('Update event error:', err);
    res.status(400).json({ error: err.message });
  }
});

// Delete a calendar event
// Query: recurringScope = all | this | future, instanceStart (ISO) for this/future on a series
router.delete('/events/:eventId', requireLogin, async (req, res) => {
  try {
    const { recurringScope, instanceStart, calendarId } = req.query;
    const result = await deleteEvent(req.session.userId, req.params.eventId, {
      recurringScope,
      instanceStart,
      calendarId,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Delete event error:', err);
    res.status(400).json({ error: err.message });
  }
});

// FreeBusy check
router.get('/freebusy', requireLogin, async (req, res) => {
  const {
    timeMin = new Date().toISOString(),
    timeMax = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  } = req.query;

  try {
    const result = await checkFreeBusy(req.session.userId, timeMin, timeMax);
    res.json({ timeMin, timeMax, calendars: result });
  } catch (err) {
    console.error('FreeBusy error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;