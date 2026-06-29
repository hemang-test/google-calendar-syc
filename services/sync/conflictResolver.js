const crypto = require('crypto');
const pool = require('../../config/db');
const { CONFLICT_STRATEGIES } = require('./syncStrategies');

const COMPARED_FIELDS = ['summary', 'description', 'startTime', 'endTime', 'status'];

/**
 * Build a fingerprint for cross-provider event matching.
 */
function eventFingerprint(event) {
  const payload = [
    (event.summary || '').trim().toLowerCase(),
    event.startTime || '',
    event.endTime || '',
  ].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Detect field-level differences between two normalized events.
 */
function detectFieldConflicts(localEvent, remoteEvent) {
  const conflicts = [];
  for (const field of COMPARED_FIELDS) {
    const localVal = normalizeFieldValue(localEvent[field]);
    const remoteVal = normalizeFieldValue(remoteEvent[field]);
    if (localVal !== remoteVal) {
      conflicts.push({ field, localValue: localEvent[field], remoteValue: remoteEvent[field] });
    }
  }
  return conflicts;
}

function normalizeFieldValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

/**
 * Determine if local and remote versions diverged since last sync.
 */
function hasVersionConflict(localState, remoteEvent) {
  if (!localState) return false;
  const remoteChanged = localState.last_remote_version
    && remoteEvent.version
    && localState.last_remote_version !== remoteEvent.version;
  const localChanged = localState.pending_push === true;
  return remoteChanged && localChanged;
}

/**
 * Apply a conflict resolution strategy and return the winning event data.
 */
function resolveConflict(localEvent, remoteEvent, strategy) {
  switch (strategy) {
    case CONFLICT_STRATEGIES.SOURCE_WINS:
      return { winner: 'remote', event: remoteEvent };

    case CONFLICT_STRATEGIES.LOCAL_WINS:
      return { winner: 'local', event: localEvent };

    case CONFLICT_STRATEGIES.MANUAL:
      return { winner: 'manual', event: null };

    case CONFLICT_STRATEGIES.LAST_WRITE_WINS:
    default: {
      const localTime = new Date(localEvent.updatedAt || 0).getTime();
      const remoteTime = parseRemoteTimestamp(remoteEvent.version);
      if (remoteTime > localTime) {
        return { winner: 'remote', event: remoteEvent };
      }
      return { winner: 'local', event: localEvent };
    }
  }
}

function parseRemoteTimestamp(version) {
  if (!version) return 0;
  const parsed = new Date(version);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

/**
 * Persist an unresolved or resolved conflict record.
 */
async function recordConflict(userId, {
  provider,
  externalId,
  calendarId,
  conflictType,
  fieldConflicts,
  localEvent,
  remoteEvent,
  resolution,
  resolvedBy,
}) {
  const { rows } = await pool.query(
    `INSERT INTO sync_conflicts
       (user_id, provider, external_id, calendar_id, conflict_type,
        field_conflicts, local_snapshot, remote_snapshot, resolution, resolved_by, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      userId,
      provider,
      externalId,
      calendarId || null,
      conflictType,
      JSON.stringify(fieldConflicts),
      JSON.stringify(localEvent),
      JSON.stringify(remoteEvent),
      resolution || null,
      resolvedBy || null,
      resolution ? new Date() : null,
    ]
  );
  return rows[0].id;
}

/**
 * Find cross-provider conflicts by matching event fingerprints.
 */
function detectCrossProviderConflicts(eventsByProvider) {
  const fingerprintMap = new Map();
  const crossConflicts = [];

  for (const [provider, events] of Object.entries(eventsByProvider)) {
    for (const event of events) {
      const fp = eventFingerprint(event);
      if (!fingerprintMap.has(fp)) {
        fingerprintMap.set(fp, []);
      }
      fingerprintMap.get(fp).push({ provider, event });
    }
  }

  for (const [, matches] of fingerprintMap) {
    if (matches.length < 2) continue;
    const providers = [...new Set(matches.map((m) => m.provider))];
    if (providers.length < 2) continue;

    for (let i = 0; i < matches.length; i++) {
      for (let j = i + 1; j < matches.length; j++) {
        const fieldConflicts = detectFieldConflicts(matches[i].event, matches[j].event);
        if (fieldConflicts.length > 0) {
          crossConflicts.push({
            type: 'cross_provider',
            events: [matches[i], matches[j]],
            fieldConflicts,
          });
        }
      }
    }
  }

  return crossConflicts;
}

module.exports = {
  COMPARED_FIELDS,
  eventFingerprint,
  detectFieldConflicts,
  hasVersionConflict,
  resolveConflict,
  recordConflict,
  detectCrossProviderConflicts,
};
