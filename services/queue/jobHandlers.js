const { syncUser, syncAllUsers } = require('../sync/syncService');
const { deliverWebhook } = require('../webhooks/webhookService');
const { JOB_TYPES } = require('./jobQueue');

const handlers = {
  [JOB_TYPES.SYNC_USER]: async (payload) => {
    const { userId, syncStrategy, conflictStrategy, providers, jobType } = payload;
    if (!userId) throw new Error('sync_user job requires userId');
    return syncUser(userId, { syncStrategy, conflictStrategy, providers, jobType: jobType || 'queued' });
  },

  [JOB_TYPES.SYNC_ALL]: async (payload) => {
    const { syncStrategy, conflictStrategy } = payload;
    return syncAllUsers({ syncStrategy, conflictStrategy, jobType: 'scheduled' });
  },

  [JOB_TYPES.WEBHOOK_DELIVERY]: async (payload) => {
    const { webhookId, eventType, data, deliveryId } = payload;
    if (!webhookId || !eventType) {
      throw new Error('webhook_delivery job requires webhookId and eventType');
    }
    return deliverWebhook(webhookId, eventType, data, deliveryId);
  },
};

async function handleJob(job) {
  const handler = handlers[job.job_type];
  if (!handler) {
    throw new Error(`No handler registered for job type: ${job.job_type}`);
  }
  return handler(job.payload);
}

module.exports = { handleJob, handlers };
