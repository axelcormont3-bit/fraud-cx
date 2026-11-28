/**
 * Admin API – all routes require ADMIN_SECRET in Authorization header.
 *
 * Routes:
 *   GET  /admin/keys             list keys (masked)
 *   POST /admin/keys             add a key   body: { key, label? }
 *   DELETE /admin/keys/:id       remove a key
 *   PATCH /admin/keys/:id        update a key  body: { enabled?, label? }
 *   GET  /admin/stats            per-key + global stats
 *   GET  /admin/health           key health summary
 *   GET  /admin/config           current gateway config
 *   PATCH /admin/config          update config  body: { maxRetries?, timeoutMs?, rateLimitMax? }
 *   POST /admin/keys/bulk        import multiple keys  body: { keys: string[] }
 *   DELETE /admin/stats/:id      reset per-key stats
 *   POST /admin/keys/:id/unquarantine  lift quarantine immediately
 *   GET  /admin/                 HTML dashboard
 */

import {
  listKeys, addKey, removeKey, setKeyEnabled,
  getStats, getGlobalStats, maskKey,
} from './keys.js';
import { KV } from './constants.js';
import { adminDashboardHtml } from './dashboard.js';

export async function handleAdmin(request, env, pathname) {
  // ── auth ──────────────────────────────────────────────────────────────────
  const adminSecret = env.ADMIN_SECRET;
  if (!adminSecret) {
    return json(503, { error: 'Admin interface not configured (ADMIN_SECRET not set).' });
  }

  // Dashboard: basic-auth over the browser
  if (pathname === '/admin' || pathname === '/admin/') {
    return handleDashboard(request, env, adminSecret);
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  if (!constantTimeEqual(token, adminSecret)) {
    return json(401, { error: 'Invalid admin credentials.' });
  }

  const url    = new URL(request.url);
  const method = request.method.toUpperCase();
  const parts  = pathname.replace(/^\/admin\/?/, '').split('/').filter(Boolean);
  // parts[0] = resource  (keys | stats | health | config)
  // parts[1] = id
  // parts[2] = sub-action

  // ── routing ───────────────────────────────────────────────────────────────

  // GET /admin/keys
  if (method === 'GET' && parts[0] === 'keys' && !parts[1]) {
    const keys = await listKeys(env.GATEWAY_KV);
    return json(200, keys.map(safeKey));
  }

  // POST /admin/keys
  if (method === 'POST' && parts[0] === 'keys' && !parts[1]) {
    const body = await parseBody(request);
    if (!body.key) return json(400, { error: '`key` field required.' });
    const result = await addKey(env.GATEWAY_KV, body.key.trim(), body.label || '');
    if (result.error) return json(409, result);
    return json(201, result);
  }

  // POST /admin/keys/bulk
  if (method === 'POST' && parts[0] === 'keys' && parts[1] === 'bulk') {
    const body = await parseBody(request);
    if (!Array.isArray(body.keys)) return json(400, { error: '`keys` must be an array.' });
    const results = [];
    for (const k of body.keys) {
      if (typeof k === 'string' && k.trim()) {
        results.push(await addKey(env.GATEWAY_KV, k.trim(), body.label || ''));
      }
    }
    return json(200, results);
  }

  // DELETE /admin/keys/:id
  if (method === 'DELETE' && parts[0] === 'keys' && parts[1] && !parts[2]) {
    const result = await removeKey(env.GATEWAY_KV, parts[1]);
    if (result.error) return json(404, result);
    return json(200, result);
  }

  // PATCH /admin/keys/:id
  if (method === 'PATCH' && parts[0] === 'keys' && parts[1] && !parts[2]) {
    const body = await parseBody(request);
    const changes = {};
    if (typeof body.enabled === 'boolean') {
      changes.enabled = await setKeyEnabled(env.GATEWAY_KV, parts[1], body.enabled);
    }
    if (body.label !== undefined) {
      const keys = await listKeys(env.GATEWAY_KV);
      const k = keys.find(x => x.id === parts[1]);
      if (!k) return json(404, { error: 'Key not found.' });
      k.label = body.label;
      await env.GATEWAY_KV.put(KV.KEYS_LIST, JSON.stringify(keys));
      changes.label = { ok: true };
    }
    return json(200, changes);
  }

  // POST /admin/keys/:id/unquarantine
  if (method === 'POST' && parts[0] === 'keys' && parts[1] && parts[2] === 'unquarantine') {
    const result = await setKeyEnabled(env.GATEWAY_KV, parts[1], true);
    if (result.error) return json(404, result);
    return json(200, result);
  }

  // GET /admin/stats
  if (method === 'GET' && parts[0] === 'stats' && !parts[1]) {
    const [perKey, global] = await Promise.all([
      getStats(env.GATEWAY_KV),
      getGlobalStats(env.GATEWAY_KV),
    ]);
    return json(200, { global, keys: perKey });
  }

  // DELETE /admin/stats/:id  – reset a single key's stats
  if (method === 'DELETE' && parts[0] === 'stats' && parts[1]) {
    await env.GATEWAY_KV.put(
      KV.STATS_PREFIX + parts[1],
      JSON.stringify({ requests: 0, errors: 0, lastError: null, lastUsed: 0 }),
    );
    return json(200, { ok: true });
  }

  // GET /admin/health
  if (method === 'GET' && parts[0] === 'health') {
    const stats = await getStats(env.GATEWAY_KV);
    const now = Date.now();
    const summary = stats.map(s => ({
      id:      s.id,
      label:   s.label,
      status:  !s.enabled
                 ? 'disabled'
                 : s.quarantineUntil > now
                   ? 'quarantined'
                   : 'active',
      requests: s.requests,
      errors:   s.errors,
      errorRate: s.requests > 0 ? ((s.errors / s.requests) * 100).toFixed(1) + '%' : '0%',
      lastUsed: s.lastUsed ? new Date(s.lastUsed).toISOString() : null,
      lastError: s.lastError,
    }));
    return json(200, summary);
  }

  // GET /admin/config
  if (method === 'GET' && parts[0] === 'config') {
    const raw = await env.GATEWAY_KV.get(KV.CONFIG);
    const config = raw ? JSON.parse(raw) : {};
    return json(200, config);
  }

  // PATCH /admin/config
  if (method === 'PATCH' && parts[0] === 'config') {
    const body = await parseBody(request);
    const raw = await env.GATEWAY_KV.get(KV.CONFIG);
    const config = raw ? JSON.parse(raw) : {};
    const allowed = ['maxRetries', 'timeoutMs', 'rateLimitMax', 'rateLimitWindowMs', 'allowedOrigin'];
    for (const k of allowed) {
      if (body[k] !== undefined) config[k] = body[k];
    }
    await env.GATEWAY_KV.put(KV.CONFIG, JSON.stringify(config));
    return json(200, config);
  }

  return json(404, { error: 'Unknown admin route.' });
}

// ─── dashboard ───────────────────────────────────────────────────────────────

async function handleDashboard(request, env, adminSecret) {
  // HTTP Basic Auth so browsers prompt for credentials
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Basic ')) {
    const decoded = atob(authHeader.slice(6));
    const colonAt = decoded.indexOf(':');
    const pass = colonAt >= 0 ? decoded.slice(colonAt + 1) : decoded;
    if (constantTimeEqual(pass, adminSecret)) {
      const html = adminDashboardHtml();
      return new Response(html, {
        headers: { 'content-type': 'text/html;charset=UTF-8' },
      });
    }
  }
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Straitly Gateway Admin"',
      'content-type': 'text/plain',
    },
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function safeKey(k) {
  const { key, ...rest } = k; // drop raw key value
  return { ...rest, masked: maskKey(key) };
}

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/** Timing-safe string comparison to prevent timing attacks on secrets. */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    // Still compare to avoid timing leak on length difference
    let diff = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
