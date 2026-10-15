const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const { randomUUID } = require('node:crypto');
async function main() {
  await require('./linux-test-ready.cjs').waitForRuntime();
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.ANTY_DATA_DIR, 'fixture-result.json')));
  const proxy = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Restart fixture</title>'); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  async function api(route, body, method = 'POST') {
    const r = await fetch('http://127.0.0.1:3032' + route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json(); assert.equal(r.ok, true, JSON.stringify(data)); return data;
  }
  let browser;
  const ownerToken = randomUUID();
  try {
    await api(`/api/profiles/${saved.id}/proxy`, { proxy: { type: 'http', host: '127.0.0.1', port: proxy.address().port } }, 'PATCH');
    const result = await api(`/api/profiles/${saved.id}/start`, { requireProxy: true, ownerToken });
    browser = await chromium.connectOverCDP(result.wsEndpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://session.fixture.invalid');
    assert.equal((await context.cookies()).find(c => c.name === 'persistent')?.value, 'fixture-cookie');
    assert.equal(await page.evaluate(() => localStorage.getItem('session')), 'updated-fixture');
    assert.equal(await page.evaluate(async () => {
      const db = await new Promise(resolve => { const req = indexedDB.open('fixture'); req.onsuccess = () => resolve(req.result); });
      return new Promise(resolve => { const req = db.transaction('state').objectStore('state').get('key'); req.onsuccess = () => { db.close(); resolve(req.result); }; });
    }), 'indexed-session');
    await api(`/api/profiles/${saved.id}/stop`, { ownerToken });
    // Repeated cleanup after a disconnected client is safe.
    await api(`/api/profiles/${saved.id}/stop`, { ownerToken });
    console.log('PASS container restart: same cookie, localStorage and IndexedDB; idempotent cleanup');
  } finally {
    await browser?.close().catch(() => {});
    await new Promise(resolve => proxy.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
