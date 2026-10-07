// Run INSIDE an isolated Linux test container with its own empty ANTY_DATA_DIR.
// No LinkedIn URLs, credentials or production portal are used here.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');

async function main() {
  await require('./linux-test-ready.cjs').waitForRuntime();
  const base = 'http://127.0.0.1:3032';
  async function api(route, body, expected = 200) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : route.includes('/start') || route.includes('/stop') || route === '/api/profiles' ? 'POST' : 'PATCH',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  let hits = 0;
  const proxy = http.createServer((req, res) => {
    if (req.url.startsWith('http://session.fixture.invalid')) hits += 1;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Linux persistence fixture</title><h1>Fixture</h1>');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const agentRoot = process.env.ANTY_TEST_AGENT_ROOT;
  const chromium = (agentRoot ? createRequire(path.join(agentRoot, 'package.json')) : require)('playwright-core').chromium;
  let attached;
  let id;
  const ownerToken = randomUUID();
  try {
    const profile = (await api('/api/profiles', {
      name: 'Linux isolated persistence fixture', start_page: 'about:blank',
      proxy: { host: '127.0.0.1', port: proxy.address().port, type: 'http' },
    }, 201)).profile;
    id = profile.id;
    const remoteId = 'fixture-' + randomUUID();
    await api(`/api/profiles/${id}`, {
      remote_id: remoteId,
      storage_state: { cookies: [], origins: [{ origin: 'http://session.fixture.invalid', localStorage: [
        { name: 'session', value: 'imported-fixture' },
        { name: 'logout-key', value: 'must-not-return' },
      ] }] },
    });
    const found = (await api(`/api/profiles/by-remote/${remoteId}`)).profile;
    assert.equal(found.id, id);
    assert.equal(found.hasProxy, true);
    const noProxy = (await api('/api/profiles', { name: 'Unproxied fixture', start_page: 'about:blank' }, 201)).profile;
    await api(`/api/profiles/${noProxy.id}/start`, { requireProxy: true }, 400);
    const start = api(`/api/profiles/${id}/start`, { requireProxy: true, ownerToken });
    // Concurrent launch must lose, even while Chrome is still starting.
    await new Promise(resolve => setTimeout(resolve, 20));
    await api(`/api/profiles/${id}/start`, { requireProxy: true, ownerToken: randomUUID() }, 409);
    const first = await start;
    assert.equal(first.protocol, 'cdp');
    attached = await chromium.connectOverCDP(first.wsEndpoint);
    const context = attached.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://session.fixture.invalid');
    assert.equal(await page.evaluate(() => localStorage.getItem('session')), 'imported-fixture');
    await context.addCookies([{ name: 'persistent', value: 'fixture-cookie', domain: 'session.fixture.invalid', path: '/', expires: Date.now() / 1000 + 3600 }]);
    await page.evaluate(async () => {
      localStorage.setItem('session', 'updated-fixture');
      localStorage.removeItem('logout-key');
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('fixture', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('state');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite');
        tx.objectStore('state').put('indexed-session', 'key');
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await page.reload();
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('session'), localStorage.getItem('logout-key')]), ['updated-fixture', null], 'First-session reload replayed the cloud snapshot');
    const newTab = await context.newPage();
    await newTab.goto('http://session.fixture.invalid');
    assert.deepEqual(await newTab.evaluate(() => [localStorage.getItem('session'), localStorage.getItem('logout-key')]), ['updated-fixture', null], 'New tab replayed the cloud snapshot');
    await newTab.close();
    await api(`/api/profiles/${id}/stop`, { ownerToken: randomUUID() }, 409);
    await api(`/api/profiles/${id}/stop`, { ownerToken });
    await attached.close(); attached = null;
    // DB state intentionally differs: the persisted Chrome directory must win.
    await api(`/api/profiles/${id}`, { storage_state: { cookies: [], origins: [{ origin: 'http://session.fixture.invalid', localStorage: [{ name: 'session', value: 'stale-cloud' }] }] } });
    const secondOwner = randomUUID();
    let second;
    if (agentRoot) {
      const { AntyApi } = await import(path.join(agentRoot, 'lib/anty-api.mjs'));
      second = await new AntyApi(base).open(remoteId, chromium);
    } else {
      const result = await api(`/api/profiles/${id}/start`, { requireProxy: true, ownerToken: secondOwner });
      attached = await chromium.connectOverCDP(result.wsEndpoint);
      second = { context: attached.contexts()[0], close: () => api(`/api/profiles/${id}/stop`, { ownerToken: secondOwner }) };
    }
    const page2 = second.context.pages()[0] || await second.context.newPage();
    await page2.goto('http://session.fixture.invalid');
    assert.equal((await second.context.cookies()).find(c => c.name === 'persistent')?.value, 'fixture-cookie');
    assert.equal(await page2.evaluate(() => localStorage.getItem('session')), 'updated-fixture');
    assert.equal(await page2.evaluate(() => localStorage.getItem('logout-key')), null);
    assert.equal(await page2.evaluate(async () => {
      const db = await new Promise(resolve => { const req = indexedDB.open('fixture'); req.onsuccess = () => resolve(req.result); });
      const value = await new Promise(resolve => { const req = db.transaction('state').objectStore('state').get('key'); req.onsuccess = () => resolve(req.result); });
      db.close(); return value;
    }), 'indexed-session');
    await second.close();
    assert.ok(hits >= 2, 'Browser traffic bypassed its configured proxy');
    const stored = (await api(`/api/profiles/${id}`)).profile;
    assert.equal(stored.status, 'ready');
    assert.equal((await api('/api/running')).running.length, 0);
    fs.writeFileSync(path.join(process.env.ANTY_DATA_DIR, 'fixture-result.json'), JSON.stringify({ id, remoteId, proxyHits: hits, cookie: true, localStorage: true, firstImport: true, firstSessionReload: true, newTab: true, deletedKey: true, indexedDB: true, agentAdapter: Boolean(agentRoot) }));
    console.log('PASS Linux persistent profile: cookie, localStorage, IndexedDB, proxy, launch ownership' + (agentRoot ? ', Outbound CDP adapter' : ''));
  } finally {
    await attached?.close().catch(() => {});
    await new Promise(resolve => proxy.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
