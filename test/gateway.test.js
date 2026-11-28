/**
 * Gateway test suite.
 *
 * Uses Node.js built-in test runner (node --test).
 * Does NOT require a live Cloudflare deployment.
 *
 * Run:  node --test test/
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── minimal KV stub ────────────────────────────────────────────────────────

function makeKV() {
  const store = new Map();
  return {
    async get(k)    { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}

// ─── minimal env stub ────────────────────────────────────────────────────────

function makeEnv(overrides = {}) {
  return {
    GATEWAY_KV:              makeKV(),
    GATEWAY_SECRET:          'test-gateway-secret',
    ADMIN_SECRET:            'test-admin-secret',
    UPSTREAM_BASE_URL:       'https://api.straitly.ai/v1',
    MAX_RETRIES:             '3',
    REQUEST_TIMEOUT_MS:      '10000',
    RATE_LIMIT_MAX_REQUESTS: '1000',
    RATE_LIMIT_WINDOW_MS:    '60000',
    ...overrides,
  };
}

// ─── imports ────────────────────────────────────────────────────────────────

import {
  hashKey, maskKey,
  addKey, removeKey, setKeyEnabled, listKeys, getOrderedKeys,
  incrementStats, incrementGlobalStats,
  getStats, getGlobalStats,
  flushStats, STATS_FLUSH_INTERVAL_MS,
  _getMemStats, _resetMemory,
} from '../src/keys.js';
import { checkRateLimit } from '../src/ratelimit.js';
import worker from '../src/index.js';

// Reset all module-level memory before each test so tests are independent.
beforeEach(() => _resetMemory());

// ─── key management tests ────────────────────────────────────────────────────

describe('hashKey', () => {
  it('returns an 8-char hex string', async () => {
    const h = await hashKey('sk-test-abc123');
    assert.match(h, /^[0-9a-f]{8}$/);
  });

  it('is deterministic', async () => {
    const a = await hashKey('sk-same-key');
    const b = await hashKey('sk-same-key');
    assert.equal(a, b);
  });

  it('differs for different keys', async () => {
    const a = await hashKey('sk-key-one');
    const b = await hashKey('sk-key-two');
    assert.notEqual(a, b);
  });
});

describe('maskKey', () => {
  it('shows only first 4 and last 4 chars', () => {
    const m = maskKey('sk-abcdefghij1234');
    assert.equal(m, 'sk-a…1234');
  });

  it('handles short keys', () => {
    assert.equal(maskKey('ab'), '***');
  });

  it('never returns the full key', () => {
    const key = 'sk-supersecretkey9999';
    const m   = maskKey(key);
    assert.notEqual(m, key);
    assert.ok(!m.includes('supersecret'));
  });
});

describe('addKey / removeKey / listKeys', () => {
  it('adds a key and lists it', async () => {
    const kv = makeKV();
    await addKey(kv, 'sk-testkey001', 'Test Key 1');
    const keys = await listKeys(kv);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].label, 'Test Key 1');
    assert.ok(keys[0].enabled);
  });

  it('rejects duplicate keys', async () => {
    const kv = makeKV();
    await addKey(kv, 'sk-duplicate', 'First');
    const r = await addKey(kv, 'sk-duplicate', 'Second');
    assert.ok(r.error);
    const keys = await listKeys(kv);
    assert.equal(keys.length, 1);
  });

  it('removes a key by id', async () => {
    const kv = makeKV();
    const { id } = await addKey(kv, 'sk-removeme', 'Remove Me');
    await removeKey(kv, id);
    const keys = await listKeys(kv);
    assert.equal(keys.length, 0);
  });

  it('returns error for missing key on remove', async () => {
    const kv = makeKV();
    const r = await removeKey(kv, 'nonexistent');
    assert.ok(r.error);
  });
});

describe('setKeyEnabled', () => {
  it('disables and re-enables a key', async () => {
    const kv = makeKV();
    const { id } = await addKey(kv, 'sk-toggleme', 'Toggle Me');
    await setKeyEnabled(kv, id, false);
    let keys = await listKeys(kv);
    assert.equal(keys[0].enabled, false);
    await setKeyEnabled(kv, id, true);
    keys = await listKeys(kv);
    assert.equal(keys[0].enabled, true);
  });
});

describe('getOrderedKeys', () => {
  it('returns empty array when no keys exist', async () => {
    const kv   = makeKV();
    const keys = await getOrderedKeys(kv);
    assert.equal(keys.length, 0);
  });

  it('returns only enabled, non-quarantined keys', async () => {
    const kv = makeKV();
    await addKey(kv, 'sk-active1', 'Active 1');
    await addKey(kv, 'sk-active2', 'Active 2');
    await addKey(kv, 'sk-disabled', 'Disabled');
    const all = await listKeys(kv);
    await setKeyEnabled(kv, all.find(k => k.label === 'Disabled').id, false);

    const keys = await getOrderedKeys(kv);
    assert.equal(keys.length, 2);
    assert.ok(keys.every(k => k.enabled));
  });

  it('rotates starting key across calls (LRU order)', async () => {
    const kv = makeKV();
    for (let i = 0; i < 4; i++) await addKey(kv, `sk-rotate-key-${i}`, `Key ${i}`);

    // First call: all lastUsed = 0, returns in list order
    const first = await getOrderedKeys(kv);
    // Simulate key 0 being used
    incrementStats(first[0].id);

    // Second call: key 0 now has lastUsed > 0, so it moves to the back
    const second = await getOrderedKeys(kv);
    assert.notEqual(first[0].id, second[0].id, 'LRU should not reuse most-recently-used key first');
  });

  it('skips quarantined keys', async () => {
    const kv = makeKV();
    await addKey(kv, 'sk-quar1', 'Key 1');
    await addKey(kv, 'sk-quar2', 'Key 2');

    const keys = await listKeys(kv);
    keys[0].quarantineUntil = Date.now() + 60_000;
    await kv.put('keys:list', JSON.stringify(keys));

    const ordered = await getOrderedKeys(kv);
    assert.equal(ordered.length, 1);
    assert.equal(ordered[0].label, 'Key 2');
  });
});

// ─── in-memory stats tests ───────────────────────────────────────────────────

describe('in-memory stats accumulation', () => {
  it('incrementStats accumulates without KV writes', () => {
    const { memStats } = _getMemStats();
    incrementStats('key-abc', { error: false });
    incrementStats('key-abc', { error: false });
    incrementStats('key-abc', { error: true, errorMsg: 'oops' });
    const s = memStats.get('key-abc');
    assert.equal(s.requests, 3);
    assert.equal(s.errors, 1);
    assert.equal(s.lastError, 'oops');
  });

  it('incrementGlobalStats accumulates without KV writes', () => {
    incrementGlobalStats({ error: false });
    incrementGlobalStats({ error: true });
    incrementGlobalStats({ error: false });
    const { memGlobal } = _getMemStats();
    assert.equal(memGlobal.totalRequests, 3);
    assert.equal(memGlobal.totalErrors, 1);
  });

  it('getStats merges KV snapshot with in-memory delta', async () => {
    const kv = makeKV();
    const { id } = await addKey(kv, 'sk-stats-merge', 'Merge Key');

    // Persist an existing snapshot to KV
    await kv.put(`stats:${id}`, JSON.stringify({ requests: 10, errors: 1, lastError: 'old', lastUsed: 1000 }));

    // Accumulate in memory (not yet flushed)
    incrementStats(id, { error: false });
    incrementStats(id, { error: true, errorMsg: 'new' });

    const stats = await getStats(kv);
    const row = stats.find(s => s.id === id);
    assert.equal(row.requests, 12, 'should merge 10 persisted + 2 in-memory');
    assert.equal(row.errors,    2, 'should merge 1 persisted + 1 in-memory');
    assert.equal(row.lastError, 'new', 'in-memory lastError should take precedence');
  });

  it('getGlobalStats merges KV snapshot with in-memory delta', async () => {
    const kv = makeKV();
    await kv.put('stats:global', JSON.stringify({
      totalRequests: 100, totalErrors: 5, startedAt: 999,
    }));

    incrementGlobalStats({ error: false });
    incrementGlobalStats({ error: true });

    const g = await getGlobalStats(kv);
    assert.equal(g.totalRequests, 102);
    assert.equal(g.totalErrors,    6);
    assert.equal(g.startedAt,     999);
  });

  it('flushStats writes accumulated deltas to KV then clears memory', async () => {
    const kv = makeKV();
    const { id } = await addKey(kv, 'sk-flush-key', 'Flush Key');

    incrementStats(id, { error: false });
    incrementStats(id, { error: true, errorMsg: 'err1' });
    incrementGlobalStats({ error: false });

    // Bypass the interval guard by backdating lastFlushAt
    _resetMemory();
    // Re-add deltas after reset (reset clears the interval guard too)
    incrementStats(id, { error: false });
    incrementGlobalStats({ error: false });

    await flushStats(kv);

    // Memory should be cleared after flush
    const { memStats, memGlobal } = _getMemStats();
    assert.equal(memStats.size, 0);
    assert.equal(memGlobal.totalRequests, 0);

    // KV should now hold the flushed values
    const raw = await kv.get(`stats:${id}`);
    const persisted = JSON.parse(raw);
    assert.equal(persisted.requests, 1);

    const global = JSON.parse(await kv.get('stats:global'));
    assert.equal(global.totalRequests, 1);
  });

  it('flushStats does not write to KV if nothing accumulated', async () => {
    const kv    = makeKV();
    let writes  = 0;
    const origPut = kv.put.bind(kv);
    kv.put = async (k, v) => { writes++; return origPut(k, v); };

    await flushStats(kv);
    assert.equal(writes, 0, 'No KV writes when stats are empty');
  });

  it('zero KV writes on successful proxy path (normal request)', async () => {
    const kv  = makeKV();
    const env = makeEnv({ GATEWAY_KV: kv });
    await addKey(kv, 'sk-zero-write', 'Zero Write Key');

    let writes = 0;
    // Intercept KV writes after setup is complete
    const origPut = kv.put.bind(kv);
    kv.put = async (k, v) => { writes++; return origPut(k, v); };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });

    try {
      const req = new Request('https://gateway.example.com/v1/models', {
        headers: { Authorization: 'Bearer test-gateway-secret' },
      });
      await worker.fetch(req, env, { waitUntil: () => {} });
      assert.equal(writes, 0, `Expected 0 KV writes on success, got ${writes}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('exactly 1 KV write when a key is quarantined (429)', async () => {
    const kv  = makeKV();
    const env = makeEnv({ GATEWAY_KV: kv, MAX_RETRIES: '1' });
    await addKey(kv, 'sk-429-key', '429 Key');

    let writes = 0;
    const origPut = kv.put.bind(kv);
    kv.put = async (k, v) => { writes++; return origPut(k, v); };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });

    try {
      await worker.fetch(
        new Request('https://gateway.example.com/v1/models', {
          headers: { Authorization: 'Bearer test-gateway-secret' },
        }),
        env, { waitUntil: () => {} },
      );
      // 1 write: quarantine update to keys:list
      assert.equal(writes, 1, `Expected 1 KV write for quarantine, got ${writes}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── rate limiter tests ───────────────────────────────────────────────────────

describe('checkRateLimit', () => {
  it('allows requests under the limit', () => {
    const r = checkRateLimit('client-a', 10, 60_000);
    assert.equal(r.limited, false);
    assert.ok(r.remaining <= 10);
  });

  it('blocks requests over the limit', () => {
    const clientKey = 'client-block-' + Math.random();
    for (let i = 0; i < 5; i++) checkRateLimit(clientKey, 5, 60_000);
    const r = checkRateLimit(clientKey, 5, 60_000);
    assert.equal(r.limited, true);
    assert.equal(r.remaining, 0);
    assert.ok(r.retryAfter > 0);
  });

  it('different clients have independent counters', () => {
    const r1 = checkRateLimit('unique-client-x-' + Math.random(), 2, 60_000);
    const r2 = checkRateLimit('unique-client-y-' + Math.random(), 2, 60_000);
    assert.equal(r1.limited, false);
    assert.equal(r2.limited, false);
  });
});

// ─── worker authentication tests ─────────────────────────────────────────────

describe('worker authentication', () => {
  it('rejects requests without Authorization header', async () => {
    const req = new Request('https://gateway.example.com/v1/models');
    const res = await worker.fetch(req, makeEnv());
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'invalid_api_key');
  });

  it('rejects wrong gateway secret', async () => {
    const req = new Request('https://gateway.example.com/v1/models', {
      headers: { Authorization: 'Bearer wrong-secret' },
    });
    const res = await worker.fetch(req, makeEnv());
    assert.equal(res.status, 401);
  });

  it('accepts correct gateway secret', async () => {
    const req = new Request('https://gateway.example.com/v1/models', {
      headers: { Authorization: 'Bearer test-gateway-secret' },
    });
    const res = await worker.fetch(req, makeEnv());
    assert.ok([200, 503].includes(res.status));
  });
});

// ─── worker routing tests ─────────────────────────────────────────────────────

describe('worker routing', () => {
  it('returns 404 for unknown routes', async () => {
    const req = new Request('https://gateway.example.com/v1/unknown', {
      headers: { Authorization: 'Bearer test-gateway-secret' },
    });
    const res = await worker.fetch(req, makeEnv());
    assert.equal(res.status, 404);
  });

  it('handles CORS preflight with 204', async () => {
    const req = new Request('https://gateway.example.com/v1/chat/completions', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://myapp.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    });
    const res = await worker.fetch(req, makeEnv());
    assert.equal(res.status, 204);
    assert.ok(res.headers.get('access-control-allow-methods'));
  });

  it('returns 200 on /health', async () => {
    const req = new Request('https://gateway.example.com/health');
    const res = await worker.fetch(req, makeEnv());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  it('requires admin auth for /admin/keys', async () => {
    const req = new Request('https://gateway.example.com/admin/keys');
    const res = await worker.fetch(req, makeEnv());
    assert.equal(res.status, 401);
  });
});

// ─── admin API tests ──────────────────────────────────────────────────────────

describe('admin API', () => {
  it('lists keys (empty)', async () => {
    const env = makeEnv();
    const req = new Request('https://gateway.example.com/admin/keys', {
      headers: { Authorization: 'Bearer test-admin-secret' },
    });
    const res  = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it('adds a key via admin API', async () => {
    const env = makeEnv();
    const req = new Request('https://gateway.example.com/admin/keys', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key: 'sk-admin-added-key-001', label: 'Test' }),
    });
    const res  = await worker.fetch(req, env);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.ok);
    assert.ok(typeof body.id === 'string');
  });

  it('never exposes raw key in list response', async () => {
    const env = makeEnv();
    await addKey(env.GATEWAY_KV, 'sk-super-secret-key-xyz', 'Secret Key');
    const req = new Request('https://gateway.example.com/admin/keys', {
      headers: { Authorization: 'Bearer test-admin-secret' },
    });
    const res  = await worker.fetch(req, env);
    const text = await res.text();
    assert.ok(!text.includes('sk-super-secret-key-xyz'), 'Raw key must not appear in response');
    assert.ok(text.includes('sk-s'), 'Masked key should appear');
  });

  it('bulk imports multiple keys', async () => {
    const env = makeEnv();
    const req = new Request('https://gateway.example.com/admin/keys/bulk', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ keys: ['sk-bulk-1', 'sk-bulk-2', 'sk-bulk-3'] }),
    });
    const res  = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.filter(r => r.ok).length, 3);
  });

  it('returns stats (merged memory + KV)', async () => {
    const env = makeEnv();
    await addKey(env.GATEWAY_KV, 'sk-stats-key', 'Stats Key');
    // Accumulate some in-memory stats
    const all = await listKeys(env.GATEWAY_KV);
    incrementStats(all[0].id, { error: false });

    const req = new Request('https://gateway.example.com/admin/stats', {
      headers: { Authorization: 'Bearer test-admin-secret' },
    });
    const res  = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('global' in body);
    assert.ok('keys' in body);
    // The in-memory increment should be visible
    assert.ok(body.keys[0].requests >= 1);
  });

  it('returns health', async () => {
    const env = makeEnv();
    await addKey(env.GATEWAY_KV, 'sk-health-check', 'Health Key');
    const req = new Request('https://gateway.example.com/admin/health', {
      headers: { Authorization: 'Bearer test-admin-secret' },
    });
    const res  = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.ok('status' in body[0]);
    assert.ok('errorRate' in body[0]);
  });

  it('rejects wrong admin secret', async () => {
    const env = makeEnv();
    const req = new Request('https://gateway.example.com/admin/keys', {
      headers: { Authorization: 'Bearer wrong-admin-password' },
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 401);
  });

  it('enables and disables a key', async () => {
    const env = makeEnv();
    const { id } = await addKey(env.GATEWAY_KV, 'sk-toggle-via-api', 'Toggle');
    const disableReq = new Request(`https://gateway.example.com/admin/keys/${id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const disableRes = await worker.fetch(disableReq, env);
    assert.equal(disableRes.status, 200);
    const keys = await listKeys(env.GATEWAY_KV);
    assert.equal(keys.find(k => k.id === id).enabled, false);
  });

  it('deletes a key', async () => {
    const env = makeEnv();
    const { id } = await addKey(env.GATEWAY_KV, 'sk-delete-via-api', 'Delete Me');
    const req = new Request(`https://gateway.example.com/admin/keys/${id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-admin-secret' },
    });
    const res  = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const keys = await listKeys(env.GATEWAY_KV);
    assert.equal(keys.length, 0);
  });
});

// ─── key rotation and fallback tests ─────────────────────────────────────────

describe('key rotation and fallback', () => {
  it('returns 503 when no keys are available', async () => {
    const env = makeEnv();
    const req = new Request('https://gateway.example.com/v1/models', {
      headers: { Authorization: 'Bearer test-gateway-secret' },
    });
    const res  = await worker.fetch(req, env);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'no_keys_available');
  });

  it('proxies through when a key is available', async () => {
    const env = makeEnv();
    await addKey(env.GATEWAY_KV, 'sk-proxy-test-key', 'Proxy Key');

    const originalFetch   = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });

    try {
      const req = new Request('https://gateway.example.com/v1/models', {
        headers: { Authorization: 'Bearer test-gateway-secret' },
      });
      const res  = await worker.fetch(req, env, { waitUntil: () => {} });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.object, 'list');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to next key on 429 from upstream', async () => {
    const env = makeEnv({ MAX_RETRIES: '3' });
    await addKey(env.GATEWAY_KV, 'sk-ratelimited-key-1', 'Key 1');
    await addKey(env.GATEWAY_KV, 'sk-ratelimited-key-2', 'Key 2');

    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });
      }
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'gpt-4' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      const req = new Request('https://gateway.example.com/v1/models', {
        headers: { Authorization: 'Bearer test-gateway-secret' },
      });
      const res = await worker.fetch(req, env, { waitUntil: () => {} });
      assert.equal(res.status, 200);
      assert.equal(callCount, 2, 'Should have tried 2 keys');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks key as bad on 401 from upstream', async () => {
    const env = makeEnv({ MAX_RETRIES: '1' });
    await addKey(env.GATEWAY_KV, 'sk-bad-upstream-key', 'Bad Key');

    const originalFetch = globalThis.fetch;
    globalThis.fetch    = async () =>
      new Response(JSON.stringify({ error: 'invalid key' }), { status: 401 });

    try {
      await worker.fetch(
        new Request('https://gateway.example.com/v1/models', {
          headers: { Authorization: 'Bearer test-gateway-secret' },
        }),
        env, { waitUntil: () => {} },
      );
      const keys = await listKeys(env.GATEWAY_KV);
      assert.equal(keys[0].enabled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── streaming tests ──────────────────────────────────────────────────────────

describe('streaming responses', () => {
  it('passes through streaming SSE response body unchanged', async () => {
    const env = makeEnv();
    await addKey(env.GATEWAY_KV, 'sk-stream-key', 'Stream Key');

    const sseData = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const originalFetch = globalThis.fetch;
    globalThis.fetch    = async () =>
      new Response(sseData, { status: 200, headers: { 'content-type': 'text/event-stream' } });

    try {
      const req = new Request('https://gateway.example.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-gateway-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      const res = await worker.fetch(req, env, { waitUntil: () => {} });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
      const text = await res.text();
      assert.ok(text.includes('[DONE]'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── content-type validation ──────────────────────────────────────────────────

describe('content-type validation', () => {
  it('rejects chat/completions with wrong content-type', async () => {
    const env = makeEnv();
    await addKey(env.GATEWAY_KV, 'sk-ct-key', 'CT Key');
    const req = new Request('https://gateway.example.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization:  'Bearer test-gateway-secret',
        'Content-Type': 'text/plain',
      },
      body: 'not json',
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 400);
  });
});

// ─── concurrency tests ────────────────────────────────────────────────────────

describe('concurrent requests', () => {
  it('handles concurrent requests and all succeed', async () => {
    const env = makeEnv();
    for (let i = 0; i < 5; i++) {
      await addKey(env.GATEWAY_KV, `sk-concurrent-${i}`, `Key ${i}`);
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch    = async () =>
      new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });

    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          worker.fetch(
            new Request('https://gateway.example.com/v1/models', {
              headers: { Authorization: 'Bearer test-gateway-secret' },
            }),
            env, { waitUntil: () => {} },
          ),
        ),
      );
      assert.ok(results.every(r => r.status === 200), 'All concurrent requests should return 200');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('LRU distributes keys evenly across sequential requests', async () => {
    const env = makeEnv();
    for (let i = 0; i < 4; i++) {
      await addKey(env.GATEWAY_KV, `sk-rr-seq-${i}`, `RR Key ${i}`);
    }

    const keysUsed      = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch    = async (url, opts) => {
      const h = opts.headers instanceof Headers
        ? opts.headers.get('Authorization')
        : (opts.headers?.Authorization ?? '');
      keysUsed.push(h);
      return new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };

    try {
      for (let i = 0; i < 4; i++) {
        await worker.fetch(
          new Request('https://gateway.example.com/v1/models', {
            headers: { Authorization: 'Bearer test-gateway-secret' },
          }),
          env, { waitUntil: () => {} },
        );
      }
      const unique = new Set(keysUsed);
      assert.ok(
        unique.size >= 2,
        `Expected ≥2 distinct upstream keys across 4 requests, got ${unique.size}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
