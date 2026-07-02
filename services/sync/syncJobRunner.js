const cron = require('node-cron');
const { ensureSyncSchema } = require('./syncSchema');
const { ensureAppleSchema } = require('../appleCalendarService');
const { enqueueJob, JOB_TYPES } = require('../queue/jobQueue');
const { processQueueBatch } = require('../queue/queueWorker');
const {
  SYNC_STRATEGIES,
  CONFLICT_STRATEGIES,
  DEFAULT_SYNC_STRATEGY,
  DEFAULT_CONFLICT_STRATEGY,
} = require('./syncStrategies');

let scheduledTask = null;

const DEFAULT_CRON = '*/5 * * * *';

/**
 * Enqueue a scheduled sync-all job (processed by the queue worker).
 */
async function runSyncJob(options = {}) {
  await ensureAppleSchema();
  await ensureSyncSchema();

  const syncStrategy = options.syncStrategy || process.env.SYNC_STRATEGY || DEFAULT_SYNC_STRATEGY;
  const conflictStrategy = options.conflictStrategy || process.env.CONFLICT_STRATEGY || DEFAULT_CONFLICT_STRATEGY;

  const idempotencyKey = options.idempotencyKey
    || `sync_all_${new Date().toISOString().slice(0, 16)}`;

  const job = await enqueueJob(
    JOB_TYPES.SYNC_ALL,
    { syncStrategy, conflictStrategy },
    { idempotencyKey, priority: options.priority ?? 1 }
  );

  if (job.duplicate) {
    console.log(`⏭️  Scheduled sync already queued (job ${job.id})`);
    return { queued: false, queueJobId: job.id, duplicate: true };
  }

  console.log(`📥 Scheduled sync enqueued as job ${job.id}`);
  return { queued: true, queueJobId: job.id };
}

/**
 * Start cron scheduler that enqueues sync jobs + triggers queue processing.
 */
function startSyncScheduler(options = {}) {
  const cronExpression = options.cronExpression
    || process.env.SYNC_CRON_SCHEDULE
    || DEFAULT_CRON;

  if (scheduledTask) {
    scheduledTask.stop();
  }

  scheduledTask = cron.schedule(cronExpression, async () => {
    try {
      await runSyncJob(options);
      await processQueueBatch();
    } catch (err) {
      console.error('Background sync enqueue error:', err.message);
    }
  });

  console.log(`📅 Sync scheduler started (cron: ${cronExpression})`);
  return scheduledTask;
}

function stopSyncScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log('📅 Sync scheduler stopped');
  }
}

function isSyncJobRunning() {
  return false;
}

module.exports = {
  runSyncJob,
  startSyncScheduler,
  stopSyncScheduler,
  isSyncJobRunning,
  SYNC_STRATEGIES,
  CONFLICT_STRATEGIES,
};
