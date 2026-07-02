const { claimNextJob, completeJob, failJob } = require('./jobQueue');
const { handleJob } = require('./jobHandlers');
const { ensureQueueSchema } = require('./queueSchema');

let isProcessing = false;
let workerInterval = null;

const DEFAULT_POLL_MS = 2000;
const DEFAULT_BATCH_SIZE = 5;

/**
 * Process a single claimed job with retry on failure.
 */
async function processJob(job) {
  try {
    const result = await handleJob(job);
    await completeJob(job.id, result);
    return { jobId: job.id, status: 'completed', result };
  } catch (err) {
    const retryInfo = await failJob(job.id, err.message, {
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
    });
    return {
      jobId: job.id,
      status: retryInfo.retried ? 'retry' : 'dead_letter',
      error: err.message,
      ...retryInfo,
    };
  }
}

/**
 * Process up to batchSize jobs from the queue.
 */
async function processQueueBatch(batchSize = DEFAULT_BATCH_SIZE) {
  if (isProcessing) return { skipped: true, reason: 'already_processing' };

  isProcessing = true;
  const results = [];

  try {
    await ensureQueueSchema();

    for (let i = 0; i < batchSize; i++) {
      const job = await claimNextJob();
      if (!job) break;

      const result = await processJob(job);
      results.push(result);

      if (result.status === 'retry') {
        console.warn(`🔄 Job ${job.id} (${job.job_type}) failed, scheduled retry: ${result.error}`);
      } else if (result.status === 'dead_letter') {
        console.error(`💀 Job ${job.id} (${job.job_type}) moved to dead letter: ${result.error}`);
      }
    }
  } finally {
    isProcessing = false;
  }

  return { processed: results.length, results };
}

function startQueueWorker(options = {}) {
  const pollMs = options.pollMs
    || parseInt(process.env.QUEUE_POLL_MS || String(DEFAULT_POLL_MS), 10);
  const batchSize = options.batchSize
    || parseInt(process.env.QUEUE_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10);

  if (workerInterval) {
    clearInterval(workerInterval);
  }

  workerInterval = setInterval(() => {
    processQueueBatch(batchSize).catch((err) => {
      console.error('Queue worker error:', err.message);
    });
  }, pollMs);

  console.log(`📬 Queue worker started (poll: ${pollMs}ms, batch: ${batchSize})`);
  return workerInterval;
}

function stopQueueWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('📬 Queue worker stopped');
  }
}

function isQueueProcessing() {
  return isProcessing;
}

module.exports = {
  processJob,
  processQueueBatch,
  startQueueWorker,
  stopQueueWorker,
  isQueueProcessing,
};
