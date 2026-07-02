const express = require('express');
const {
  syncUser,
  getUnresolvedConflicts,
  resolveConflictManually,
  getSyncJobHistory,
  getSyncStatus,
  getConnectedProviders,
} = require('../services/sync/syncService');
const { runSyncJob } = require('../services/sync/syncJobRunner');
const { enqueueJob, JOB_TYPES } = require('../services/queue/jobQueue');
const { notifyUser, WEBHOOK_EVENTS } = require('../services/webhooks/webhookNotifier');
const { idempotencyMiddleware } = require('../middleware/idempotency');
const {
  SYNC_STRATEGIES,
  CONFLICT_STRATEGIES,
  isValidSyncStrategy,
  isValidConflictStrategy,
} = require('../services/sync/syncStrategies');
const { getAllProviders } = require('../services/sync/providers');

const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/google' });
  }
  next();
}

router.use(idempotencyMiddleware({ methods: ['POST'] }));

// GET /sync/status — provider connectivity and last job info
router.get('/status', requireLogin, async (req, res) => {
  try {
    const status = await getSyncStatus(req.session.userId);
    res.json({ success: true, ...status });
  } catch (err) {
    console.error('Sync status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /sync/providers — list registered providers
router.get('/providers', requireLogin, async (req, res) => {
  const providers = getAllProviders().map((p) => ({
    id: p.id,
    displayName: p.displayName,
  }));
  const connected = await getConnectedProviders(req.session.userId);
  res.json({
    success: true,
    providers,
    connected: connected.map((p) => p.id),
  });
});

// POST /sync — trigger sync for the current user
// Body: { syncStrategy, conflictStrategy, providers, async: true }
// Header: Idempotency-Key (optional) — safe to retry without duplicate work
router.post('/', requireLogin, async (req, res) => {
  try {
    const { syncStrategy, conflictStrategy, providers, async: runAsync } = req.body;

    if (syncStrategy && !isValidSyncStrategy(syncStrategy)) {
      return res.status(400).json({
        error: `Invalid syncStrategy. Use: ${Object.values(SYNC_STRATEGIES).join(', ')}`,
      });
    }
    if (conflictStrategy && !isValidConflictStrategy(conflictStrategy)) {
      return res.status(400).json({
        error: `Invalid conflictStrategy. Use: ${Object.values(CONFLICT_STRATEGIES).join(', ')}`,
      });
    }

    const userId = req.session.userId;
    const payload = {
      userId,
      syncStrategy,
      conflictStrategy,
      providers,
      jobType: 'manual',
    };

    if (runAsync) {
      const idempotencyKey = req.idempotencyKey
        || req.headers['idempotency-key']
        || req.headers['Idempotency-Key'];

      const job = await enqueueJob(JOB_TYPES.SYNC_USER, payload, {
        idempotencyKey: idempotencyKey || `sync_user_${userId}_${Date.now()}`,
        priority: 2,
      });

      if (!job.duplicate) {
        notifyUser(userId, WEBHOOK_EVENTS.SYNC_QUEUED, {
          queueJobId: job.id,
          syncStrategy,
        }).catch((err) => console.warn('Webhook notify failed:', err.message));
      }

      return res.status(job.duplicate ? 200 : 202).json({
        success: true,
        async: true,
        queueJobId: job.id,
        status: job.status || 'pending',
        duplicate: job.duplicate || false,
        message: job.duplicate
          ? 'Sync job already queued with this idempotency key'
          : 'Sync job queued for background processing',
      });
    }

    const result = await syncUser(userId, {
      syncStrategy,
      conflictStrategy,
      providers,
      jobType: 'manual',
    });

    res.json({ success: true, async: false, ...result });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /sync/jobs — sync job history
router.get('/jobs', requireLogin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const jobs = await getSyncJobHistory(req.session.userId, limit);
    res.json({ success: true, jobs, count: jobs.length });
  } catch (err) {
    console.error('Sync jobs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /sync/conflicts — unresolved conflicts
router.get('/conflicts', requireLogin, async (req, res) => {
  try {
    const conflicts = await getUnresolvedConflicts(req.session.userId);
    res.json({ success: true, conflicts, count: conflicts.length });
  } catch (err) {
    console.error('Sync conflicts error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /sync/conflicts/:id/resolve — manually resolve a conflict
router.post('/conflicts/:id/resolve', requireLogin, async (req, res) => {
  try {
    const { resolution } = req.body;
    if (!resolution || !isValidConflictStrategy(resolution)) {
      return res.status(400).json({
        error: `resolution is required. Use: ${Object.values(CONFLICT_STRATEGIES).join(', ')}`,
      });
    }

    const result = await resolveConflictManually(
      req.session.userId,
      parseInt(req.params.id, 10),
      resolution
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Resolve conflict error:', err);
    res.status(400).json({ error: err.message });
  }
});

// GET /sync/strategies — list available strategies
router.get('/strategies', (_req, res) => {
  res.json({
    success: true,
    syncStrategies: SYNC_STRATEGIES,
    conflictStrategies: CONFLICT_STRATEGIES,
  });
});

// POST /sync/run-all — enqueue background sync for all users
router.post('/run-all', requireLogin, async (req, res) => {
  try {
    const result = await runSyncJob(req.body);
    res.status(result.duplicate ? 200 : 202).json({ success: true, ...result });
  } catch (err) {
    console.error('Run-all sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
