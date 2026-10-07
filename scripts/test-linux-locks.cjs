const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
test('Docker recovery preserves data and refuses an active profile or non-dedicated store', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anty-lock-test-'));
  const dir = path.join(root, 'profiles', 'profile_1');
  fs.mkdirSync(dir, { recursive: true });
  const dataFile = path.join(dir, 'Cookies');
  fs.writeFileSync(dataFile, 'keep profile data');
  const lock = path.join(dir, 'SingletonLock');
  function run(dedicated = 'true') {
    return spawnSync(process.execPath, [path.join(__dirname, 'unlock-linux-profiles.cjs')], {
      encoding: 'utf8', env: { ...process.env, ANTY_DATA_DIR: root, ANTY_DEDICATED_STORE: dedicated },
    });
  }
  let child;
  try {
    fs.symlinkSync('old-container-99999999', lock);
    fs.symlinkSync('/tmp/old-chrome/socket', path.join(dir, 'SingletonSocket'));
    assert.notEqual(run('false').status, 0);
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true);
    assert.equal(run().status, 0);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.readFileSync(dataFile, 'utf8'), 'keep profile data');
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', `--user-data-dir=${dir}`]);
    await new Promise(resolve => child.once('spawn', resolve));
    fs.symlinkSync(`current-container-${child.pid}`, lock);
    const active = run();
    assert.notEqual(active.status, 0);
    assert.match(active.stderr, /still open/);
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true);
  } finally {
    if (child) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
