const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60000;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Exponential backoff with jitter for retry scheduling.
 * attempt is 0-based (0 = first retry after initial failure).
 */
function calculateRetryDelay(attempt, options = {}) {
  const base = options.baseDelayMs ?? parseInt(process.env.RETRY_BASE_DELAY_MS || String(DEFAULT_BASE_DELAY_MS), 10);
  const max = options.maxDelayMs ?? parseInt(process.env.RETRY_MAX_DELAY_MS || String(DEFAULT_MAX_DELAY_MS), 10);
  const exponential = base * Math.pow(2, attempt);
  const capped = Math.min(exponential, max);
  const jitter = Math.floor(Math.random() * capped * 0.3);
  return capped + jitter;
}

function getMaxAttempts(jobType) {
  const envKey = `RETRY_MAX_ATTEMPTS_${jobType.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[envKey]) {
    return parseInt(process.env[envKey], 10);
  }
  return parseInt(process.env.RETRY_MAX_ATTEMPTS || String(DEFAULT_MAX_ATTEMPTS), 10);
}

function getRetryAt(attempt, options = {}) {
  const delayMs = calculateRetryDelay(attempt, options);
  return new Date(Date.now() + delayMs);
}

module.exports = {
  calculateRetryDelay,
  getMaxAttempts,
  getRetryAt,
  DEFAULT_MAX_ATTEMPTS,
};
