// Разове вирівнювання серверного сховища під режим ANTY_CLOUD_SOURCE=1.
// Зупиніть runtime перед запуском. Спершу бекап БД, потім кожен локальний профіль
// із remote_id бере з хмари відбиток, UA, проксі й сесію, і застаріла черга
// profile_sync_queue очищується (у хмарному режимі вона більше не потрібна).
//
//   ANTY_DATA_DIR=/data ANTY_CLOUD_SOURCE=1 node scripts/cloud-align-server-profiles.cjs --dry-run
//   ANTY_DATA_DIR=/data ANTY_CLOUD_SOURCE=1 node scripts/cloud-align-server-profiles.cjs
const path = require('node:path');

process.env.ANTY_SERVER_MODE = '1';
const db = require('../src/main/database');
const profileSync = require('../src/main/profile-sync');

const summarize = (p) => {
  let fp = {};
  try { fp = JSON.parse(p.fingerprint || '{}'); } catch (_) { fp = {}; }
  const seed = fp.seed || fp.canvasSeed || fp.canvas?.seed || fp.webgl?.renderer || '';
  return {
    proxy: p.proxy_host ? `${p.proxy_host}:${p.proxy_port}` : '',
    ua: String(p.user_agent || '').slice(0, 40),
    fp: String(seed).slice(0, 24),
  };
};

async function main() {
  process.umask(0o077);
  const dryRun = process.argv.includes('--dry-run');
  if (!process.env.ANTY_DATA_DIR) throw new Error('Set ANTY_DATA_DIR to the server store');
  if (!profileSync.CLOUD_SOURCE) throw new Error('Run with ANTY_CLOUD_SOURCE=1');
  db.initDatabase();
  const sql = db.getDb();
  const queued = sql.prepare('SELECT COUNT(*) n FROM profile_sync_queue').get().n;
  const locals = sql.prepare("SELECT id FROM profiles WHERE remote_id IS NOT NULL AND remote_id != ''").all()
    .map((r) => db.getProfile(r.id));

  if (!dryRun) {
    const backup = path.join(process.env.ANTY_DATA_DIR, `anty_browser.db.bak-${Date.now()}`);
    await sql.backup(backup);
    console.log(`backup: ${backup}`);
  }

  const report = [];
  for (const before of locals) {
    const fetched = await profileSync.fetchCloudProfile(before.remote_id);
    if (!fetched.ok) { report.push({ id: before.id, name: before.name, result: fetched.reason }); continue; }
    const cloud = fetched.raw;
    const after = { proxy: cloud.proxy?.host ? `${cloud.proxy.host}:${cloud.proxy.port}` : '', ua: String(cloud.userAgent || '').slice(0, 40) };
    const row = { id: before.id, name: before.name, before: summarize(before), cloud: after };
    if (!dryRun) {
      const adopted = await profileSync.adoptCloudProfile(before.remote_id);
      row.result = adopted.ok ? adopted.action : adopted.reason;
      if (adopted.ok) row.after = summarize(db.getProfile(before.id));
    } else {
      row.result = 'dry-run';
    }
    report.push(row);
  }

  if (!dryRun) {
    sql.prepare('DELETE FROM profile_sync_queue').run();
    sql.exec('VACUUM');
  }
  console.log(JSON.stringify({ dryRun, profiles: report, queueBefore: queued, queueAfter: dryRun ? queued : 0 }, null, 2));
  sql.close();
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
