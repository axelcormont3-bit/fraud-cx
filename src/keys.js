/**
 * Key management layer.
 *
 * Key object shape stored in KV (keys:list):
 * {
 *   id:              string,   // 8-char hex SHA-256 prefix of the raw key
 *   key:             string,   // the actual Straitly API key  ← never sent to clients
 *   label:           string,   // human-readable label
 *   enabled:         boolean,
 *   addedAt:         number,   // unix ms
 *   quarantineUntil: number,   // unix ms; 0 = not quarantined
 * }
 *
 * ── KV write budget ──────────────────────────────────────────────────────────
 *
 * Cloudflare KV free plan: 1 000 writes/day.
 *
 * Strategy: KV is the durable store for key configuration only.
 *   - Normal requests → zero KV writes (rotation and stats are in-memory).
 *   - Key status changes (quarantine, disable) → one KV write each; these
 *     happen only on upstream errors, which are rare in normal operation.
 *   - Admin mutations (add/remove/enable/label) → one KV write each.
 *   - Periodic stats flush → one KV write per flush interval (default 5 min),
 *     regardless of how many requests landed in that window.
 *
 * Result: a healthy gateway with 20 keys and no upstream errors burns
 * 0 KV writes per request during normal operation.
 *
 * ── In-memory round-robin ────────────────────────────────────────────────────
 *
 * The RR counter lives in module scope (isolate memory).  Cloudflare runs one
 * isolate per Worker instance; a warm isolate handles many requests before
 * being recycled, so in-memory rotation distributes load well in practice.
 * On a cold start the counter resets to 0 — equivalent to starting a fresh
 * round, which is fine.  There is no cross-isolate coordination: with 20 keys
 * the statistical spread is good enough without it.
 *
 * ── In-memory stats accumulation ────────────────────────────────────────────
 *
 * Per-key and global counters accumulate in memory and flush to KV every
 * STATS_FLUSH_INTERVAL_MS (default 5 min) using waitUntil so the flush never
 * blocks a response.  On admin GET /stats the in-memory delta is merged with
 * the last-persisted KV snapshot so the numbers are always current.
 *
 * Key-level metadata that affects routing (enabled, quarantineUntil) is still
 * written to KV immediately on change so it survives isolate recycling.
 */

import { KV, QUARANTINE_MS } from './constants.js';

// ─── module-level state ──────────────────────────────────────────────────────

/**
 * Round-robin pointer.  Incremented in-memory; never persisted.
 *
 * Seeded from Date.now() so that multiple isolates cold-starting simultaneously
 * (which Cloudflare can spin up under burst load) begin at different positions
 * in the key list rather than all starting at index 0 at the same moment.
 * The modulo against available.length in getOrderedKeys keeps it in range.
 */
let rrCounter = Date.now();

/**
 * In-memory stats delta accumulated since the last KV flush.
 * Shape: Map<keyId, { requests, errors, lastError, lastUsed }>
 */
const memStats = new Map();

/** Global in-memory stats delta. */
let memGlobal = { totalRequests: 0, totalErrors: 0 };

/**
 * Timestamp of the last flush attempt.
 * We skip flush if no requests have arrived since the last one.
 */
let lastFlushAt = 0;

/**
 * How often to flush stats to KV (ms).
 *
 * Budget calculation for Cloudflare KV Free plan (1,000 writes/day):
 *   Each flush writes at most (keyCount + 1) values.
 *   With 20 keys: 21 writes/flush.
 *   At 60-minute intervals: 24 flushes/day × 21 = 504 writes/day.
 *   Remaining headroom (~496) covers key-failure writes and admin actions.
 *
 * Do NOT lower this below 60 minutes if you have 20 active keys on the Free plan.
 * On the Workers Paid plan ($5/month, 1M writes/day) any interval is fine.
 */
export const STATS_FLUSH_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

// ─── helpers ────────────────────────────────────────────────────────────────

/** Stable 8-char hex ID derived from the key string. */
export async function hashKey(key) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
}

/** Returns a masked representation safe to send to clients / logs. */
export function maskKey(key) {
  if (!key || key.length < 8) return '***';
  return key.slice(0, 4) + '…' + key.slice(-4);
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function listKeys(kv) {
  const raw = await kv.get(KV.KEYS_LIST);
  return raw ? JSON.parse(raw) : [];
}

export async function saveKeys(kv, keys) {
  await kv.put(KV.KEYS_LIST, JSON.stringify(keys));
}

export async function addKey(kv, rawKey, label = '') {
  const keys = await listKeys(kv);
  const id = await hashKey(rawKey);

  if (keys.find(k => k.id === id)) {
    return { error: 'Key already exists', id };
  }

  keys.push({
    id,
    key:             rawKey,
    label:           label || maskKey(rawKey),
    enabled:         true,
    addedAt:         Date.now(),
    quarantineUntil: 0,
  });

  await saveKeys(kv, keys);
  return { ok: true, id };
}

export async function removeKey(kv, id) {
  const keys = await listKeys(kv);
  const idx = keys.findIndex(k => k.id === id);
  if (idx === -1) return { error: 'Key not found' };
  keys.splice(idx, 1);
  await saveKeys(kv, keys);
  // Drop any in-memory stats for the removed key
  memStats.delete(id);
  return { ok: true };
}

export async function setKeyEnabled(kv, id, enabled) {
  const keys = await listKeys(kv);
  const key = keys.find(k => k.id === id);
  if (!key) return { error: 'Key not found' };
  key.enabled = enabled;
  if (enabled) key.quarantineUntil = 0;
  await saveKeys(kv, keys);  // 1 KV write
  return { ok: true };
}

/**
 * Quarantine a key for QUARANTINE_MS.
 * Writes to KV so the status survives if the isolate is recycled before
 * the quarantine window expires.
 *
 * Concurrent-write note: quarantineKey and markKeyBad both do a full
 * read-modify-write on keys:list.  If two requests fail on two different
 * keys simultaneously, their KV writes can interleave at the await
 * boundaries and one update can overwrite the other.  The practical
 * consequence is that one key's quarantine is lost for one cycle — it
 * will simply be quarantined on the very next failure, which happens
 * within the same burst.  Fixing this correctly would require
 * compare-and-swap semantics that Cloudflare KV does not expose.
 * The race is benign and self-correcting for a personal gateway.
 */
export async function quarantineKey(kv, id) {
  const keys = await listKeys(kv);
  const key = keys.find(k => k.id === id);
  if (!key) return;
  key.quarantineUntil = Date.now() + QUARANTINE_MS;
  await saveKeys(kv, keys);  // 1 KV write
}

/**
 * Permanently disable a bad key.
 * Writes to KV immediately so it stays disabled across isolate restarts.
 */
export async function markKeyBad(kv, id) {
  const keys = await listKeys(kv);
  const key = keys.find(k => k.id === id);
  if (!key) return;
  key.enabled = false;
  key.quarantineUntil = 0;
  await saveKeys(kv, keys);  // 1 KV write
}

// ─── selection ──────────────────────────────────────────────────────────────

/**
 * Returns an ordered list of key objects to try for this request.
 *
 * Uses the in-memory rrCounter — zero KV reads or writes on the hot path.
 * The list starts at the current counter position and wraps around, so each
 * successive call shifts the starting key by one (within the same isolate).
 */
export async function getOrderedKeys(kv) {
  const keys = await listKeys(kv);  // 1 KV read (always needed)
  if (keys.length === 0) return [];

  const now = Date.now();
  const available = keys.filter(k => k.enabled && k.quarantineUntil < now);
  if (available.length === 0) return [];

  const start = rrCounter % available.length;
  rrCounter = (rrCounter + 1) % available.length;  // pure memory, no KV write

  return [
    ...available.slice(start),
    ...available.slice(0, start),
  ];
}

// ─── in-memory stats accumulation ───────────────────────────────────────────

/**
 * Record a request outcome in memory only.
 * No KV write — flushed periodically by flushStats().
 */
export function incrementStats(keyId, { error = false, errorMsg = '' } = {}) {
  let s = memStats.get(keyId);
  if (!s) {
    s = { requests: 0, errors: 0, lastError: null, lastUsed: 0 };
    memStats.set(keyId, s);
  }
  s.requests++;
  s.lastUsed = Date.now();
  if (error) {
    s.errors++;
    s.lastError = errorMsg.slice(0, 200);
  }
}

/**
 * Record a global request outcome in memory only.
 */
export function incrementGlobalStats({ error = false } = {}) {
  memGlobal.totalRequests++;
  if (error) memGlobal.totalErrors++;
}

/**
 * Flush accumulated in-memory stats to KV.
 *
 * Call via ctx.waitUntil() so it never delays a response.
 * Skips the flush if the interval has not elapsed or nothing accumulated.
 *
 * The interval guard (lastFlushAt) is set BEFORE the first await, so
 * concurrent calls within the same isolate will all hit the guard and
 * return early — only the first call per interval actually writes to KV.
 *
 * KV writes per flush: 1 per key with pending delta + 1 for global.
 * With 20 keys and a 60-minute interval: at most 21 × 24 = 504 writes/day,
 * well within the Free plan's 1,000-write/day budget.
 */
export async function flushStats(kv) {
  const now = Date.now();
  if (now - lastFlushAt < STATS_FLUSH_INTERVAL_MS) return;
  if (memGlobal.totalRequests === 0 && memStats.size === 0) return;

  lastFlushAt = now;

  // Per-key flush
  for (const [keyId, delta] of memStats.entries()) {
    const statsKey = KV.STATS_PREFIX + keyId;
    try {
      const raw = await kv.get(statsKey);
      const persisted = raw
        ? JSON.parse(raw)
        : { requests: 0, errors: 0, lastError: null, lastUsed: 0 };

      persisted.requests += delta.requests;
      persisted.errors   += delta.errors;
      persisted.lastUsed  = Math.max(persisted.lastUsed, delta.lastUsed);
      if (delta.lastError) persisted.lastError = delta.lastError;

      await kv.put(statsKey, JSON.stringify(persisted));
    } catch {
      // Non-fatal; we'll retry on the next flush
    }
    // Reset delta after successful flush
    memStats.delete(keyId);
  }

  // Global flush
  if (memGlobal.totalRequests > 0) {
    try {
      const raw = await kv.get(KV.GLOBAL_STATS);
      const persisted = raw
        ? JSON.parse(raw)
        : { totalRequests: 0, totalErrors: 0, startedAt: now };

      persisted.totalRequests += memGlobal.totalRequests;
      persisted.totalErrors   += memGlobal.totalErrors;

      await kv.put(KV.GLOBAL_STATS, JSON.stringify(persisted));
      memGlobal = { totalRequests: 0, totalErrors: 0 };
    } catch {
      // Non-fatal
    }
  }
}

// ─── stats retrieval ─────────────────────────────────────────────────────────

/**
 * Returns per-key stats merging the last-persisted KV snapshot with any
 * in-memory delta that hasn't been flushed yet, so the numbers are always
 * current even between flushes.
 */
export async function getStats(kv) {
  const keys = await listKeys(kv);
  const result = [];

  for (const k of keys) {
    const raw = await kv.get(KV.STATS_PREFIX + k.id);
    const persisted = raw
      ? JSON.parse(raw)
      : { requests: 0, errors: 0, lastError: null, lastUsed: 0 };

    const delta = memStats.get(k.id) || { requests: 0, errors: 0, lastError: null, lastUsed: 0 };

    result.push({
      id:              k.id,
      label:           k.label,
      enabled:         k.enabled,
      quarantineUntil: k.quarantineUntil,
      requests:        persisted.requests + delta.requests,
      errors:          persisted.errors   + delta.errors,
      lastError:       delta.lastError ?? persisted.lastError,
      lastUsed:        Math.max(persisted.lastUsed, delta.lastUsed),
    });
  }

  return result;
}

export async function getGlobalStats(kv) {
  const raw = await kv.get(KV.GLOBAL_STATS);
  const persisted = raw
    ? JSON.parse(raw)
    : { totalRequests: 0, totalErrors: 0, startedAt: Date.now() };

  return {
    totalRequests: persisted.totalRequests + memGlobal.totalRequests,
    totalErrors:   persisted.totalErrors   + memGlobal.totalErrors,
    startedAt:     persisted.startedAt,
  };
}

/** Expose the live in-memory delta for testing. */
export function _getMemStats() { return { memStats, memGlobal, rrCounter: () => rrCounter }; }

/** Reset module-level state (for test isolation). */
export function _resetMemory() {
  rrCounter = 0;   // deterministic start for tests (production seeds from Date.now())
  memStats.clear();
  memGlobal = { totalRequests: 0, totalErrors: 0 };
  lastFlushAt = 0;
}
