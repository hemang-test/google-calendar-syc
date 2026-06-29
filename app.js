require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const pool = require('./config/db');
const authRoutes = require('./routes/auth');
const calendarRoutes = require('./routes/calendar');
const appleCalendarRoutes = require('./routes/appleCalendar');
const syncRoutes = require('./routes/sync');
const { startSyncScheduler } = require('./services/sync/syncJobRunner');

const app = express();
app.use(express.json());

// Sessions stored in PostgreSQL
app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }, // 1 day
}));

// Background sync scheduler (default: every 5 minutes)
startSyncScheduler();

app.use('/auth', authRoutes);
app.use('/calendar', calendarRoutes);
app.use('/apple-calendar', appleCalendarRoutes);
app.use('/sync', syncRoutes);

app.get('/', (req, res) => {
  res.send(`
    <h2>Google Calendar Sync Demo</h2>
    <a href="/auth/google">Login with Google</a>
    <p>Sync API: POST /sync, GET /sync/status, GET /sync/conflicts</p>
    <p>Apple Calendar: /apple-calendar/connect, /apple-calendar/calendars, /apple-calendar/sync, /apple-calendar/events</p>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));