const express = require('express');
const {
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  toggleWebhook,
  getDeliveryHistory,
  ALL_EVENTS,
} = require('../services/webhooks/webhookService');

const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/google' });
  }
  next();
}

// GET /webhooks/events — list available webhook event types
router.get('/events', requireLogin, (_req, res) => {
  res.json({ success: true, events: ALL_EVENTS });
});

// POST /webhooks — register a webhook endpoint
// Body: { url, events: ['sync.completed', ...], description? }
router.post('/', requireLogin, async (req, res) => {
  try {
    const result = await registerWebhook(req.session.userId, req.body);
    res.status(201).json({
      success: true,
      webhook: result,
      message: 'Save the secret — it is only shown once and used to verify signatures.',
    });
  } catch (err) {
    console.error('Register webhook error:', err);
    res.status(400).json({ error: err.message });
  }
});

// GET /webhooks — list registered webhooks
router.get('/', requireLogin, async (req, res) => {
  try {
    const webhooks = await listWebhooks(req.session.userId);
    res.json({ success: true, webhooks, count: webhooks.length });
  } catch (err) {
    console.error('List webhooks error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /webhooks/:id — remove a webhook
router.delete('/:id', requireLogin, async (req, res) => {
  try {
    const result = await deleteWebhook(req.session.userId, parseInt(req.params.id, 10));
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Delete webhook error:', err);
    res.status(404).json({ error: err.message });
  }
});

// PATCH /webhooks/:id — enable/disable a webhook
// Body: { active: true | false }
router.patch('/:id', requireLogin, async (req, res) => {
  try {
    if (typeof req.body.active !== 'boolean') {
      return res.status(400).json({ error: 'active (boolean) is required' });
    }
    const webhook = await toggleWebhook(
      req.session.userId,
      parseInt(req.params.id, 10),
      req.body.active
    );
    res.json({ success: true, webhook });
  } catch (err) {
    console.error('Toggle webhook error:', err);
    res.status(404).json({ error: err.message });
  }
});

// GET /webhooks/deliveries — delivery history
router.get('/deliveries/history', requireLogin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const deliveries = await getDeliveryHistory(req.session.userId, limit);
    res.json({ success: true, deliveries, count: deliveries.length });
  } catch (err) {
    console.error('Delivery history error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
