// Docker boot only, AFTER acquiring the exclusive store flock. Never run this
// against a desktop directory or a volume shared with another browser system.
const fs = require('node:fs');
const path = require('node:path');
if (process.env.ANTY_DEDICATED_STORE !== 'true') throw new Error('Linux runtime needs a dedicated profile store');
const root = path.join(process.env.ANTY_DATA_DIR, 'profiles');
if (fs.existsSync(root)) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^profile_\d+$/.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const lock = path.join(dir, 'SingletonLock');
    try {
      const pid = fs.readlinkSync(lock).match(/-(\d+)$/)?.[1];
      if (pid) {
        let args = [];
        try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch (_) {}
        if (args.includes(`--user-data-dir=${dir}`)) throw new Error(`Profile ${entry.name} is still open`);
      }
    } catch (error) {
      if (!['ENOENT', 'EINVAL'].includes(error.code)) throw error;
    }
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const file = path.join(dir, name);
      try { if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
