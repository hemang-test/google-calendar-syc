require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const pool = require('./config/db');
const authRoutes = require('./routes/auth');
const calendarRoutes = require('./routes/calendar');
const appleCalendarRoutes = require('./routes/appleCalendar');
const syncRoutes = require('./routes/sync');
const webhookRoutes = require('./routes/webhooks');
const queueRoutes = require('./routes/queue');
const { startSyncScheduler } = require('./services/sync/syncJobRunner');
const { startQueueWorker } = require('./services/queue/queueWorker');

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

// Background services
startSyncScheduler();
startQueueWorker();

app.use('/auth', authRoutes);
app.use('/calendar', calendarRoutes);
app.use('/apple-calendar', appleCalendarRoutes);
app.use('/sync', syncRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/queue', queueRoutes);

app.get('/', (req, res) => {
  res.send(`
    <h2>Google Calendar Sync Demo</h2>
    <a href="/auth/google">Login with Google</a>
    <p>Sync API: POST /sync, GET /sync/status, GET /sync/conflicts</p>
    <p>Webhooks: POST /webhooks, GET /webhooks/deliveries/history</p>
    <p>Queue: GET /queue/stats, GET /queue/jobs</p>
    <p>Apple Calendar: /apple-calendar/connect, /apple-calendar/calendars, /apple-calendar/sync, /apple-calendar/events</p>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
