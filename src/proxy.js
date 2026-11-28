/**
 * Core proxy logic.
 *
 * Tries upstream keys in round-robin order, with per-key fallback.
 * Handles both streaming (SSE) and non-streaming responses transparently.
 *
 * KV writes on the hot path:
 *   - Normal success   → 0  (stats are in-memory; rotation is in-memory)
 *   - Key quarantined  → 1  (saves quarantineUntil so it survives isolate recycle)
 *   - Key disabled     → 1  (saves enabled=false durably)
 *   - Stats flush      → ≤ (keyCount + 1), fired via waitUntil at most once
 *                          every STATS_FLUSH_INTERVAL_MS
 */

import {
  SKIP_STATUSES,
  RETRY_STATUSES,
  FATAL_ERROR_CODES,
  BAD_KEY_ERROR_CODES,
} from './constants.js';
import {
  getOrderedKeys,
  quarantineKey,
  markKeyBad,
  incrementStats,
  incrementGlobalStats,
  flushStats,
} from './keys.js';

/** Headers to strip before forwarding to upstream. */
const STRIP_REQUEST_HEADERS = new Set([
  'authorization',
  'host',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
]);

/** Headers to strip from upstream response before returning to client. */
const STRIP_RESPONSE_HEADERS = new Set([
  'x-straitly-error-code',
  'cf-ray',
  'cf-cache-status',
  'server',
  'via',
  'alt-svc',
]);

export async function proxyRequest(request, env, ctx) {
  const url = new URL(request.url);
  const upstreamBase = (env.UPSTREAM_BASE_URL || 'https://api.straitly.ai/v1').replace(/\/$/, '');
  // Strip the /v1 prefix from the incoming path before appending to the upstream
  // base (which already ends in /v1), otherwise we'd build …/v1/v1/models.
  const upstreamPath = url.pathname.replace(/^\/v1/, '');
  const upstreamUrl  = upstreamBase + upstreamPath + url.search;

  const maxRetries = Math.min(parseInt(env.MAX_RETRIES || '5', 10), 20);
  const timeoutMs  = Math.min(parseInt(env.REQUEST_TIMEOUT_MS || '120000', 10), 300_000);

  // 1 KV read – the only mandatory read on the hot path
  const keys = await getOrderedKeys(env.GATEWAY_KV);
  if (keys.length === 0) {
    return jsonError(503, 'no_keys_available', 'No upstream keys are available. Add keys via the admin interface.');
  }

  // Buffer the body once so we can resend it on retries
  let bodyBuffer = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    bodyBuffer = await request.arrayBuffer();
  }

  const attempt = Math.min(maxRetries, keys.length);

  // Schedule a periodic stats flush via waitUntil (non-blocking, best-effort).
  // ctx may be absent in tests; guard accordingly.
  if (ctx?.waitUntil) {
    ctx.waitUntil(flushStats(env.GATEWAY_KV));
  }

  for (let i = 0; i < attempt; i++) {
    const keyObj = keys[i];

    // Build forwarded headers
    const headers = new Headers();
    for (const [k, v] of request.headers.entries()) {
      if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) {
        headers.set(k, v);
      }
    }
    headers.set('Authorization', `Bearer ${keyObj.key}`);
    headers.set('Host', 'api.straitly.ai');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(upstreamUrl, {
        method:   request.method,
        headers,
        body:     bodyBuffer ? bodyBuffer.slice(0) : null,
        signal:   controller.signal,
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(timer);
      // Network / timeout error — quarantine key (1 KV write) and try next
      incrementStats(keyObj.id, { error: true, errorMsg: String(err) }); // memory only
      incrementGlobalStats({ error: true });                              // memory only
      await quarantineKey(env.GATEWAY_KV, keyObj.id);                   // 1 KV write
      if (i === attempt - 1) {
        return jsonError(502, 'upstream_unreachable', `All keys failed. Last error: ${err.message}`);
      }
      continue;
    } finally {
      clearTimeout(timer);
    }

    const errorCode = res.headers.get('x-straitly-error-code') || '';

    // ── Fatal account-level errors – return immediately, no key change ──
    if (FATAL_ERROR_CODES.has(errorCode)) {
      incrementStats(keyObj.id, { error: true, errorMsg: errorCode }); // memory
      incrementGlobalStats({ error: true });                            // memory
      return buildResponse(res, STRIP_RESPONSE_HEADERS);
    }

    // ── Bad key – disable permanently (1 KV write) and try next ─────────
    if (SKIP_STATUSES.has(res.status) || BAD_KEY_ERROR_CODES.has(errorCode)) {
      incrementStats(keyObj.id, { error: true, errorMsg: errorCode || `HTTP ${res.status}` }); // memory
      incrementGlobalStats({ error: true });                                                    // memory
      await markKeyBad(env.GATEWAY_KV, keyObj.id);                                            // 1 KV write
      if (i === attempt - 1) {
        return buildResponse(res, STRIP_RESPONSE_HEADERS);
      }
      continue;
    }

    // ── Rate limit / transient error – quarantine (1 KV write) and try next
    if (RETRY_STATUSES.has(res.status)) {
      incrementStats(keyObj.id, { error: true, errorMsg: `HTTP ${res.status}` }); // memory
      incrementGlobalStats({ error: true });                                        // memory
      await quarantineKey(env.GATEWAY_KV, keyObj.id);                             // 1 KV write
      if (i === attempt - 1) {
        return buildResponse(res, STRIP_RESPONSE_HEADERS);
      }
      continue;
    }

    // ── Success ──────────────────────────────────────────────────────────
    incrementStats(keyObj.id);    // memory only – 0 KV writes
    incrementGlobalStats();       // memory only – 0 KV writes
    return buildResponse(res, STRIP_RESPONSE_HEADERS);
  }

  incrementGlobalStats({ error: true });
  return jsonError(502, 'all_keys_failed', 'All available keys failed or are rate-limited.');
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildResponse(upstreamRes, stripHeaders) {
  const headers = new Headers();
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (!stripHeaders.has(k.toLowerCase())) {
      headers.set(k, v);
    }
  }
  headers.set('access-control-allow-origin', '*');

  return new Response(upstreamRes.body, {
    status:     upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers,
  });
}

export function jsonError(status, code, message) {
  return new Response(
    JSON.stringify({ error: { message, type: 'gateway_error', code } }),
    {
      status,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      },
    },
  );
}
