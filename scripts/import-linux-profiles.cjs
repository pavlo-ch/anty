// Offline, additive import. Stop the runtime before running this script.
// Input: { teamId, profiles: [{ remoteId, name, fingerprint, cookies,
// storageState, proxy: {type,host,port,username,password}, runningOn, status }] }
// Read from a mode-0600 file or stdin; never put sessions in git or command args.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/main/database');

async function main() {
  process.umask(0o077);
  if (!process.env.ANTY_DATA_DIR) throw new Error('Set ANTY_DATA_DIR to a dedicated server store');
  const input = JSON.parse(fs.readFileSync(process.argv[2] || 0, 'utf8'));
  const profiles = input.profiles;
  if (!input.teamId || !Array.isArray(profiles) || profiles.length === 0) throw new Error('A teamId and selected profiles are required');
  const ids = new Set();
  for (const p of profiles) {
    if (!p.remoteId || ids.has(p.remoteId)) throw new Error('Missing or duplicate cloud profile id');
    if (p.teamId && p.teamId !== input.teamId) throw new Error('Profiles from different teams cannot share a server store');
    if (p.status === 'running' || p.runningOn) throw new Error('Close the source profile before importing it');
    if (!p.proxy?.host || !Number.isInteger(p.proxy.port) || p.proxy.port <= 0 || p.proxy.port > 65535) throw new Error('Every imported profile must have its own valid proxy');
    if (!Array.isArray(p.cookies) || !p.fingerprint || typeof p.fingerprint !== 'object' || Array.isArray(p.fingerprint)) throw new Error('Profile cookies and fingerprint must be present');
    ids.add(p.remoteId);
  }
  fs.mkdirSync(process.env.ANTY_DATA_DIR, { recursive: true, mode: 0o700 });
  db.initDatabase();
  const sql = db.getDb();
  const rows = sql.prepare('SELECT DISTINCT owner_scope FROM profiles').all();
  const expectedScope = `team:${input.teamId}`;
  if (rows.some(row => row.owner_scope !== expectedScope)) throw new Error('Existing store belongs to another scope; use a new volume');
  const currentTeam = sql.prepare('SELECT team_id FROM account_state WHERE id=1').get()?.team_id;
  if (currentTeam && currentTeam !== input.teamId) throw new Error('Existing account belongs to another team');
  await sql.backup(path.join(process.env.ANTY_DATA_DIR, `anty_browser.db.bak-${Date.now()}`));
  const result = sql.transaction(() => {
    sql.prepare('UPDATE account_state SET team_id=? WHERE id=1').run(input.teamId);
    let imported = 0, skipped = 0;
    for (const p of profiles) {
      if (db.getProfileByRemoteId(p.remoteId)) { skipped += 1; continue; }
      const proxy = db.findOrCreateProxy(p.proxy);
      const created = db.createProfile({ name: p.name, fingerprint: p.fingerprint,
        user_agent: p.fingerprint.userAgent || p.userAgent || '', proxy_id: proxy.id,
        cookies: p.cookies, storage_state: p.storageState || {},
        start_page: p.startPage || 'about:blank', notes: p.notes || '' });
      db.updateProfile(created.id, { remote_id: p.remoteId, team_id: input.teamId });
      imported += 1;
    }
    return { imported, skipped };
  })();
  console.log(JSON.stringify(result));
  sql.close();
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
