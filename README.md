# Straitly Gateway

A production-ready, OpenAI-compatible API gateway that rotates up to 20+ Straitly.ai API keys behind a single endpoint.

**Runs on Cloudflare Workers Free plan. No server, no Docker, no VPS required.**

---

## What it does

- Exposes `POST /v1/chat/completions` and `GET /v1/models` with one stable API key
- Round-robins across your Straitly keys on every request
- Falls back to the next key automatically on 429 / 5xx / auth errors
- Quarantines failing keys for 60 s before retrying; permanently disables bad keys
- Streams SSE responses transparently (no buffering)
- Admin dashboard at `/admin/` with key management, stats, and health view
- In-memory rate limiting per client IP (no paid add-on needed)
- All secrets stored in Cloudflare — never in source code

---

## Architecture

```
Client (any OpenAI-compatible tool)
  │  Authorization: Bearer GATEWAY_SECRET
  ▼
Cloudflare Worker  (src/index.js)
  │  validates client auth
  │  rate-limits by IP
  ▼
Key manager  (src/keys.js)
  │  round-robin + quarantine from Cloudflare KV
  ▼
Proxy layer  (src/proxy.js)
  │  tries keys in order, retries on failure
  ▼
Straitly API  (https://api.straitly.ai/v1)
```

**Storage:** Cloudflare KV (`GATEWAY_KV` binding)

| KV key | Contents |
|---|---|
| `keys:list` | JSON array of key objects (key values stored here — secured by Cloudflare) |
| `stats:<id>` | Per-key request/error counters (written only on flush, not per-request) |
| `stats:global` | Total request/error counters (written only on flush) |
| `config:main` | Runtime-adjustable gateway config |

**KV write budget on the Free plan: 1 000 writes/day.**

The gateway is designed around zero KV writes on the normal (success) path:

| Event | KV writes |
|---|---|
| Successful request | **0** — rotation is in-memory; stats accumulate in memory |
| Key quarantined (429 / 5xx) | 1 — saves `quarantineUntil` so it survives isolate recycle |
| Key permanently disabled (401) | 1 — saves `enabled: false` durably |
| Stats flush (every 5 min, via `waitUntil`) | ≤ keyCount + 1 — only if requests arrived since last flush |
| Admin mutations (add / remove / enable key) | 1 each |

**Practical capacity:** with 20 keys, all healthy, stats flush every 5 minutes, the gateway costs at most 21 KV writes per 5-minute window from flushing, plus 1 per admin action. That is ≤ 6 048 flush-writes/day at maximum — but only if every single key sees traffic each window. In a typical personal-gateway scenario with a handful of active keys the daily write cost is a few hundred at most.

The first real constraint on the Free plan is Worker requests (100 k/day), not KV writes.

---

## File structure

```
.
├── src/
│   ├── index.js       — Worker entry point, routing, auth, rate limiting
│   ├── proxy.js       — Multi-key upstream proxy with fallback
│   ├── keys.js        — Key CRUD, round-robin selection, stats
│   ├── admin.js       — Admin REST API
│   ├── dashboard.js   — Admin HTML dashboard (self-contained SPA)
│   ├── ratelimit.js   — In-memory sliding-window rate limiter
│   └── constants.js   — Shared error codes and KV key names
├── test/
│   └── gateway.test.js — 42 tests (Node built-in runner)
├── wrangler.toml
├── package.json
└── .github/workflows/deploy.yml
```

---

## Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency)
- A Cloudflare account (free)
- A GitHub account

### 2. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/straitly-gateway.git
cd straitly-gateway
npm install
```

### 3. Create the KV namespace

```bash
npx wrangler kv:namespace create GATEWAY_KV
# Note the id printed, e.g.:  id = "abc123..."

npx wrangler kv:namespace create GATEWAY_KV --preview
# Note the preview_id
```

Edit `wrangler.toml` and replace both placeholder IDs:

```toml
[[kv_namespaces]]
binding = "GATEWAY_KV"
id = "YOUR_PRODUCTION_ID_HERE"
preview_id = "YOUR_PREVIEW_ID_HERE"
```

### 4. Set secrets

These are never stored in Git. Run each command and paste your value when prompted.

```bash
# The single API key your clients will use
npx wrangler secret put GATEWAY_SECRET

# A separate password for the admin dashboard
npx wrangler secret put ADMIN_SECRET
```

**Optional** — seed keys on the very first deploy without going through the admin UI:

```bash
npx wrangler secret put STRAITLY_KEYS_JSON
# Paste: ["sk-your-key-1","sk-your-key-2","sk-key-3"]
```

After keys are imported via the dashboard, you can delete this secret:
```bash
npx wrangler secret delete STRAITLY_KEYS_JSON
```

### 5. Deploy

```bash
npx wrangler deploy
```

Wrangler prints the worker URL, e.g. `https://straitly-gateway.YOUR_SUBDOMAIN.workers.dev`.

### 6. Custom domain

1. In the Cloudflare dashboard → **Workers & Pages** → your worker → **Settings** → **Domains & Routes**
2. Click **Add Custom Domain**
3. Enter `api.yourdomain.com` (the domain must be in your Cloudflare account)
4. Cloudflare provisions the certificate automatically

Your gateway is now live at `https://api.yourdomain.com`.

---

## GitHub Actions (auto-deploy on push)

Add these two secrets to your GitHub repository (**Settings → Secrets → Actions**):

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token with **Edit Workers** permission |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID (from the dashboard URL) |

Every push to `main` runs the test suite and then deploys.

To create the Cloudflare API token:
1. Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. **Create Token** → **Edit Cloudflare Workers** template
3. Set **Account Resources** to your account
4. Copy the token into the GitHub secret

---

## Usage

### Chat completions

```bash
curl https://api.yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5-5",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Streaming

```bash
curl https://api.yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5-5",
    "messages": [{"role": "user", "content": "Count to 5"}],
    "stream": true
  }'
```

### List models

```bash
curl https://api.yourdomain.com/v1/models \
  -H "Authorization: Bearer YOUR_GATEWAY_SECRET"
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.yourdomain.com/v1",
    api_key="YOUR_GATEWAY_SECRET",
)

response = client.chat.completions.create(
    model="claude-sonnet-5-5",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

---

## Admin dashboard

Open `https://api.yourdomain.com/admin/` in a browser. Enter your `ADMIN_SECRET` when prompted.

The dashboard lets you:
- View all keys (masked — never shown in full)
- Add / disable / delete individual keys
- Bulk-import keys (one per line)
- View per-key and global request stats
- Monitor key health (active / quarantined / disabled)
- Adjust gateway config (max retries, timeout, rate limits)
- Re-enable quarantined keys immediately

### Admin REST API

All endpoints require `Authorization: Bearer ADMIN_SECRET`.

```bash
# List keys
GET /admin/keys

# Add a key
POST /admin/keys
{"key": "sk-...", "label": "Team A"}

# Bulk import
POST /admin/keys/bulk
{"keys": ["sk-1", "sk-2", "sk-3"]}

# Disable / enable a key
PATCH /admin/keys/:id
{"enabled": false}

# Delete a key
DELETE /admin/keys/:id

# Stats
GET /admin/stats

# Health
GET /admin/health

# Config
GET /admin/config
PATCH /admin/config
{"maxRetries": 5, "timeoutMs": 60000}
```

---

## Key management behaviour

| Event | Gateway action |
|---|---|
| Upstream returns 429 | Quarantines key for 60 s, tries next key |
| Upstream returns 401 / 403 | Marks key disabled permanently |
| `X-Straitly-Error-Code: insufficient_credits` | Returns error immediately (no retry — balance issue) |
| `X-Straitly-Error-Code: invalid_api_key` | Marks key disabled |
| Upstream 5xx / network error | Quarantines key, tries next key |
| All keys exhausted | Returns 502 to client |

Quarantined keys automatically become eligible again after 60 seconds. Disabled keys require manual re-enable via the admin dashboard or API.

---

## Running tests

```bash
node --test test/
```

All 42 tests run in-process with no network calls and no Cloudflare account needed.

The test suite covers:
- Key hashing and masking
- Key CRUD (add, remove, enable/disable, duplicate rejection)
- Round-robin rotation and quarantine skipping
- Rate limiter (allow, block, independent client counters)
- Worker auth (no key, wrong key, correct key)
- Routing (404, CORS preflight, /health)
- Admin API (all endpoints, auth rejection, key masking)
- Key rotation fallback (503 on no keys, 429 triggers next key, 401 disables key)
- SSE streaming passthrough
- Content-type validation
- Concurrent requests

### Local development

```bash
npx wrangler dev
```

The worker runs at `http://localhost:8787`. Set secrets in a local `.env` file (see `.env.example`) or via `wrangler dev --var`.

---

## Security notes

- **GATEWAY_SECRET** and **ADMIN_SECRET** are stored as Cloudflare encrypted secrets, not in `wrangler.toml` or any committed file.
- Upstream Straitly keys are stored in Cloudflare KV, which is not accessible to clients. They are never returned by any API response.
- The admin API uses a timing-safe string comparison to prevent timing attacks on secret validation.
- Raw keys are never logged. Stats track only counts and truncated error codes.
- CORS is `*` by default. Set `ALLOWED_ORIGIN` in `wrangler.toml` or via `PATCH /admin/config` to restrict to your frontend domain.
- The `/health` endpoint is public (no auth) and returns only a request count — no sensitive information.

---

## Free-plan limits and actual capacity

| Resource | Free allowance | Gateway usage |
|---|---|---|
| Worker requests | 100 k/day | 1 per client request — **this is the primary cap** |
| Worker CPU time | 10 ms/request | Well under; no heavy computation |
| KV reads | 100 k/day | 1 per request (`keys:list`) + ≤2 per flush window |
| KV writes | 1 000/day | **0 on a successful request**; 1 per key failure; ≤21 per 5-min flush |
| KV storage | 1 GB | Negligible |

**The effective ceiling on the Free plan is 100 000 requests/day** — the Worker request limit — not KV.

If you hit 100 k/day you need Workers Paid ($5/month), which raises requests to 10 million/day and KV writes to 1 million/day. There is no cheaper intermediate tier for Workers.

---

## Troubleshooting

**"No upstream keys are available"**  
Add at least one key via the admin dashboard or `POST /admin/keys`.

**All keys become quarantined**  
Check key balances in the Straitly dashboard. `insufficient_credits` means the account balance is exhausted — this is an account-level issue, not a per-key issue.

**Admin dashboard shows 401**  
You entered the wrong `ADMIN_SECRET`. Use `wrangler secret put ADMIN_SECRET` to reset it.

**Deployment fails in GitHub Actions**  
Verify `CLOUDFLARE_API_TOKEN` has the **Edit Workers** permission and `CLOUDFLARE_ACCOUNT_ID` matches your account.
