const cron = require('node-cron');
const { syncAllUsers } = require('./syncService');
const { ensureSyncSchema } = require('./syncSchema');
const { ensureAppleSchema } = require('../appleCalendarService');
const {
  SYNC_STRATEGIES,
  CONFLICT_STRATEGIES,
  DEFAULT_SYNC_STRATEGY,
  DEFAULT_CONFLICT_STRATEGY,
} = require('./syncStrategies');

let isRunning = false;
let scheduledTask = null;

const DEFAULT_CRON = '*/5 * * * *';

/**
 * Run a single background sync cycle for all users.
 */
async function runSyncJob(options = {}) {
  if (isRunning) {
    console.warn('⏭️  Sync job already running, skipping this cycle');
    return { skipped: true, reason: 'already_running' };
  }

  isRunning = true;
  const startedAt = new Date();

  try {
    await ensureAppleSchema();
    await ensureSyncSchema();

    console.log('⏰ Running scheduled sync job...');
    const result = await syncAllUsers({
      jobType: 'scheduled',
      syncStrategy: options.syncStrategy || process.env.SYNC_STRATEGY || DEFAULT_SYNC_STRATEGY,
      conflictStrategy: options.conflictStrategy || process.env.CONFLICT_STRATEGY || DEFAULT_CONFLICT_STRATEGY,
    });

    const succeeded = result.results.filter((r) => r.success).length;
    const failed = result.results.filter((r) => !r.success).length;
    const elapsed = Date.now() - startedAt.getTime();

    console.log(`✅ Sync job completed in ${elapsed}ms — ${succeeded} users OK, ${failed} failed`);
    return { ...result, elapsedMs: elapsed };
  } catch (err) {
    console.error('❌ Sync job failed:', err.message);
    throw err;
  } finally {
    isRunning = false;
  }
}

/**
 * Start the cron-based background sync scheduler.
 */
function startSyncScheduler(options = {}) {
  const cronExpression = options.cronExpression
    || process.env.SYNC_CRON_SCHEDULE
    || DEFAULT_CRON;

  if (scheduledTask) {
    scheduledTask.stop();
  }

  scheduledTask = cron.schedule(cronExpression, () => {
    runSyncJob(options).catch((err) => {
      console.error('Background sync error:', err.message);
    });
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
  return isRunning;
}

module.exports = {
  runSyncJob,
  startSyncScheduler,
  stopSyncScheduler,
  isSyncJobRunning,
  SYNC_STRATEGIES,
  CONFLICT_STRATEGIES,
};
