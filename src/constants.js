// KV key names
export const KV = {
  KEYS_LIST:     'keys:list',       // JSON array of key objects
  STATS_PREFIX:  'stats:',          // stats:<keyHash> → { requests, errors, lastError, lastUsed }
  GLOBAL_STATS:  'stats:global',    // { totalRequests, totalErrors, startedAt }
  ROUND_ROBIN:   'rr:index',        // current round-robin pointer
  CONFIG:        'config:main',     // gateway configuration object
};

// How long to quarantine a failed key before retrying it (ms)
export const QUARANTINE_MS = 60_000;

// HTTP status codes that mean "this key is dead / over-budget; skip it"
export const SKIP_STATUSES = new Set([401, 403]);

// HTTP status codes worth retrying with the NEXT key
export const RETRY_STATUSES = new Set([429, 500, 502, 503, 529]);

// X-Straitly-Error-Code values that are unrecoverable (no point trying another key)
export const FATAL_ERROR_CODES = new Set([
  'insufficient_credits',
  'quota_exceeded',
  'budget_exhausted',
  'model_not_found',
]);

// X-Straitly-Error-Code values that mean the key itself is bad
export const BAD_KEY_ERROR_CODES = new Set([
  'invalid_api_key',
  'key_revoked',
]);
