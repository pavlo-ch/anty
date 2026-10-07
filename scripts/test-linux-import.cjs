const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('offline import is additive, private and refuses another tenant or running profiles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anty-import-test-'));
  const profile = { remoteId: 'test-cloud-id', name: 'original', fingerprint: {}, cookies: [],
    proxy: { host: '127.0.0.1', port: 8080 }, status: 'ready' };
  function run(input) {
    return spawnSync(process.execPath, [path.join(__dirname, 'import-linux-profiles.cjs')], {
      input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ANTY_DATA_DIR: dir },
    });
  }
  try {
    const first = run({ teamId: 'fixture-team', profiles: [profile] });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /"imported":1,"skipped":0/);
    const repeated = run({ teamId: 'fixture-team', profiles: [{ ...profile, name: 'overwrite attempt' }] });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /"imported":0,"skipped":1/);
    assert.notEqual(run({ teamId: 'different-team', profiles: [profile] }).status, 0);
    assert.notEqual(run({ teamId: 'fixture-team', profiles: [{ ...profile, runningOn: 'another-device' }] }).status, 0);
    assert.notEqual(run({ teamId: 'fixture-team', profiles: [profile, profile] }).status, 0);
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dir, 'anty_browser.db'), { readonly: true });
    assert.deepEqual(db.prepare('SELECT name,owner_scope FROM profiles').all(), [{ name: 'original', owner_scope: 'team:fixture-team' }]);
    db.close();
    for (const file of fs.readdirSync(dir).filter(name => name.includes('.bak-'))) {
      assert.equal(fs.statSync(path.join(dir, file)).mode & 0o077, 0);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
