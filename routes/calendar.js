const express = require('express');
const router = express.Router();
const { syncCalendarEvents } = require('../services/calendarService');
const { checkFreeBusy } = require('../services/freebusyService');
const pool = require('../config/db');

// Auth middleware
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/google' });
  }
  next();
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
    SELECT id, google_event_id, summary, start_time, end_time, status
    FROM calendar_events
    WHERE user_id = $1 AND status != 'cancelled'
  `;
  const params = [req.session.userId];

  if (from) { query += ` AND start_time >= $${params.length + 1}`; params.push(from); }
  if (to)   { query += ` AND end_time <= $${params.length + 1}`; params.push(to); }

  query += ' ORDER BY start_time ASC';

  const { rows } = await pool.query(query, params);
  res.json({ events: rows, count: rows.length });
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