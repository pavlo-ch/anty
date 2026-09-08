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

/* ---- Local library: unpacked folders the user adds themselves ----
 * These are not part of the shared store. Chrome refuses hand-placed extensions in a
 * profile because the store's entries are MAC-signed by Chrome, so these are handed to
 * the browser at launch through the CDP Extensions.loadUnpacked command instead. That
 * load does not persist, which is why the launcher repeats it on every start.
 */
function getLibraryDir() {
  return path.join(getDataDir(), 'extensions_library');
}

function slugify(name, fallback) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || fallback;
}

function readManifestAt(dir) {
  const manifest = readJsonSafe(path.join(dir, 'manifest.json'));
  if (!manifest) return null;
  if (!manifest.name || !manifest.version) return null;
  return manifest;
}

function describeLibraryEntry(entryDir, id) {
  const manifest = readManifestAt(entryDir);
  if (!manifest) return null;
  const defaultLocale = manifest.default_locale;
  let addedAt = '';
  try { addedAt = fs.statSync(entryDir).mtime.toISOString(); } catch (_) { /* keep blank */ }
  return {
    id,
    source: 'folder',
    name: resolveI18n(manifest.name, entryDir, defaultLocale) || id,
    version: String(manifest.version || ''),
    description: resolveI18n(manifest.description, entryDir, defaultLocale),
    manifestVersion: Number(manifest.manifest_version) || null,
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [],
    icon: pickIcon(manifest, entryDir),
    sizeBytes: directorySize(entryDir),
    enabled: true,
    hasSettings: true,
    path: entryDir,
    addedAt,
  };
}

function listLibraryExtensions() {
  const root = getLibraryDir();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const described = describeLibraryEntry(path.join(root, entry.name), entry.name);
    if (described) out.push(described);
  }
  return out;
}

/** Absolute paths handed to Extensions.loadUnpacked, newest last. */
function getLibraryLoadPaths() {
  return listLibraryExtensions().map((e) => e.path);
}

function addLibraryExtension(sourceDir) {
  const source = String(sourceDir || '');
  if (!source || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    return { success: false, error: 'Pick a folder, not a file' };
  }
  const manifest = readManifestAt(source);
  if (!manifest) {
    return { success: false, error: 'No usable manifest.json in that folder — pick the unpacked extension folder itself' };
  }

  const root = getLibraryDir();
  fs.mkdirSync(root, { recursive: true });
  const base = slugify(manifest.name, 'extension');
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(root, id))) id = `${base}-${n++}`;

  try {
    fs.cpSync(source, path.join(root, id), { recursive: true });
  } catch (err) {
    return { success: false, error: err.message || 'Could not copy the extension' };
  }
  return { success: true, extension: describeLibraryEntry(path.join(root, id), id) };
}

/* ── Default extensions ─────────────────────────────────────────────────────
 *
 * Extensions every profile should have out of the box, for everyone on the team.
 * They cannot be dropped into the shared store (Chrome would reject an unsigned
 * folder there), so they are installed into the library instead and loaded through
 * the same CDP Extensions.loadUnpacked path as any folder the user adds.
 *
 * Seeded once per machine: the marker records which ids have been offered, so an
 * extension the user deliberately removes stays removed rather than reappearing on
 * the next launch — the same rule the default bookmarks follow.
 */
const DEFAULT_EXTENSIONS = [
  { id: 'lopekoolgoijpmaidblgfgelbkfkgmod', label: 'Fenko Vault — passkey and password manager' },
  { id: 'bhghoamapcdpbohphigoooaddinpkbai', label: 'Authenticator' },
];

// A failed download must not add its timeout to every single launch, so a failed
// sweep backs off for an hour before it is retried.
const DEFAULT_EXTENSION_RETRY_MS = 60 * 60 * 1000;
const DEFAULT_EXTENSION_TIMEOUT_MS = 20000;

function getDefaultExtensionsMarkerPath() {
  return path.join(getLibraryDir(), '.anty_default_extensions');
}

/** Download a URL into a Buffer, following the Web Store's redirect to the CRX. */
function downloadToBuffer(url, timeoutMs, redirectsLeft = 5) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: timeoutMs }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        return resolve(downloadToBuffer(new URL(location, url).href, timeoutMs, redirectsLeft - 1));
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${status}`));
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('download timed out')));
    request.on('error', reject);
  });
}

/** Strip the CRX envelope ("Cr24" + header) to leave the plain ZIP payload. */
function crxToZip(buffer) {
  if (buffer.length < 16 || buffer.readUInt32BE(0) !== 0x43723234) throw new Error('not a CRX file');
  const version = buffer.readUInt32LE(4);
  if (version === 2) {
    const publicKeyLength = buffer.readUInt32LE(8);
    const signatureLength = buffer.readUInt32LE(12);
    return buffer.subarray(16 + publicKeyLength + signatureLength);
  }
  if (version === 3) return buffer.subarray(12 + buffer.readUInt32LE(8));
  throw new Error(`unsupported CRX version ${version}`);
}

/**
 * Extract a ZIP with nothing but zlib — the packaged app ships only its own
 * dependencies, and no archive library is among them.
 *
 * `_metadata` is dropped on the way out: Chrome refuses to load an unpacked
 * extension containing a reserved underscore directory, and the Web Store puts its
 * verified-contents there, so keeping it would make every one of these fail to load.
 */
function unzipBufferTo(zip, destDir) {
  const zlib = require('zlib');
  let end = -1;
  for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 0xffff; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('no end-of-central-directory record');

  const entryCount = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  if (offset === 0xffffffff || entryCount === 0xffff) throw new Error('zip64 archives are not supported');

  let written = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (name === '_metadata' || name.startsWith('_metadata/')) continue;

    // A crafted archive must not be able to write outside the destination.
    const target = path.resolve(destDir, name);
    if (target !== destDir && !target.startsWith(destDir + path.sep)) continue;

    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    const contents = method === 0 ? raw : zlib.inflateRawSync(raw);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    written += 1;
  }
  return written;
}

function buildCrxUrl(id) {
  // getInstalledChromeVersion() answers { full, major } — the update service wants the
  // plain dotted string, and quietly replies 204 for anything it cannot parse.
  let productVersion = '120.0.0.0';
  try {
    const { getInstalledChromeVersion } = require('./chrome-binary');
    const installed = getInstalledChromeVersion();
    if (installed?.full) productVersion = String(installed.full);
  } catch (_) { /* fall back to the pinned version, which the service accepts */ }
  return 'https://clients2.google.com/service/update2/crx'
    + '?response=redirect&acceptformat=crx2,crx3'
    + `&prodversion=${encodeURIComponent(productVersion)}`
    + `&x=${encodeURIComponent(`id=${id}&uc`)}`;
}

async function installDefaultExtension(id, label) {
  const crx = await downloadToBuffer(buildCrxUrl(id), DEFAULT_EXTENSION_TIMEOUT_MS);
  const target = path.join(getLibraryDir(), id);
  const staging = `${target}.incoming`;

  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    unzipBufferTo(crxToZip(crx), staging);
    if (!readManifestAt(staging)) throw new Error('no usable manifest.json inside the CRX');
    // Swap in only once the unpack is known good, so a half-written folder is never
    // handed to Chrome.
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  console.log(`[Extensions] Installed default extension ${label} (${id})`);
}

/**
 * Make sure every default extension is present in the library. Never throws and
 * never blocks a launch on a failure: a profile still opens without them.
 */
async function ensureDefaultExtensions() {
  const marker = readJsonSafe(getDefaultExtensionsMarkerPath()) || {};
  const seeded = new Set(Array.isArray(marker.seeded) ? marker.seeded.map(String) : []);

  const pending = DEFAULT_EXTENSIONS.filter(({ id }) => {
    if (seeded.has(id)) return false;
    return !readManifestAt(path.join(getLibraryDir(), id));
  });
  if (pending.length === 0) return { installed: 0, failed: 0 };

  const lastAttempt = Date.parse(marker.lastAttemptAt || '');
  if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < DEFAULT_EXTENSION_RETRY_MS) {
    return { installed: 0, failed: 0, skipped: 'backoff' };
  }

  fs.mkdirSync(getLibraryDir(), { recursive: true });
  let installed = 0;
  let failed = 0;
  const results = await Promise.allSettled(
    pending.map(({ id, label }) => installDefaultExtension(id, label).then(() => id))
  );
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      seeded.add(pending[index].id);
      installed += 1;
    } else {
      failed += 1;
      console.error(`[Extensions] Could not install ${pending[index].label}:`, result.reason?.message || result.reason);
    }
  }

  try {
    fs.writeFileSync(getDefaultExtensionsMarkerPath(), JSON.stringify({
      seeded: [...seeded],
      lastAttemptAt: new Date().toISOString(),
    }, null, 2));
  } catch (_) { /* a lost marker only means we try again next launch */ }

  return { installed, failed };
}

function removeLibraryExtension(id) {
  const safeId = String(id || '');
  if (!/^[a-z0-9._-]+$/i.test(safeId)) return { success: false, error: 'Invalid extension id' };
  const dir = path.join(getLibraryDir(), safeId);
  if (!fs.existsSync(dir)) return { success: false, error: 'Extension not found' };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    return { success: false, error: err.message || 'Could not delete extension files' };
  }
  return { success: true };
}

/** Both sources in one list; the page labels them so their differences stay visible. */
function listAllExtensions() {
  return [...listLibraryExtensions(), ...listSharedExtensions().map((e) => ({ ...e, source: 'store' }))]
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  DEFAULT_EXTENSIONS,
  ensureDefaultExtensions,
  listAllExtensions,
  listSharedExtensions,
  listLibraryExtensions,
  getLibraryLoadPaths,
  addLibraryExtension,
  removeLibraryExtension,
  removeSharedExtension,
  getSharedExtensionPath,
  getExtensionsRoot,
};
