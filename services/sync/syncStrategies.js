/**
 * Synchronization direction strategies.
 *
 * PULL_ONLY  — inbound: remote → local DB (default for background sync)
 * PUSH_ONLY  — outbound: push pending local changes to remote
 * TWO_WAY    — pull then push with conflict resolution
 */
const SYNC_STRATEGIES = {
  PULL_ONLY: 'pull_only',
  PUSH_ONLY: 'push_only',
  TWO_WAY: 'two_way',
};

/**
 * Conflict resolution strategies applied when local and remote diverge.
 *
 * LAST_WRITE_WINS — compare timestamps; newest change wins
 * SOURCE_WINS     — remote provider always wins
 * LOCAL_WINS      — local DB always wins (push to remote)
 * MANUAL          — record conflict; skip auto-resolution
 */
const CONFLICT_STRATEGIES = {
  LAST_WRITE_WINS: 'last_write_wins',
  SOURCE_WINS: 'source_wins',
  LOCAL_WINS: 'local_wins',
  MANUAL: 'manual',
};

const DEFAULT_SYNC_STRATEGY = SYNC_STRATEGIES.TWO_WAY;
const DEFAULT_CONFLICT_STRATEGY = CONFLICT_STRATEGIES.LAST_WRITE_WINS;

function isValidSyncStrategy(strategy) {
  return Object.values(SYNC_STRATEGIES).includes(strategy);
}

function isValidConflictStrategy(strategy) {
  return Object.values(CONFLICT_STRATEGIES).includes(strategy);
}

module.exports = {
  SYNC_STRATEGIES,
  CONFLICT_STRATEGIES,
  DEFAULT_SYNC_STRATEGY,
  DEFAULT_CONFLICT_STRATEGY,
  isValidSyncStrategy,
  isValidConflictStrategy,
};
