/**
 * Read-side manager for the shared extension store.
 *
 * Extensions land in <userData>/shared_extensions/Extensions/<id>/<version>/ when a
 * profile that had them installed is closed (see launcher.js), and are copied back
 * into every profile on launch. Nothing here installs an extension: the store also
 * carries Chrome's own `settings` plus their MAC signatures, which cannot be forged,
 * so a hand-placed folder would be rejected by Chrome as corrupted. Installing stays
 * a Chrome Web Store action inside a launched profile.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function getDataDir() {
  if (process.env.ANTY_DATA_DIR) return process.env.ANTY_DATA_DIR;
  try {
    return require('electron').app.getPath('userData');
  } catch (_) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'anty-browser');
  }
}

function getExtensionsRoot() {
  return path.join(getDataDir(), 'shared_extensions', 'Extensions');
}

function getStatePath() {
  return path.join(getDataDir(), 'shared_extensions', 'extensions_state.json');
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/** Newest version directory holding a manifest, or null when the entry is unusable. */
function latestVersionDir(extensionDir) {
  try {
    const versions = fs.readdirSync(extensionDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(extensionDir, e.name, 'manifest.json')))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return versions.length ? path.join(extensionDir, versions[versions.length - 1]) : null;
  } catch (_) {
    return null;
  }
}

/** manifest name/description may be "__MSG_key__", which lives in _locales. */
function resolveI18n(value, versionDir, defaultLocale) {
  const match = /^__MSG_(.+)__$/.exec(String(value || ''));
  if (!match) return String(value || '');
  const locales = [defaultLocale, 'en', 'en_US'].filter(Boolean);
  for (const locale of locales) {
    const messages = readJsonSafe(path.join(versionDir, '_locales', locale, 'messages.json'));
    const entry = messages?.[match[1]] ?? messages?.[match[1].toLowerCase()];
    if (entry?.message) return String(entry.message);
  }
  return '';
}

function pickIcon(manifest, versionDir) {
  const icons = manifest.icons || manifest.browser_action?.default_icon || manifest.action?.default_icon;
  if (!icons) return null;
  const bySize = typeof icons === 'string'
    ? [icons]
    : Object.keys(icons).sort((a, b) => Number(b) - Number(a)).map((k) => icons[k]);
  for (const rel of bySize) {
    const iconPath = path.join(versionDir, String(rel).replace(/^\/+/, ''));
    try {
      if (!fs.existsSync(iconPath)) continue;
      const ext = path.extname(iconPath).toLowerCase();
      const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      const data = fs.readFileSync(iconPath);
      if (data.length > 512 * 1024) continue;
      return `data:${mime};base64,${data.toString('base64')}`;
    } catch (_) { /* try the next size */ }
  }
  return null;
}

function directorySize(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try { total += fs.statSync(full).size; } catch (_) { /* vanished mid-walk */ }
      }
    }
  };
  walk(dir);
  return total;
}

function listSharedExtensions() {
  const root = getExtensionsRoot();
  if (!fs.existsSync(root)) return [];
  const state = readJsonSafe(getStatePath());

  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'Temp') continue;
    const extensionDir = path.join(root, entry.name);
    const versionDir = latestVersionDir(extensionDir);
    if (!versionDir) continue;

    const manifest = readJsonSafe(path.join(versionDir, 'manifest.json')) || {};
    const defaultLocale = manifest.default_locale;
    const name = resolveI18n(manifest.name, versionDir, defaultLocale) || entry.name;

    // Chrome stores 1 = enabled, 0 = disabled. Absent means it was never captured.
    const setting = state?.settings?.[entry.name];
    const stateValue = setting && typeof setting.state === 'number' ? setting.state : null;

    let addedAt = '';
    try { addedAt = fs.statSync(extensionDir).mtime.toISOString(); } catch (_) { /* keep blank */ }

    out.push({
      id: entry.name,
      name,
      version: String(manifest.version || ''),
      description: resolveI18n(manifest.description, versionDir, defaultLocale),
      manifestVersion: Number(manifest.manifest_version) || null,
      permissions: Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [],
      icon: pickIcon(manifest, versionDir),
      sizeBytes: directorySize(extensionDir),
      enabled: stateValue === null ? null : stateValue === 1,
      hasSettings: Boolean(setting),
      path: versionDir,
      addedAt,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Drops the files and the captured Chrome settings, so it stops being pushed out. */
function removeSharedExtension(id) {
  const safeId = String(id || '');
  if (!/^[a-z0-9._-]+$/i.test(safeId)) return { success: false, error: 'Invalid extension id' };

  const extensionDir = path.join(getExtensionsRoot(), safeId);
  if (!fs.existsSync(extensionDir)) return { success: false, error: 'Extension not found' };
  try {
    fs.rmSync(extensionDir, { recursive: true, force: true });
  } catch (err) {
    return { success: false, error: err.message || 'Could not delete extension files' };
  }

  const statePath = getStatePath();
  const state = readJsonSafe(statePath);
  if (state?.settings?.[safeId] || state?.macs?.[safeId]) {
    delete state.settings?.[safeId];
    delete state.macs?.[safeId];
    try {
      const tmp = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, statePath);
    } catch (_) {
      // Files are already gone, so the entry is inert even if the state keeps a stale key.
    }
  }
  return { success: true };
}

function getSharedExtensionPath(id) {
  const safeId = String(id || '');
  if (!/^[a-z0-9._-]+$/i.test(safeId)) return null;
  const dir = path.join(getExtensionsRoot(), safeId);
  return fs.existsSync(dir) ? dir : null;
}

module.exports = {
  listSharedExtensions,
  removeSharedExtension,
  getSharedExtensionPath,
  getExtensionsRoot,
};
