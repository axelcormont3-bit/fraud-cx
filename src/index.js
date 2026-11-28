/**
 * Straitly Gateway – Cloudflare Worker entry point.
 *
 * Route table:
 *   OPTIONS *                 → CORS preflight
 *   GET  /v1/models           → proxy to Straitly (key-rotated)
 *   POST /v1/chat/completions → proxy to Straitly (key-rotated, streams)
 *   GET  /admin/*             → admin dashboard (browser basic-auth)
 *   *    /admin/*             → admin API     (Bearer token)
 *   GET  /health              → public liveness probe
 *   *    *                    → 404
 *
 * Required secrets (set via `wrangler secret put`):
 *   GATEWAY_SECRET   – token clients send as `Authorization: Bearer …`
 *   ADMIN_SECRET     – token / password for admin routes
 *
 * Optional secrets:
 *   STRAITLY_KEYS_JSON – JSON array of key strings for one-shot bootstrap
 */

import { proxyRequest, jsonError } from './proxy.js';
import { handleAdmin } from './admin.js';
import { checkRateLimit, pruneWindows } from './ratelimit.js';
import { addKey, getGlobalStats } from './keys.js';

export default {
  async fetch(request, env, ctx) {
    // ── CORS pre-flight ───────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsPreFlight(request, env);
    }

    const url      = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, '') || '/';

    // ── Liveness probe (no auth) ──────────────────────────────────────────
    if (pathname === '/health' && request.method === 'GET') {
      return publicHealth(env);
    }

    // ── Admin routes ──────────────────────────────────────────────────────
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      return handleAdmin(request, env, pathname);
    }

    // ── Bootstrap: one-time key import via env var ────────────────────────
    await maybeBootstrapKeys(env);

    // ── Proxy routes – require GATEWAY_SECRET ────────────────────────────
    if (!pathname.startsWith('/v1/')) {
      return jsonError(404, 'not_found', `Unknown route: ${pathname}`);
    }

    // Auth check
    if (!env.GATEWAY_SECRET) {
      return jsonError(503, 'misconfigured', 'GATEWAY_SECRET is not configured.');
    }
    const authHeader = request.headers.get('Authorization') || '';
    const clientKey  = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (!timingSafeEqual(clientKey, env.GATEWAY_SECRET)) {
      return jsonError(401, 'invalid_api_key', 'Invalid or missing Authorization header.');
    }

    // Rate limiting (in-memory, best-effort)
    pruneWindows(60_000);
    const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
    const rlMax    = parseInt(env.RATE_LIMIT_MAX_REQUESTS || '200', 10);
    const rlWindow = parseInt(env.RATE_LIMIT_WINDOW_MS    || '60000', 10);
    const rl       = checkRateLimit(clientIp, rlMax, rlWindow);
    if (rl.limited) {
      return new Response(
        JSON.stringify({ error: { message: 'Rate limit exceeded.', type: 'rate_limit_error', code: 429 } }),
        {
          status: 429,
          headers: {
            'content-type':          'application/json',
            'retry-after':           String(rl.retryAfter),
            'x-ratelimit-limit':     String(rlMax),
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset':     String(Math.floor(rl.resetAt / 1000)),
            'access-control-allow-origin': corsOrigin(request, env),
          },
        },
      );
    }

    // Supported proxy endpoints
    const allowed = [
      { method: 'GET',  path: '/v1/models' },
      { method: 'POST', path: '/v1/chat/completions' },
    ];
    if (!allowed.some(r => r.method === request.method && pathname === r.path)) {
      return jsonError(404, 'not_found', `Route not supported: ${request.method} ${pathname}`);
    }

    // Basic request validation for chat completions
    if (pathname === '/v1/chat/completions' && request.method === 'POST') {
      const contentType = request.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        return jsonError(400, 'invalid_request', 'Content-Type must be application/json.');
      }
    }

    // Forward to Straitly; pass ctx so proxy can schedule waitUntil flushes
    const response = await proxyRequest(request, env, ctx);

    // Inject CORS on the proxied response
    const headers = new Headers(response.headers);
    headers.set('access-control-allow-origin', corsOrigin(request, env));
    headers.set('access-control-allow-credentials', 'true');
    return new Response(response.body, {
      status:     response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

// ─── helpers ────────────────────────────────────────────────────────────────

function corsPreFlight(request, env) {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin':  corsOrigin(request, env),
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, Accept',
      'access-control-max-age':       '86400',
    },
  });
}

function corsOrigin(request, env) {
  const allowed = env.ALLOWED_ORIGIN || '*';
  if (allowed === '*') return '*';
  const origin = request.headers.get('origin') || '';
  return origin === allowed ? allowed : allowed;
}

async function publicHealth(env) {
  try {
    const stats = await getGlobalStats(env.GATEWAY_KV);
    return new Response(
      JSON.stringify({ status: 'ok', totalRequests: stats.totalRequests }),
      { headers: { 'content-type': 'application/json' } },
    );
  } catch {
    return new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'content-type': 'application/json' },
    });
  }
}

let bootstrapped = false;
async function maybeBootstrapKeys(env) {
  if (bootstrapped) return;
  bootstrapped = true;

  const keysJson = env.STRAITLY_KEYS_JSON;
  if (!keysJson) return;

  try {
    const existing = await env.GATEWAY_KV.get('keys:list');
    if (existing && JSON.parse(existing).length > 0) return;

    const keys = JSON.parse(keysJson);
    if (!Array.isArray(keys)) return;

    for (const k of keys) {
      if (typeof k === 'string' && k.trim()) {
        await addKey(env.GATEWAY_KV, k.trim());
      }
    }
  } catch {
    // Non-fatal
  }
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const la = a.padEnd(Math.max(a.length, b.length), '\0');
  const lb = b.padEnd(Math.max(a.length, b.length), '\0');
  let diff = a.length !== b.length ? 1 : 0;
  for (let i = 0; i < la.length; i++) {
    diff |= la.charCodeAt(i) ^ lb.charCodeAt(i);
  }
  return diff === 0;
}
