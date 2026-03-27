/**
 * Anty Browser — Headless REST API server
 *
 * Start: npm run start:server
 * Default: http://127.0.0.1:3032
 *
 * Env vars:
 *   ANTY_DATA_DIR   — path to profile data / DB  (default: ~/.anty)
 *   ANTY_API_PORT   — port to listen on           (default: 3032)
 *   ANTY_API_HOST   — host to bind to             (default: 127.0.0.1)
 */

const http = require('http');
const { URL } = require('url');

// Force server mode before requiring modules that may try to load electron
process.env.ANTY_SERVER_MODE = '1';

const {
  initDatabase,
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile: dbDeleteProfile,
  listFolders,
  listGroups,
  listProxies,
  createProxy,
} = require('../main/database');

const launcher = require('../main/launcher');
const { generateFingerprint } = require('../main/fingerprint');
const profileSync = require('../main/profile-sync');

const PORT = Number(process.env.ANTY_API_PORT) || 3032;
const HOST = process.env.ANTY_API_HOST || '127.0.0.1';

// ── Mini router ─────────────────────────────────────────────────────────────

const routes = [];

function route(method, pattern, handler) {
  // Convert "/api/profiles/:id/start" → regex + param names
  const keys = [];
  const src = pattern.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  routes.push({ method, re: new RegExp(`^${src}$`), keys, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { handler: r.handler, params };
  }
  return null;
}

// ── Request helpers ──────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function ok(res, data = {}) { send(res, 200, { ok: true, ...data }); }
function created(res, data) { send(res, 201, { ok: true, ...data }); }
function notFound(res, msg = 'Not found') { send(res, 404, { ok: false, error: msg }); }
function badRequest(res, msg) { send(res, 400, { ok: false, error: msg }); }
function serverError(res, err) { send(res, 500, { ok: false, error: String(err?.message || err) }); }

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/profiles — list all profiles with running status
route('GET', '/api/profiles', async (_req, res, _params) => {
  const profiles = listProfiles();
  const running = new Set(launcher.getRunningProfiles());
  const list = profiles.map((p) => ({
    id: p.id,
    name: p.name,
    status: running.has(p.id) ? 'running' : (p.status || 'ready'),
    proxy: p.proxy_host ? `${p.proxy_type || 'http'}://${p.proxy_host}:${p.proxy_port}` : null,
    start_page: p.start_page,
    warmup_url: p.warmup_url,
    created_at: p.created_at,
    wsEndpoint: running.has(p.id) ? launcher.getWsEndpoint(p.id) : null,
  }));
  ok(res, { profiles: list });
});

// GET /api/profiles/:id — single profile details
route('GET', '/api/profiles/:id', async (_req, res, { id }) => {
  const profile = getProfile(Number(id));
  if (!profile) return notFound(res, `Profile ${id} not found`);
  const wsEndpoint = launcher.getWsEndpoint(Number(id));
  ok(res, { profile: { ...profile, wsEndpoint } });
});

// Platform → start_page mapping
const PLATFORM_URLS = {
  facebook:  'https://www.facebook.com',
  instagram: 'https://www.instagram.com',
  linkedin:  'https://www.linkedin.com',
};

// POST /api/profiles — create profile
// Body: { name, platform, proxy, start_page, warmup_url, userAgent, cookies, created_by }
//   platform: "facebook" | "instagram" | "linkedin"  (sets start_page automatically)
//   proxy: "http://host:port:user:pass" or { type, host, port, username, password }
route('POST', '/api/profiles', async (req, res, _params) => {
  let body;
  try { body = await readBody(req); }
  catch { return badRequest(res, 'Invalid JSON body'); }

  const name = (body.name || '').trim() || `Profile ${Date.now()}`;

  // Resolve start_page: platform shorthand takes priority, then explicit start_page
  const platformKey = String(body.platform || '').toLowerCase();
  const startPage = PLATFORM_URLS[platformKey] || body.start_page || 'https://whoer.net';

  // Parse proxy → create a proxy record → get proxy_id
  let proxyFields = {};
  if (body.proxy) {
    const p = typeof body.proxy === 'string' ? parseProxyString(body.proxy) : body.proxy;
    if (p && p.host) {
      const proxy = createProxy({
        type: p.type || 'http',
        host: p.host,
        port: Number(p.port) || 0,
        username: p.username || '',
        password: p.password || '',
        name: p.name || p.host,
        ip_change_link: '',
      });
      proxyFields = { proxy_id: proxy.id };
    }
  }

  const { generateFingerprintFromUA } = require('../main/fingerprint');
  const fingerprint = body.userAgent
    ? generateFingerprintFromUA(body.userAgent)
    : generateFingerprint();

  const profile = createProfile({
    name,
    fingerprint,
    start_page: startPage,
    warmup_url: body.warmup_url || '',
    cookies: body.cookies ? JSON.stringify(body.cookies) : '[]',
    created_by: body.created_by || '',
    ...proxyFields,
  });

  profileSync.onLocalProfileUpsert(profile);
  profileSync.scheduleSync();
  created(res, { profile });
});

// PATCH /api/profiles/:id — update profile fields
// Supports: name, notes, start_page, warmup_url, created_by,
//           proxy: "http://user:pass@host:port" | "host:port:user:pass" | { type,host,port,username,password }
route('PATCH', '/api/profiles/:id', async (req, res, { id }) => {
  const profile = getProfile(Number(id));
  if (!profile) return notFound(res, `Profile ${id} not found`);

  let body;
  try { body = await readBody(req); }
  catch { return badRequest(res, 'Invalid JSON body'); }

  // Handle proxy: resolve string / object → create proxy record → set proxy_id
  if (body.proxy !== undefined) {
    const p = typeof body.proxy === 'string' ? parseProxyString(body.proxy) : body.proxy;
    if (p && p.host) {
      const proxy = createProxy({
        type: p.type || 'http',
        host: p.host,
        port: Number(p.port) || 0,
        username: p.username || '',
        password: p.password || '',
        name: p.name || p.host,
        ip_change_link: '',
      });
      body = { ...body, proxy_id: proxy.id };
    }
    delete body.proxy;
  }

  const updated = updateProfile(Number(id), body);
  profileSync.onLocalProfileUpsert(updated);
  profileSync.scheduleSync();
  ok(res, { profile: updated });
});

// PUT /api/profiles/:id/notes — set profile notes (shorthand)
// Body: { notes: "..." }  or plain text body
route('PUT', '/api/profiles/:id/notes', async (req, res, { id }) => {
  const profile = getProfile(Number(id));
  if (!profile) return notFound(res, `Profile ${id} not found`);

  let notes = '';
  try {
    const body = await readBody(req);
    notes = typeof body === 'string' ? body : (body.notes ?? '');
  } catch {
    return badRequest(res, 'Invalid body');
  }

  const updated = updateProfile(Number(id), { notes });
  profileSync.onLocalProfileUpsert(updated);
  profileSync.scheduleSync();
  ok(res, { id: Number(id), notes: updated.notes });
});

// PATCH /api/profiles/:id/proxy — set or remove proxy on a profile
// Body: { proxy: "http://user:pass@host:port" | "host:port:user:pass" | null }
route('PATCH', '/api/profiles/:id/proxy', async (req, res, { id }) => {
  const profile = getProfile(Number(id));
  if (!profile) return notFound(res, `Profile ${id} not found`);

  let body;
  try { body = await readBody(req); }
  catch { return badRequest(res, 'Invalid JSON body'); }

  // null / empty string → remove proxy
  if (!body.proxy) {
    const updated = updateProfile(Number(id), { proxy_id: null });
    profileSync.onLocalProfileUpsert(updated);
    profileSync.scheduleSync();
    return ok(res, { profile: updated });
  }

  const p = typeof body.proxy === 'string' ? parseProxyString(body.proxy) : body.proxy;
  if (!p || !p.host) return badRequest(res, 'Invalid proxy format. Use "http://user:pass@host:port" or "host:port:user:pass"');

  const proxy = createProxy({
    type: p.type || 'http',
    host: p.host,
    port: Number(p.port) || 0,
    username: p.username || '',
    password: p.password || '',
    name: p.name || p.host,
    ip_change_link: '',
  });

  const updated = updateProfile(Number(id), { proxy_id: proxy.id });
  profileSync.onLocalProfileUpsert(updated);
  profileSync.scheduleSync();
  ok(res, { profile: updated, proxy });
});

// DELETE /api/profiles/:id — delete profile and its browser data
route('DELETE', '/api/profiles/:id', async (_req, res, { id }) => {
  const result = await launcher.deleteProfile(Number(id), { enqueueCloudDelete: true });
  if (!result.success) return notFound(res, result.error);
  profileSync.scheduleSync();
  ok(res, { deleted: Number(id) });
});

// POST /api/profiles/:id/start — launch headless browser
// Returns wsEndpoint that any Playwright/CDP client can connect to
route('POST', '/api/profiles/:id/start', async (_req, res, { id }) => {
  const profileId = Number(id);
  const profile = getProfile(profileId);
  if (!profile) return notFound(res, `Profile ${id} not found`);

  // Pass sentinel so launcher knows it's headless/server mode
  const result = await launcher.launchProfile(profileId, { __serverMode: true });
  if (!result.success) return serverError(res, result.error);

  ok(res, {
    profileId,
    wsEndpoint: result.wsEndpoint,
    message: 'Browser started. Connect via Playwright: chromium.connect(wsEndpoint)',
  });
});

// POST /api/profiles/:id/stop — stop running browser
route('POST', '/api/profiles/:id/stop', async (_req, res, { id }) => {
  const result = await launcher.stopProfile(Number(id));
  if (!result.success) return badRequest(res, result.error);
  // Push updated cookies to cloud after session ends
  const saved = getProfile(Number(id));
  if (saved) { profileSync.onLocalProfileUpsert(saved); profileSync.scheduleSync(); }
  ok(res, { stopped: Number(id) });
});

// GET /api/profiles/:id/ws — get wsEndpoint for already running profile
route('GET', '/api/profiles/:id/ws', async (_req, res, { id }) => {
  const wsEndpoint = launcher.getWsEndpoint(Number(id));
  if (!wsEndpoint) return notFound(res, `Profile ${id} is not running`);
  ok(res, { wsEndpoint });
});

// POST /api/proxy/check — check proxy connectivity and get geo info
// Body: { proxy: "http://host:port:user:pass" } or { type, host, port, username, password }
route('POST', '/api/proxy/check', async (req, res, _params) => {
  let body;
  try { body = await readBody(req); }
  catch { return badRequest(res, 'Invalid JSON body'); }

  const raw = body.proxy || body;
  const p = typeof raw === 'string' ? parseProxyString(raw) : raw;
  if (!p || !p.host || !p.port) {
    return badRequest(res, 'Proxy required: "proxy": "http://host:port:user:pass"');
  }

  const proxyData = {
    type:     p.type     || p.proxy_type     || 'http',
    host:     p.host     || p.proxy_host     || '',
    port:     p.port     || p.proxy_port     || 0,
    username: p.username || p.proxy_username || '',
    password: p.password || p.proxy_password || '',
  };

  try {
    const result = await launcher.checkProxy(proxyData);
    ok(res, result);
  } catch (err) {
    serverError(res, err);
  }
});

// GET /api/running — list all running profile IDs + their wsEndpoints
route('GET', '/api/running', async (_req, res, _params) => {
  const ids = launcher.getRunningProfiles();
  const running = ids.map((id) => ({ id, wsEndpoint: launcher.getWsEndpoint(id) }));
  ok(res, { running });
});

// ── Proxy string parser ───────────────────────────────────────────────────────
// Accepts:
//   "host:port:user:pass"                       (legacy)
//   "type://host:port:user:pass"                (legacy with proto)
//   "http://user:pass@host:port"                (standard URL format)
//   "socks5://user:pass@host:port"

function parseProxyString(str) {
  if (!str) return null;
  let type = 'http';
  let rest = str.trim();

  // Extract protocol prefix
  const protoMatch = rest.match(/^(https?|socks[45]?):\/\/(.+)/i);
  if (protoMatch) {
    type = protoMatch[1].toLowerCase();
    rest = protoMatch[2];
  }

  // Standard URL format: user:pass@host:port
  const atIdx = rest.indexOf('@');
  if (atIdx !== -1) {
    const credentials = rest.slice(0, atIdx);
    const hostPort = rest.slice(atIdx + 1);
    const credParts = credentials.split(':');
    const hostParts = hostPort.split(':');
    return {
      type,
      host: hostParts[0] || '',
      port: hostParts[1] || '',
      username: credParts[0] || '',
      password: credParts[1] || '',
    };
  }

  // Legacy format: host:port:user:pass
  const parts = rest.split(':');
  if (parts.length < 2) return null;
  return {
    type,
    host: parts[0],
    port: parts[1],
    username: parts[2] || '',
    password: parts[3] || '',
  };
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  const { pathname } = new URL(req.url, `http://${HOST}`);
  const match = matchRoute(req.method, pathname);

  if (!match) return notFound(res, `No route: ${req.method} ${pathname}`);

  try {
    await match.handler(req, res, match.params);
  } catch (err) {
    console.error('[API] Unhandled error:', err);
    serverError(res, err);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

initDatabase();
console.log('[API] Database initialized');

server.listen(PORT, HOST, () => {
  console.log(`[API] Anty REST API listening on http://${HOST}:${PORT}`);
  console.log('[API] Endpoints:');
  console.log('  GET    /api/profiles');
  console.log('  POST   /api/profiles');
  console.log('  GET    /api/profiles/:id');
  console.log('  PATCH  /api/profiles/:id          (name, notes, start_page, proxy, …)');
  console.log('  DELETE /api/profiles/:id');
  console.log('  PUT    /api/profiles/:id/notes     { notes: "…" }');
  console.log('  PATCH  /api/profiles/:id/proxy     { proxy: "http://user:pass@host:port" | null }');
  console.log('  POST   /api/profiles/:id/start   → { wsEndpoint }');
  console.log('  POST   /api/profiles/:id/stop');
  console.log('  GET    /api/profiles/:id/ws');
  console.log('  POST   /api/proxy/check');
  console.log('  GET    /api/running');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[API] Shutting down — stopping all browsers...');
  await launcher.stopAllProfiles().catch(() => {});
  server.close(() => process.exit(0));
});

process.on('SIGTERM', async () => {
  await launcher.stopAllProfiles().catch(() => {});
  server.close(() => process.exit(0));
});
