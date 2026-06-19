require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const pool = require('./config/db');
const authRoutes = require('./routes/auth');
const calendarRoutes = require('./routes/calendar');
const cron = require('node-cron');
const { syncCalendarEvents } = require('./services/calendarService');

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

// Runs every 5 minutes
cron.schedule('*/5 * * * *', async () => {
    console.log('⏰ Running scheduled sync...');
  
    // Sync all users in DB
    const { rows: users } = await pool.query('SELECT id FROM users');
    for (const user of users) {
      await syncCalendarEvents(user.id);
      console.log(`✅ Synced user ${user.id}`);
    }
  });

app.use('/auth', authRoutes);
app.use('/calendar', calendarRoutes);

app.get('/', (req, res) => {
  res.send(`
    <h2>Google Calendar Sync Demo</h2>
    <a href="/auth/google">Login with Google</a>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));