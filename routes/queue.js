const express = require('express');
const { getJob, getJobsByPayloadField, getQueueStats } = require('../services/queue/jobQueue');
const { processQueueBatch, isQueueProcessing } = require('../services/queue/queueWorker');

const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/google' });
  }
  next();
}

// GET /queue/stats — queue status overview
router.get('/stats', requireLogin, async (_req, res) => {
  try {
    const stats = await getQueueStats();
    res.json({
      success: true,
      stats,
      workerProcessing: isQueueProcessing(),
    });
  } catch (err) {
    console.error('Queue stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /queue/jobs/:id — get a specific queue job
router.get('/jobs/:id', requireLogin, async (req, res) => {
  try {
    const job = await getJob(parseInt(req.params.id, 10));
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (job.payload?.userId && String(job.payload.userId) !== String(req.session.userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ success: true, job });
  } catch (err) {
    console.error('Get job error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /queue/jobs — list jobs for current user
router.get('/jobs', requireLogin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const jobs = await getJobsByPayloadField('userId', req.session.userId, limit);
    res.json({ success: true, jobs, count: jobs.length });
  } catch (err) {
    console.error('List jobs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /queue/process — manually trigger queue processing (dev/admin)
router.post('/process', requireLogin, async (req, res) => {
  try {
    const batchSize = Math.min(parseInt(req.body.batchSize, 10) || 5, 20);
    const result = await processQueueBatch(batchSize);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Process queue error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
