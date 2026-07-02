const pool = require('../../config/db');
const { getAllProviders, getProvider } = require('./providers');
const { ensureSyncSchema } = require('./syncSchema');
const {
  SYNC_STRATEGIES,
  CONFLICT_STRATEGIES,
  DEFAULT_SYNC_STRATEGY,
  DEFAULT_CONFLICT_STRATEGY,
  isValidSyncStrategy,
  isValidConflictStrategy,
} = require('./syncStrategies');
const {
  eventFingerprint,
  detectFieldConflicts,
  hasVersionConflict,
  resolveConflict,
  recordConflict,
  detectCrossProviderConflicts,
} = require('./conflictResolver');
const { notifyUser, WEBHOOK_EVENTS } = require('../webhooks/webhookNotifier');

/**
 * Get providers that are connected for a given user.
 */
async function getConnectedProviders(userId) {
  const all = getAllProviders();
  const connected = [];
  for (const provider of all) {
    if (await provider.isConnected(userId)) {
      connected.push(provider);
    }
  }
  return connected;
}

async function getEventState(userId, provider, externalId) {
  const { rows } = await pool.query(
    `SELECT * FROM sync_event_state
     WHERE user_id = $1 AND provider = $2 AND external_id = $3`,
    [userId, provider, externalId]
  );
  return rows[0] || null;
}

async function upsertEventState(userId, event, { pendingPush = false } = {}) {
  const fp = eventFingerprint(event);
  await pool.query(
    `INSERT INTO sync_event_state
       (user_id, provider, external_id, calendar_id, last_remote_version,
        last_synced_at, pending_push, fingerprint)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)
     ON CONFLICT (user_id, provider, external_id) DO UPDATE SET
       calendar_id = EXCLUDED.calendar_id,
       last_remote_version = EXCLUDED.last_remote_version,
       last_synced_at = NOW(),
       pending_push = EXCLUDED.pending_push,
       fingerprint = EXCLUDED.fingerprint`,
    [
      userId,
      event.provider,
      event.externalId,
      event.calendarId,
      event.version,
      pendingPush,
      fp,
    ]
  );
}

async function markPendingPush(userId, provider, externalId) {
  await pool.query(
    `UPDATE sync_event_state SET pending_push = TRUE
     WHERE user_id = $1 AND provider = $2 AND external_id = $3`,
    [userId, provider, externalId]
  );
}

async function clearPendingPush(userId, provider, externalId) {
  await pool.query(
    `UPDATE sync_event_state SET pending_push = FALSE, last_synced_at = NOW()
     WHERE user_id = $1 AND provider = $2 AND external_id = $3`,
    [userId, provider, externalId]
  );
}

async function getPendingPushEvents(userId, providerId) {
  const { rows } = await pool.query(
    `SELECT external_id FROM sync_event_state
     WHERE user_id = $1 AND provider = $2 AND pending_push = TRUE`,
    [userId, providerId]
  );
  return rows.map((r) => r.external_id);
}

async function createSyncJob(userId, options) {
  const { rows } = await pool.query(
    `INSERT INTO sync_jobs (user_id, job_type, sync_strategy, conflict_strategy, status, started_at)
     VALUES ($1, $2, $3, $4, 'running', NOW())
     RETURNING id`,
    [
      userId,
      options.jobType || 'manual',
      options.syncStrategy || DEFAULT_SYNC_STRATEGY,
      options.conflictStrategy || DEFAULT_CONFLICT_STRATEGY,
    ]
  );
  return rows[0].id;
}

async function completeSyncJob(jobId, result, error = null) {
  await pool.query(
    `UPDATE sync_jobs
     SET status = $2, completed_at = NOW(), result = $3, error = $4
     WHERE id = $1`,
    [jobId, error ? 'failed' : 'completed', JSON.stringify(result), error]
  );
}

/**
 * Pull phase: fetch remote changes for a provider and detect inbound conflicts.
 */
async function pullProvider(userId, provider, conflictStrategy) {
  const snapshot = await provider.listLocalEvents(userId);
  const snapshotMap = new Map(snapshot.map((e) => [e.externalId, e]));

  const pullResult = await provider.pullChanges(userId);
  const updatedEvents = await provider.listLocalEvents(userId);

  const conflicts = [];
  const resolved = [];

  for (const remoteEvent of updatedEvents) {
    const previous = snapshotMap.get(remoteEvent.externalId);
    const state = await getEventState(userId, provider.id, remoteEvent.externalId);

    if (previous && state && hasVersionConflict(state, remoteEvent)) {
      const fieldConflicts = detectFieldConflicts(previous, remoteEvent);
      if (fieldConflicts.length > 0) {
        const { winner, event } = resolveConflict(previous, remoteEvent, conflictStrategy);

        if (winner === 'manual') {
          const conflictId = await recordConflict(userId, {
            provider: provider.id,
            externalId: remoteEvent.externalId,
            calendarId: remoteEvent.calendarId,
            conflictType: 'inbound',
            fieldConflicts,
            localEvent: previous,
            remoteEvent,
            resolution: null,
          });
          conflicts.push({ conflictId, provider: provider.id, externalId: remoteEvent.externalId });
        } else if (winner === 'local') {
          await markPendingPush(userId, provider.id, remoteEvent.externalId);
          resolved.push({ provider: provider.id, externalId: remoteEvent.externalId, winner: 'local' });
        } else {
          await upsertEventState(userId, remoteEvent);
          resolved.push({ provider: provider.id, externalId: remoteEvent.externalId, winner: 'remote' });
        }
        continue;
      }
    }

    await upsertEventState(userId, remoteEvent);
  }

  return { pullResult, conflicts, resolved };
}

/**
 * Push phase: send pending local changes to remote providers.
 */
async function pushProvider(userId, provider) {
  const pendingIds = await getPendingPushEvents(userId, provider.id);
  const pushed = [];
  const errors = [];

  for (const externalId of pendingIds) {
    const events = await provider.listLocalEvents(userId);
    const event = events.find((e) => e.externalId === externalId);
    if (!event) continue;

    try {
      await provider.pushChange(userId, { type: 'update', event });
      await clearPendingPush(userId, provider.id, externalId);
      pushed.push(externalId);
    } catch (err) {
      errors.push({ externalId, error: err.message });
    }
  }

  return { pushed, errors };
}

/**
 * Sync a single user across all (or selected) connected providers.
 */
async function syncUser(userId, options = {}) {
  await ensureSyncSchema();

  const syncStrategy = isValidSyncStrategy(options.syncStrategy)
    ? options.syncStrategy
    : DEFAULT_SYNC_STRATEGY;
  const conflictStrategy = isValidConflictStrategy(options.conflictStrategy)
    ? options.conflictStrategy
    : DEFAULT_CONFLICT_STRATEGY;

  const jobId = await createSyncJob(userId, {
    jobType: options.jobType || 'manual',
    syncStrategy,
    conflictStrategy,
  });

  const result = {
    jobId,
    userId,
    syncStrategy,
    conflictStrategy,
    providers: {},
    conflicts: [],
    crossProviderConflicts: [],
  };

  try {
    let providers = await getConnectedProviders(userId);
    if (options.providers?.length) {
      providers = providers.filter((p) => options.providers.includes(p.id));
    }

    const eventsByProvider = {};

    for (const provider of providers) {
      const providerResult = { pulled: 0, pushed: 0, conflicts: [], errors: [] };

      if (syncStrategy === SYNC_STRATEGIES.PULL_ONLY || syncStrategy === SYNC_STRATEGIES.TWO_WAY) {
        try {
          const { pullResult, conflicts, resolved } = await pullProvider(
            userId, provider, conflictStrategy
          );
          providerResult.pulled = pullResult.totalSynced || 0;
          providerResult.conflicts = conflicts;
          providerResult.resolved = resolved;
          result.conflicts.push(...conflicts);
        } catch (err) {
          providerResult.errors.push({ phase: 'pull', error: err.message });
        }
      }

      if (syncStrategy === SYNC_STRATEGIES.PUSH_ONLY || syncStrategy === SYNC_STRATEGIES.TWO_WAY) {
        try {
          const { pushed, errors } = await pushProvider(userId, provider);
          providerResult.pushed = pushed.length;
          providerResult.pushErrors = errors;
        } catch (err) {
          providerResult.errors.push({ phase: 'push', error: err.message });
        }
      }

      eventsByProvider[provider.id] = await provider.listLocalEvents(userId);
      result.providers[provider.id] = providerResult;
    }

    if (Object.keys(eventsByProvider).length > 1) {
      const crossConflicts = detectCrossProviderConflicts(eventsByProvider);
      for (const conflict of crossConflicts) {
        const [a, b] = conflict.events;
        const conflictId = await recordConflict(userId, {
          provider: a.provider,
          externalId: a.event.externalId,
          calendarId: a.event.calendarId,
          conflictType: 'cross_provider',
          fieldConflicts: conflict.fieldConflicts,
          localEvent: a.event,
          remoteEvent: b.event,
          resolution: conflictStrategy === CONFLICT_STRATEGIES.MANUAL ? null : conflictStrategy,
        });
        result.crossProviderConflicts.push({
          conflictId,
          providers: [a.provider, b.provider],
          fieldConflicts: conflict.fieldConflicts,
        });
      }
    }

    await completeSyncJob(jobId, result);

    const totalConflicts = result.conflicts.length + result.crossProviderConflicts.length;
    if (totalConflicts > 0) {
      notifyUser(userId, WEBHOOK_EVENTS.CONFLICT_DETECTED, {
        jobId,
        conflictCount: totalConflicts,
        conflicts: result.conflicts,
        crossProviderConflicts: result.crossProviderConflicts,
      }).catch((err) => console.warn('Webhook notify failed:', err.message));
    }

    notifyUser(userId, WEBHOOK_EVENTS.SYNC_COMPLETED, {
      jobId,
      syncStrategy,
      providers: result.providers,
      conflictCount: totalConflicts,
    }).catch((err) => console.warn('Webhook notify failed:', err.message));

    return result;
  } catch (err) {
    await completeSyncJob(jobId, result, err.message);

    notifyUser(userId, WEBHOOK_EVENTS.SYNC_FAILED, {
      jobId,
      error: err.message,
      syncStrategy,
    }).catch((whErr) => console.warn('Webhook notify failed:', whErr.message));

    throw err;
  }
}

/**
 * Sync all users in the database (used by background jobs).
 */
async function syncAllUsers(options = {}) {
  await ensureSyncSchema();
  const { rows: users } = await pool.query('SELECT id FROM users ORDER BY id');
  const results = [];

  for (const user of users) {
    try {
      const result = await syncUser(user.id, {
        ...options,
        jobType: options.jobType || 'scheduled',
      });
      results.push({ userId: user.id, success: true, jobId: result.jobId });
    } catch (err) {
      results.push({ userId: user.id, success: false, error: err.message });
    }
  }

  return { totalUsers: users.length, results };
}

async function getUnresolvedConflicts(userId) {
  await ensureSyncSchema();
  const { rows } = await pool.query(
    `SELECT id, provider, external_id, calendar_id, conflict_type,
            field_conflicts, local_snapshot, remote_snapshot, created_at
     FROM sync_conflicts
     WHERE user_id = $1 AND resolved_at IS NULL
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

async function resolveConflictManually(userId, conflictId, resolution) {
  await ensureSyncSchema();
  const { rows } = await pool.query(
    `SELECT * FROM sync_conflicts WHERE id = $1 AND user_id = $2`,
    [conflictId, userId]
  );
  const conflict = rows[0];
  if (!conflict) throw new Error('Conflict not found');

  const localEvent = typeof conflict.local_snapshot === 'string'
    ? JSON.parse(conflict.local_snapshot)
    : conflict.local_snapshot;
  const remoteEvent = typeof conflict.remote_snapshot === 'string'
    ? JSON.parse(conflict.remote_snapshot)
    : conflict.remote_snapshot;

  const { winner, event } = resolveConflict(localEvent, remoteEvent, resolution);

  if (winner === 'local' && event) {
    const provider = getProvider(conflict.provider);
    await provider.pushChange(userId, { type: 'update', event });
    await clearPendingPush(userId, conflict.provider, conflict.external_id);
  } else if (winner === 'remote' && event) {
    await upsertEventState(userId, event);
  }

  await pool.query(
    `UPDATE sync_conflicts
     SET resolution = $1, resolved_by = 'manual', resolved_at = NOW()
     WHERE id = $2`,
    [resolution, conflictId]
  );

  return { conflictId, resolution, winner };
}

async function getSyncJobHistory(userId, limit = 20) {
  await ensureSyncSchema();
  const { rows } = await pool.query(
    `SELECT id, job_type, sync_strategy, conflict_strategy, status,
            started_at, completed_at, result, error, created_at
     FROM sync_jobs
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function getSyncStatus(userId) {
  const providers = getAllProviders();
  const status = {
    providers: {},
    pendingConflicts: 0,
    lastJob: null,
  };

  for (const provider of providers) {
    status.providers[provider.id] = {
      displayName: provider.displayName,
      connected: await provider.isConnected(userId),
    };
  }

  await ensureSyncSchema();
  const { rows: conflictCount } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM sync_conflicts
     WHERE user_id = $1 AND resolved_at IS NULL`,
    [userId]
  );
  status.pendingConflicts = conflictCount[0].count;

  const jobs = await getSyncJobHistory(userId, 1);
  status.lastJob = jobs[0] || null;

  return status;
}

module.exports = {
  getConnectedProviders,
  syncUser,
  syncAllUsers,
  getUnresolvedConflicts,
  resolveConflictManually,
  getSyncJobHistory,
  getSyncStatus,
  markPendingPush,
};
