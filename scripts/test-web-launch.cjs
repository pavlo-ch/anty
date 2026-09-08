const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseLaunchUrl, createWebLaunchController } = require('../src/main/web-launch');
function harness({ loggedIn = true, profile = { id: 4, status: 'ready' }, running = [], stale = false, success = true, syncOk = true } = {}) {
  const events = [];
  const controller = createWebLaunchController({
    auth: { isLoggedIn: () => loggedIn },
    db: { getProfileByRemoteId: () => profile, markProfileLaunched: () => ({ ...profile, last_launched_at: 'now' }) },
    launcher: { getRunningProfiles: () => running, async launchProfile(id, win) { events.push(['launch', id, win]); return { success, error: 'launch failed' }; } },
    profileSync: { async runFullSync() { events.push(['sync']); return { pull: { ok: syncOk } }; },
      onLocalProfileUpsert(row) { events.push(['ack', row.id]); }, scheduleSync() {} },
    isStaleRunningLock: () => stale, getWindow: () => 'hidden-window', showError: message => events.push(['error', message]),
  });
  return { controller, events };
}
test('only profile launch URLs with a safe id are accepted', () => {
  assert.equal(parseLaunchUrl('anty://launch/p-1?background=1'), 'p-1');
  assert.equal(parseLaunchUrl('anty://launch?id=p-2'), 'p-2');
  for (const url of ['https://launch/p1', 'anty://other/p1', 'anty://launch/%2e%2e%2fp1', 'anty://launch/']) assert.equal(parseLaunchUrl(url), null);
});
test('cold-start requests wait for ready, deduplicate and launch without showing UI', async () => {
  const h = harness();
  h.controller.enqueue('anty://launch/p1'); h.controller.enqueue('anty://launch/p1');
  assert.equal(h.events.length, 0); assert.equal(h.controller.hasPending(), true);
  await h.controller.start();
  assert.deepEqual(h.events.map(e => e[0]), ['launch', 'ack']);
  assert.equal(h.events[0][2], 'hidden-window'); assert.equal(h.controller.hasPending(), false);
});
test('already running profiles acknowledge without launching twice', async () => {
  const h = harness({ running: [4] }); h.controller.enqueue('anty://launch/p1'); await h.controller.start();
  assert.deepEqual(h.events.map(e => e[0]), ['ack']);
});
test('login, missing profile, remote lock, sync and launch failures never acknowledge success', async () => {
  for (const options of [{ loggedIn: false }, { profile: null }, { profile: { id: 4, status: 'running' } }, { profile: null, syncOk: false }, { success: false }]) {
    const h = harness(options); h.controller.enqueue('anty://launch/p1'); await h.controller.start();
    assert.equal(h.events.some(e => e[0] === 'error'), true); assert.equal(h.events.some(e => e[0] === 'ack'), false);
  }
});

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
test('Electron cold starts hide manager for Windows argv and macOS open-url; normal start shows it', async () => {
  for (const mode of ['argv', 'mac-url', 'normal']) {
    let resolveReady, pending = false, ready = false;
    const listeners = {}, windows = [], dockEvents = [];
    const app = { requestSingleInstanceLock: () => true, on(name, fn) { listeners[name] = fn; },
      whenReady: () => new Promise(resolve => { resolveReady = resolve; }), isReady: () => ready,
      setAsDefaultProtocolClient() {},
      ...(mode === 'mac-url' ? { dock: { hide() { dockEvents.push('hide'); }, show() { dockEvents.push('show'); }, setIcon() {} } } : {}) };
    class BrowserWindow {
      constructor(options) { this.options = options; this.webContents = { once() {} }; windows.push(this); }
      loadFile() {} isDestroyed() { return false; } isMinimized() { return false; }
      show() { this.shown = true; } focus() {}
    }
    const controller = { hasPending: () => pending, enqueue() { pending = true; }, start() {} };
    const modules = {
      electron: { app, BrowserWindow, ipcMain: { on() {}, removeAllListeners() {} },
        nativeImage: { createFromPath: () => ({ isEmpty: () => false }) }, dialog: {} },
      path, './database': { initDatabase() {} }, './ipc-handlers': { registerIpcHandlers() {} },
      './updater': { registerUpdater() {} }, './launcher': {}, './auth': {}, './profile-sync': {},
      './running-lock': {}, './web-launch': { parseLaunchUrl, createWebLaunchController: () => controller },
    };
    const context = { require: name => { assert.ok(name in modules); return modules[name]; },
      process: { platform: mode === 'mac-url' ? 'darwin' : 'win32', argv: mode === 'argv' ? ['anty', 'anty://launch/p1'] : ['anty'] },
      __dirname: path.resolve(__dirname, '../src/main'), console };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/main/main.js'), 'utf8'), context);
    if (mode === 'mac-url') listeners['open-url']({ preventDefault() {} }, 'anty://launch/p1');
    ready = true; resolveReady(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(windows[0].options.show, mode === 'normal');
    if (mode !== 'normal') {
      if (mode === 'mac-url') pending = false; // launch already drained before activate arrives
      listeners.activate(); assert.equal(windows[0].shown, undefined);
    }
    if (mode === 'mac-url') assert.deepEqual(dockEvents, ['hide']);
  }
});
