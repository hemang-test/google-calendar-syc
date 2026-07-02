const { getActiveWebhooksForEvent, createDeliveryRecord, WEBHOOK_EVENTS } = require('./webhookService');
const { enqueueJob, JOB_TYPES } = require('../queue/jobQueue');

/**
 * Emit a webhook notification for a user event.
 * Enqueues delivery jobs (with retries) for each subscribed webhook.
 */
async function notifyUser(userId, eventType, data) {
  const webhooks = await getActiveWebhooksForEvent(userId, eventType);
  if (!webhooks.length) return { notified: 0 };

  const deliveries = [];

  for (const webhook of webhooks) {
    const deliveryId = await createDeliveryRecord(webhook.id, eventType, {
      userId,
      ...data,
    });

    const job = await enqueueJob(
      JOB_TYPES.WEBHOOK_DELIVERY,
      {
        webhookId: webhook.id,
        eventType,
        data: { userId, ...data },
        deliveryId,
      },
      { maxAttempts: parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '5', 10) }
    );

    deliveries.push({
      webhookId: webhook.id,
      deliveryId,
      queueJobId: job.id,
    });
  }

  return { notified: deliveries.length, deliveries };
}

module.exports = { notifyUser, WEBHOOK_EVENTS };
