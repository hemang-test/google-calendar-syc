const express = require('express');
const {
  syncUser,
  getUnresolvedConflicts,
  resolveConflictManually,
  getSyncJobHistory,
  getSyncStatus,
  getConnectedProviders,
} = require('../services/sync/syncService');
const { runSyncJob, isSyncJobRunning } = require('../services/sync/syncJobRunner');
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
// Body: { syncStrategy, conflictStrategy, providers: ['google','apple'] }
router.post('/', requireLogin, async (req, res) => {
  try {
    const { syncStrategy, conflictStrategy, providers } = req.body;

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

    const result = await syncUser(req.session.userId, {
      syncStrategy,
      conflictStrategy,
      providers,
      jobType: 'manual',
    });

    res.json({ success: true, ...result });
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
// Body: { resolution: 'local_wins' | 'source_wins' | 'last_write_wins' }
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

// POST /sync/run-all — admin-style trigger for all users (requires login)
router.post('/run-all', requireLogin, async (req, res) => {
  if (isSyncJobRunning()) {
    return res.status(409).json({ error: 'A sync job is already running' });
  }

  try {
    const result = await runSyncJob(req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Run-all sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
