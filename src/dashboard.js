/**
 * Admin dashboard HTML.
 *
 * A self-contained single-page app served from /admin/.
 * All API calls go to /admin/* with Bearer token from sessionStorage.
 * Keys are never displayed in full – only masked representations.
 */

export function adminDashboardHtml() {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Straitly Gateway Admin</title>
<style>
  :root {
    --bg: #0f1117; --card: #1a1d27; --border: #2a2d3a;
    --text: #e2e4f0; --muted: #8b8fa8; --accent: #6366f1;
    --green: #22c55e; --red: #ef4444; --yellow: #eab308;
    --blue: #3b82f6;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.6 'Segoe UI', system-ui, sans-serif; min-height: 100vh; }
  header { background: var(--card); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 18px; font-weight: 600; }
  header .badge { background: var(--accent); color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 999px; }
  nav { display: flex; gap: 4px; padding: 16px 24px 0; }
  nav button { background: none; border: 1px solid var(--border); color: var(--muted); cursor: pointer; padding: 7px 16px; border-radius: 6px; font-size: 13px; transition: all .15s; }
  nav button.active, nav button:hover { background: var(--accent); border-color: var(--accent); color: #fff; }
  main { padding: 24px; }
  .tab { display: none; } .tab.active { display: block; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  .card h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: var(--text); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--border); }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pill.active    { background: #14532d; color: var(--green); }
  .pill.disabled  { background: #450a0a; color: var(--red); }
  .pill.quarantined { background: #422006; color: var(--yellow); }
  .btn { cursor: pointer; border: none; border-radius: 6px; padding: 5px 12px; font-size: 12px; font-weight: 500; transition: opacity .15s; }
  .btn:hover { opacity: .8; }
  .btn-sm { padding: 3px 9px; font-size: 11px; }
  .btn-primary  { background: var(--accent); color: #fff; }
  .btn-danger   { background: var(--red); color: #fff; }
  .btn-success  { background: var(--green); color: #000; }
  .btn-warning  { background: var(--yellow); color: #000; }
  .btn-ghost    { background: var(--border); color: var(--text); }
  input, textarea { background: #252835; border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 8px 12px; font-size: 13px; width: 100%; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  .form-label { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .stat-card { background: #252835; border-radius: 8px; padding: 16px; }
  .stat-value { font-size: 28px; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .msg { padding: 10px 14px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
  .msg-ok  { background: #14532d44; border: 1px solid var(--green); color: var(--green); }
  .msg-err { background: #450a0a44; border: 1px solid var(--red); color: var(--red); }
  .mono { font-family: 'Consolas', 'Courier New', monospace; font-size: 12px; }
  .actions { display: flex; gap: 6px; }
</style>
</head>
<body>
<header>
  <h1>Straitly Gateway</h1>
  <span class="badge">Admin</span>
  <span id="gateway-url" style="margin-left:auto;font-size:12px;color:var(--muted)"></span>
</header>
<nav>
  <button class="active" onclick="showTab('keys',this)">🔑 Keys</button>
  <button onclick="showTab('stats',this)">📊 Stats</button>
  <button onclick="showTab('health',this)">❤️ Health</button>
  <button onclick="showTab('add',this)">➕ Add Keys</button>
  <button onclick="showTab('config',this)">⚙️ Config</button>
</nav>
<main>

<!-- Keys tab -->
<div id="tab-keys" class="tab active">
  <div class="card">
    <h2>API Keys <button class="btn btn-ghost btn-sm" style="float:right" onclick="loadKeys()">↻ Refresh</button></h2>
    <div id="keys-msg"></div>
    <table>
      <thead><tr><th>ID</th><th>Label</th><th>Key</th><th>Status</th><th>Added</th><th>Actions</th></tr></thead>
      <tbody id="keys-tbody"><tr><td colspan="6" style="color:var(--muted);text-align:center">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<!-- Stats tab -->
<div id="tab-stats" class="tab">
  <div class="card">
    <h2>Global Statistics</h2>
    <div class="stat-grid" id="global-stats"></div>
  </div>
  <div class="card">
    <h2>Per-Key Statistics <button class="btn btn-ghost btn-sm" style="float:right" onclick="loadStats()">↻ Refresh</button></h2>
    <table>
      <thead><tr><th>ID</th><th>Label</th><th>Requests</th><th>Errors</th><th>Error Rate</th><th>Last Used</th><th>Last Error</th><th></th></tr></thead>
      <tbody id="stats-tbody"><tr><td colspan="8" style="color:var(--muted);text-align:center">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<!-- Health tab -->
<div id="tab-health" class="tab">
  <div class="card">
    <h2>Key Health <button class="btn btn-ghost btn-sm" style="float:right" onclick="loadHealth()">↻ Refresh</button></h2>
    <table>
      <thead><tr><th>ID</th><th>Label</th><th>Status</th><th>Requests</th><th>Error Rate</th><th>Last Used</th><th>Last Error</th><th>Actions</th></tr></thead>
      <tbody id="health-tbody"><tr><td colspan="8" style="color:var(--muted);text-align:center">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<!-- Add tab -->
<div id="tab-add" class="tab">
  <div class="card">
    <h2>Add a Single Key</h2>
    <div id="add-msg"></div>
    <div class="form-row">
      <div>
        <div class="form-label">Straitly API Key</div>
        <input id="new-key" type="password" placeholder="sk-…">
      </div>
      <div>
        <div class="form-label">Label (optional)</div>
        <input id="new-label" type="text" placeholder="Key #1 – team A">
      </div>
    </div>
    <button class="btn btn-primary" onclick="addSingleKey()">Add Key</button>
  </div>
  <div class="card">
    <h2>Bulk Import</h2>
    <div id="bulk-msg"></div>
    <div class="form-label" style="margin-bottom:6px">Paste one key per line</div>
    <textarea id="bulk-keys" rows="8" placeholder="sk-key1&#10;sk-key2&#10;sk-key3"></textarea>
    <button class="btn btn-primary" style="margin-top:12px" onclick="bulkImport()">Import All</button>
  </div>
</div>

<!-- Config tab -->
<div id="tab-config" class="tab">
  <div class="card">
    <h2>Gateway Configuration</h2>
    <div id="config-msg"></div>
    <div id="config-form"></div>
    <button class="btn btn-primary" style="margin-top:12px" onclick="saveConfig()">Save</button>
  </div>
</div>

</main>

<script>
const BASE = '';  // same origin
let token = '';

// Grab the admin token from Basic-Auth header that the browser already sent.
// We piggyback on it by prompting once and storing in sessionStorage.
(function initToken() {
  token = sessionStorage.getItem('admin_token') || '';
  if (!token) {
    const t = prompt('Enter admin password:');
    if (t) { token = t; sessionStorage.setItem('admin_token', t); }
  }
  document.getElementById('gateway-url').textContent = window.location.origin + '/v1';
})();

function showTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'keys')   loadKeys();
  if (name === 'stats')  loadStats();
  if (name === 'health') loadHealth();
  if (name === 'config') loadConfig();
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + '/admin' + path, opts);
  return r.json();
}

function statusPill(s) {
  return \`<span class="pill \${s}">\${s}</span>\`;
}
function ts(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}
function isoTs(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString();
}

// ── Keys ──────────────────────────────────────────────────────────────────
async function loadKeys() {
  const keys = await api('GET', '/keys');
  if (!Array.isArray(keys)) { setMsg('keys-msg', 'err', JSON.stringify(keys)); return; }
  const now = Date.now();
  document.getElementById('keys-tbody').innerHTML = keys.length === 0
    ? '<tr><td colspan="6" style="color:var(--muted);text-align:center">No keys yet. Add some.</td></tr>'
    : keys.map(k => {
        const status = !k.enabled ? 'disabled' : k.quarantineUntil > now ? 'quarantined' : 'active';
        return \`<tr>
          <td class="mono">\${k.id}</td>
          <td>\${esc(k.label)}</td>
          <td class="mono" style="color:var(--muted)">\${esc(k.masked)}</td>
          <td>\${statusPill(status)}</td>
          <td style="color:var(--muted);font-size:12px">\${ts(k.addedAt)}</td>
          <td class="actions">
            \${k.enabled
              ? \`<button class="btn btn-warning btn-sm" onclick="toggleKey('\${k.id}',false)">Disable</button>\`
              : \`<button class="btn btn-success btn-sm" onclick="toggleKey('\${k.id}',true)">Enable</button>\`}
            <button class="btn btn-danger btn-sm" onclick="deleteKey('\${k.id}')">Delete</button>
          </td>
        </tr>\`;
      }).join('');
}

async function toggleKey(id, enabled) {
  const r = await api('PATCH', '/keys/' + id, { enabled });
  setMsg('keys-msg', r.error ? 'err' : 'ok', r.error || (enabled ? 'Key enabled.' : 'Key disabled.'));
  loadKeys();
}

async function deleteKey(id) {
  if (!confirm('Delete key ' + id + '? This cannot be undone.')) return;
  const r = await api('DELETE', '/keys/' + id);
  setMsg('keys-msg', r.error ? 'err' : 'ok', r.error || 'Key deleted.');
  loadKeys();
}

async function addSingleKey() {
  const key = document.getElementById('new-key').value.trim();
  const label = document.getElementById('new-label').value.trim();
  if (!key) { setMsg('add-msg', 'err', 'Key is required.'); return; }
  const r = await api('POST', '/keys', { key, label });
  if (r.error) { setMsg('add-msg', 'err', r.error); return; }
  setMsg('add-msg', 'ok', 'Key added (' + r.id + ').');
  document.getElementById('new-key').value = '';
  document.getElementById('new-label').value = '';
}

async function bulkImport() {
  const lines = document.getElementById('bulk-keys').value
    .split('\\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) { setMsg('bulk-msg', 'err', 'No keys found.'); return; }
  const r = await api('POST', '/keys/bulk', { keys: lines });
  const added = r.filter(x => x.ok).length;
  const dups  = r.filter(x => x.error).length;
  setMsg('bulk-msg', 'ok', \`Imported \${added} key(s). \${dups} duplicate(s) skipped.\`);
  document.getElementById('bulk-keys').value = '';
}

// ── Stats ─────────────────────────────────────────────────────────────────
async function loadStats() {
  const data = await api('GET', '/stats');
  if (!data.global) { return; }
  const g = data.global;
  document.getElementById('global-stats').innerHTML = \`
    <div class="stat-card"><div class="stat-value">\${g.totalRequests}</div><div class="stat-label">Total Requests</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--red)">\${g.totalErrors}</div><div class="stat-label">Total Errors</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--green)">\${g.totalRequests - g.totalErrors}</div><div class="stat-label">Successful</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--yellow)">\${g.totalRequests > 0 ? ((g.totalErrors/g.totalRequests)*100).toFixed(1) : 0}%</div><div class="stat-label">Error Rate</div></div>
    <div class="stat-card"><div class="stat-value" style="font-size:16px;color:var(--muted)">\${isoTs(g.startedAt)}</div><div class="stat-label">Started At</div></div>
  \`;
  document.getElementById('stats-tbody').innerHTML = data.keys.length === 0
    ? '<tr><td colspan="8" style="color:var(--muted);text-align:center">No data yet.</td></tr>'
    : data.keys.map(k => \`<tr>
        <td class="mono">\${k.id}</td>
        <td>\${esc(k.label)}</td>
        <td>\${k.requests}</td>
        <td style="color:\${k.errors>0?'var(--red)':'var(--green)'}">\${k.errors}</td>
        <td>\${k.requests>0?((k.errors/k.requests)*100).toFixed(1)+'%':'0%'}</td>
        <td style="font-size:12px;color:var(--muted)">\${ts(k.lastUsed)}</td>
        <td style="font-size:12px;color:var(--red);max-width:200px;overflow:hidden;text-overflow:ellipsis">\${esc(k.lastError||'')}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="resetStats('\${k.id}')">Reset</button></td>
      </tr>\`).join('');
}

async function resetStats(id) {
  if (!confirm('Reset stats for key ' + id + '?')) return;
  await api('DELETE', '/stats/' + id);
  loadStats();
}

// ── Health ────────────────────────────────────────────────────────────────
async function loadHealth() {
  const data = await api('GET', '/health');
  if (!Array.isArray(data)) return;
  document.getElementById('health-tbody').innerHTML = data.length === 0
    ? '<tr><td colspan="8" style="color:var(--muted);text-align:center">No keys.</td></tr>'
    : data.map(k => \`<tr>
        <td class="mono">\${k.id}</td>
        <td>\${esc(k.label)}</td>
        <td>\${statusPill(k.status)}</td>
        <td>\${k.requests}</td>
        <td style="color:\${parseFloat(k.errorRate)>10?'var(--red)':parseFloat(k.errorRate)>0?'var(--yellow)':'var(--green)'}">\${k.errorRate}</td>
        <td style="font-size:12px;color:var(--muted)">\${isoTs(k.lastUsed)}</td>
        <td style="font-size:12px;color:var(--red);max-width:180px;overflow:hidden;text-overflow:ellipsis" title="\${esc(k.lastError||'')}">\${esc(k.lastError||'—')}</td>
        <td>\${k.status==='quarantined'||k.status==='disabled'
            ? \`<button class="btn btn-success btn-sm" onclick="unquarantine('\${k.id}')">Re-enable</button>\`
            : '—'}</td>
      </tr>\`).join('');
}

async function unquarantine(id) {
  await api('POST', '/keys/' + id + '/unquarantine');
  loadHealth();
}

// ── Config ────────────────────────────────────────────────────────────────
let currentConfig = {};
async function loadConfig() {
  currentConfig = await api('GET', '/config');
  document.getElementById('config-form').innerHTML = \`
    <div class="form-row">
      <div>
        <div class="form-label">Max Retries (1–20)</div>
        <input id="cfg-maxRetries" type="number" min="1" max="20" value="\${currentConfig.maxRetries||5}">
      </div>
      <div>
        <div class="form-label">Request Timeout (ms)</div>
        <input id="cfg-timeoutMs" type="number" min="5000" max="300000" value="\${currentConfig.timeoutMs||120000}">
      </div>
    </div>
    <div class="form-row">
      <div>
        <div class="form-label">Rate Limit – Max Requests per Window</div>
        <input id="cfg-rateLimitMax" type="number" min="1" value="\${currentConfig.rateLimitMax||200}">
      </div>
      <div>
        <div class="form-label">Rate Limit – Window (ms)</div>
        <input id="cfg-rateLimitWindowMs" type="number" min="1000" value="\${currentConfig.rateLimitWindowMs||60000}">
      </div>
    </div>
    <div>
      <div class="form-label">Allowed CORS Origin (blank = *)</div>
      <input id="cfg-allowedOrigin" type="text" placeholder="https://your-app.example.com" value="\${currentConfig.allowedOrigin||''}">
    </div>
  \`;
}

async function saveConfig() {
  const cfg = {
    maxRetries:       parseInt(document.getElementById('cfg-maxRetries').value),
    timeoutMs:        parseInt(document.getElementById('cfg-timeoutMs').value),
    rateLimitMax:     parseInt(document.getElementById('cfg-rateLimitMax').value),
    rateLimitWindowMs:parseInt(document.getElementById('cfg-rateLimitWindowMs').value),
    allowedOrigin:    document.getElementById('cfg-allowedOrigin').value.trim(),
  };
  const r = await api('PATCH', '/config', cfg);
  setMsg('config-msg', r.error ? 'err' : 'ok', r.error || 'Configuration saved.');
}

// ── Utilities ─────────────────────────────────────────────────────────────
function setMsg(id, type, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = \`<div class="msg msg-\${type}">\${esc(text)}</div>\`;
  setTimeout(() => { el.innerHTML = ''; }, 6000);
}

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// Auto-load first tab
loadKeys();
</script>
</body>
</html>`;
}
