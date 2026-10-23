// Режим «хмара — джерело правди» (ANTY_CLOUD_SOURCE=1) для серверного runtime.
// База й мережа підмінені: тест не потребує ні SQLite, ні платформи.
//   node --test src/main/cloud-source.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.ANTY_SERVER_MODE = '1';
process.env.ANTY_CLOUD_SOURCE = '1';
process.env.ANTY_PLATFORM_AUTH_URL = 'https://platform.test/api/desktop/anty/login';
process.env.ANTY_PLATFORM_PROFILES_PULL_URL = 'https://platform.test/api/desktop/anty/profiles/pull';
process.env.ANTY_PLATFORM_PROFILES_PUSH_URL = 'https://platform.test/api/desktop/anty/profiles/push';
process.env.ANTY_PLATFORM_DEVICE_TOKEN_URL = 'https://platform.test/api/desktop/anty/auth/device-token';

// ── підмінена база ────────────────────────────────────────────────────────────
const state = { access_token: '', refresh_token: '' };
let profiles = new Map();
let nextId = 1;
let queued = 0;
const fakeDb = {
  getDb: () => ({
    prepare: (sql) => ({
      get: () => (/account_state/.test(sql) ? { ...state } : undefined),
      run: (...args) => {
        if (/UPDATE account_state\s+SET\s+access_token/.test(sql)) {
          state.access_token = args[0];
          state.refresh_token = args[1];
        }
      },
    }),
  }),
  getSetting: (k) => (k === 'anty_device_id' ? 'server-device-1' : ''),
  setSetting: () => {},
  getProfile: (id) => profiles.get(id) || null,
  getProfileByRemoteId: (rid) => [...profiles.values()].find((p) => p.remote_id === rid) || null,
  updateProfile: (id, data) => {
    const p = profiles.get(id);
    const next = { ...p };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      next[k] = v && typeof v === 'object' ? JSON.stringify(v) : v;
    }
    profiles.set(id, next);
    return next;
  },
  createProfile: (data) => {
    const p = { id: nextId++, name: data.name, cookies: '[]', storage_state: '{}', fingerprint: '{}' };
    profiles.set(p.id, p);
    return p;
  },
  deleteProfile: (id) => profiles.delete(id),
  findOrCreateProxy: (px) => ({ id: 77, ...px }),
  enqueueProfileSync: () => { queued += 1; return 1; },
  resolveActiveScope: () => 'team:x',
};
require.cache[require.resolve('./database')] = { id: 'db', filename: 'db', loaded: true, exports: fakeDb };

const sync = require('./profile-sync');

// ── підмінена платформа ──────────────────────────────────────────────────────
function cloudRow(over = {}) {
  return {
    remoteId: 'r-1', teamId: 't-1', workspaceId: 'w-1', name: 'Cloud name', status: 'ready',
    userAgent: 'UA-cloud', fingerprint: { seed: 'cloud' }, cookies: [{ name: 'li_at', value: 'desktop', domain: '.linkedin.com', path: '/' }],
    storageState: {}, lastOpenTabs: [], warmupCompleted: 1, notes: '', startPage: 'https://www.linkedin.com/feed/',
    lastLaunchedAt: '2026-10-20T10:00:00Z', tags: [], proxy: { type: 'http', host: '1.2.3.4', port: 8080, username: 'u', password: 'p' },
    runningOn: '', runningBy: '', deleted: false, updatedAt: '2026-10-20T10:00:00Z', createdBy: { id: 'c', email: 'c@x', name: 'Creator' },
    ...over,
  };
}
let pages = [];
let pushes = [];
let deviceTokenCalls = 0;
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body || '{}');
  const json = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/auth/device-token')) {
    deviceTokenCalls += 1;
    assert.equal(body.device.deviceId, 'server-device-1');
    return json({ access_token: 'acc-1', refresh_token: 'ref-1', expires_at: '2099-01-01T00:00:00Z' });
  }
  assert.equal(init.headers.Authorization, 'Bearer acc-1');
  if (url.endsWith('/profiles/pull')) {
    const idx = body.cursor ? Number(body.cursor) : 0;
    const page = pages[idx] || [];
    return json({ profiles: page, cursor: page.length ? String(idx + 1) : body.cursor });
  }
  if (url.endsWith('/profiles/push')) {
    pushes.push(body);
    return json({ remoteId: body.payload.profile.remoteId, updatedAt: '2026-10-23T12:00:00Z' });
  }
  throw new Error('unexpected url ' + url);
};

test.beforeEach(() => {
  profiles = new Map();
  nextId = 1;
  queued = 0;
  pushes = [];
  pages = [];
});

test('without tokens the server signs in through device-token, no manual login', async () => {
  state.access_token = ''; state.refresh_token = '';
  pages = [[cloudRow()]];
  const r = await sync.adoptCloudProfile('r-1');
  assert.equal(r.ok, true);
  assert.equal(deviceTokenCalls, 1);
  assert.ok(state.access_token, 'tokens are saved for the next call');
});

test('before start the local copy takes fingerprint, UA, proxy and session from the cloud', async () => {
  profiles.set(5, { id: 5, remote_id: 'r-1', name: 'Old', fingerprint: '{"seed":"stale-shared"}', user_agent: 'UA-old', cookies: '[]', storage_state: '{}', proxy_id: 3 });
  nextId = 6;
  // рядок лежить на другій сторінці pull — треба догортати
  pages = [[cloudRow({ remoteId: 'other', name: 'Other' })], [cloudRow()]];
  const r = await sync.adoptCloudProfile('r-1');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'updated');
  const p = profiles.get(5);
  assert.equal(JSON.parse(p.fingerprint).seed, 'cloud');
  assert.equal(p.user_agent, 'UA-cloud');
  assert.equal(p.proxy_id, 77);
  assert.match(p.cookies, /desktop/);
  assert.equal(r.runningElsewhere, false);
});

test('a remote_id the server has never seen becomes a local copy', async () => {
  pages = [[cloudRow({ remoteId: 'r-new', name: 'Fresh' })]];
  const r = await sync.adoptCloudProfile('r-new');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'created');
  assert.equal(r.profile.remote_id, 'r-new');
});

test('a profile open on another machine is reported, and nothing is pushed over it', async () => {
  const recent = new Date(Date.now() - 60_000).toISOString();
  pages = [[cloudRow({ status: 'running', runningOn: 'MacBook-Pavlo', lastLaunchedAt: recent })]];
  const adopted = await sync.adoptCloudProfile('r-1');
  assert.equal(adopted.runningElsewhere, true);
  const pushed = await sync.pushCloudSession({ id: 1, remote_id: 'r-1', cookies: '[]', storage_state: '{}' });
  assert.equal(pushed.ok, false);
  assert.equal(pushed.reason, 'running_elsewhere');
  assert.equal(pushes.length, 0);
});

test('after stop only the session goes back; fingerprint, proxy, name and status stay as in the cloud', async () => {
  pages = [[cloudRow()]];
  const session = { cookies: [{ name: 'li_at', value: 'server-fresh', domain: '.linkedin.com', path: '/' }], origins: [] };
  const r = await sync.pushCloudSession({
    id: 9, remote_id: 'r-1', name: 'Server name', fingerprint: '{"seed":"stale-shared"}', user_agent: 'UA-old',
    cookies: '[]', storage_state: JSON.stringify(session), last_launched_at: '2026-10-23T11:00:00Z', status: 'running',
  });
  assert.equal(r.ok, true);
  assert.equal(pushes.length, 1);
  const sent = pushes[0].payload.profile;
  assert.equal(sent.cookies[0].value, 'server-fresh');
  assert.deepEqual(sent.storageState, session);
  assert.equal(sent.lastLaunchedAt, '2026-10-23T11:00:00Z');
  assert.equal(sent.fingerprint.seed, 'cloud');
  assert.equal(sent.userAgent, 'UA-cloud');
  assert.equal(sent.name, 'Cloud name');
  assert.equal(sent.status, 'ready');
  assert.equal(sent.proxy.host, '1.2.3.4');
  assert.equal(sent.createdByName, 'Creator');
});

test('local edits are never queued and the full sync never runs in this mode', async () => {
  assert.equal(sync.onLocalProfileUpsert({ id: 1, remote_id: 'r-1' }), null);
  assert.equal(sync.onLocalProfileDelete({ id: 1, remote_id: 'r-1' }), null);
  assert.equal(queued, 0);
  const full = await sync.runFullSync();
  assert.equal(full.skipped, true);
  assert.equal(full.reason, 'cloud_source_mode');
});

test('a profile missing from the cloud is reported, not invented', async () => {
  pages = [[cloudRow({ remoteId: 'someone-else' })]];
  const r = await sync.adoptCloudProfile('r-missing');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found_in_cloud');
});
