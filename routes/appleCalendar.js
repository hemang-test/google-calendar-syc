const express = require('express');
const {
  connectAppleCalendar,
  fetchAppleCalendars,
  syncAppleCalendarEvents,
  getSyncedAppleEvents,
} = require('../services/appleCalendarService');

const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/google first.' });
  }
  next();
}

router.post('/connect', requireLogin, async (req, res) => {
  try {
    const result = await connectAppleCalendar(req.session.userId, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Apple connect error:', err);
    res.status(400).json({ error: err.message });
  }
});

router.get('/calendars', requireLogin, async (req, res) => {
  try {
    const calendars = await fetchAppleCalendars(req.session.userId);
    res.json({ success: true, calendars, count: calendars.length });
  } catch (err) {
    console.error('Apple calendars fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sync', requireLogin, async (req, res) => {
  try {
    const result = await syncAppleCalendarEvents(req.session.userId);
    res.json({
      success: true,
      message: `Synced ${result.totalSynced} Apple events across ${result.calendars} calendars`,
      ...result,
    });
  } catch (err) {
    console.error('Apple sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/events', requireLogin, async (req, res) => {
  try {
    const events = await getSyncedAppleEvents(req.session.userId, req.query);
    res.json({ success: true, events, count: events.length });
  } catch (err) {
    console.error('Apple events query error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
