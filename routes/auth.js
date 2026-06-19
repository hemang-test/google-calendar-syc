const express = require('express');
const router = express.Router();
const { oauth2Client, SCOPES } = require('../config/google');
const { google } = require('googleapis');
const pool = require('../config/db');

// Step 1: Redirect user to Google login
router.get('/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',   // needed to get refresh_token
    prompt: 'consent',         // force consent screen so refresh_token is always returned
    scope: SCOPES,
  });
  res.redirect(authUrl);
});

// Step 2: Google redirects back here with ?code=...
router.get('/google/callback', async (req, res) => {
  const { code } = req.query;

  try {
    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Fetch user profile
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    // Upsert user in DB
    const result = await pool.query(`
      INSERT INTO users (google_id, email, name, access_token, refresh_token, token_expiry)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (google_id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = COALESCE(EXCLUDED.refresh_token, users.refresh_token),
        token_expiry = EXCLUDED.token_expiry,
        name = EXCLUDED.name
      RETURNING *
    `, [
      profile.id,
      profile.email,
      profile.name,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    ]);

    // Save user ID in session
    req.session.userId = result.rows[0].id;
    res.redirect('/calendar/sync');

  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;