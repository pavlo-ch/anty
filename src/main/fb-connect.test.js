// node --test src/main/fb-connect.test.js
const test = require('node:test');
const assert = require('node:assert');
const { connect, getStatus, toState } = require('./fb-connect');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-28T12:00:00Z');
const ok = (body) => ({ ok: true, status: 200, body });

test('status: connected, expiring, expired, none', () => {
  const far = new Date(now + 30 * DAY).toISOString();
  const soon = new Date(now + 2 * DAY).toISOString();
  assert.equal(toState(ok({ connected: true, adAccounts: 3, expiresAt: far }), now).kind, 'connected');
  assert.equal(toState(ok({ connected: true, adAccounts: 3, expiresAt: soon }), now).kind, 'expiring');
  assert.equal(toState(ok({ connected: false, status: 'revoked' }), now).kind, 'expired');
  assert.equal(toState(ok({ connected: false, status: 'none' }), now).kind, 'none');
});

test('status: errors are explained, not thrown', () => {
  assert.match(toState({ ok: false, status: 401 }).text, /Sign in/);
  assert.match(toState({ ok: false, status: 503, body: { error: 'fb_not_configured' } }).text, /not set up/);
  assert.equal(toState({ ok: false, status: 404 }).kind, 'unsynced');
  assert.match(toState({ ok: false, status: 403 }).text, /team/);
});

const deps = (over = {}) => ({
  remoteId: () => 'remote-1',
  ticketUrl: () => 'https://p/ticket',
  statusUrl: () => 'https://p/status',
  post: async () => ok({ url: 'https://p/api/fb/connect?ticket=abc' }),
  ...over,
});

test('connect: opens the platform link in the profile', async () => {
  const opened = [];
  const res = await connect(7, async (id, url) => { opened.push([id, url]); return { success: true }; }, deps());
  assert.equal(res.success, true);
  assert.deepEqual(opened, [[7, 'https://p/api/fb/connect?ticket=abc']]);
});

test('connect: unsynced profile never asks the platform', async () => {
  let asked = false;
  const res = await connect(7, async () => ({ success: true }), deps({ remoteId: () => '', post: async () => { asked = true; } }));
  assert.equal(res.state.kind, 'unsynced');
  assert.equal(asked, false);
});

test('connect: refuses a non-https link', async () => {
  const res = await connect(7, async () => ({ success: true }), deps({ post: async () => ok({ url: 'javascript:alert(1)' }) }));
  assert.equal(res.success, false);
});

test('getStatus: sends remote id', async () => {
  let payload = null;
  await getStatus(7, deps({ post: async (_u, p) => { payload = p; return ok({ connected: false }); } }));
  assert.deepEqual(payload, { profileId: 'remote-1' });
});
