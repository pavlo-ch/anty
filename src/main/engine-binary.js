/**
 * Download / install / locate the Fortress stealth Chromium engine.
 *
 * Fortress (github.com/tiliondev/fortress, BSD-3, free) is what makes Google sign-in
 * work in a normal CDP-driven launch — stock Chrome + CDP is always bounced to
 * /signin/rejected. It does NOT get past Cloudflare; that stays on the no-CDP window.
 * See docs/patched-chromium-plan.md.
 *
 * WINDOWS ONLY for now: Fortress publishes native win-x64 and linux-x64 binaries; the
 * macOS build is upstream "in progress" and their Docker image is headless, which is
 * useless for a desktop GUI app. macOS keeps the no-CDP window as its free path.
 *
 * The engine is fetched on demand rather than bundled: it is ~200 MB (vs anty's whole
 * installer), and downloading lets the engine be updated without shipping a new anty.
 * Every download is SHA256-verified against the release's SHA256SUMS before it is
 * unpacked — an unverified browser binary is not something to execute.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RELEASES_API = 'https://api.github.com/repos/tiliondev/fortress/releases';
const WIN_ASSET = 'tilion-fortress-win-x64.zip';
const SUMS_ASSET = 'SHA256SUMS';

function getDataDir() {
  if (process.env.ANTY_DATA_DIR) return process.env.ANTY_DATA_DIR;
  try {
    const { app } = require('electron');
    return app.getPath('userData');
  } catch (_) {
    return path.join(os.homedir(), '.anty');
  }
}

function getEnginesRoot() {
  return path.join(getDataDir(), 'engines', 'fortress');
}

function isSupportedPlatform() {
  return process.platform === 'win32';
}

/**
 * Pick the newest release that actually ships the Windows asset.
 *
 * Deliberately not "latest": Fortress's latest release at time of writing (v150) is
 * Linux-only, while v151 and v149 do carry win-x64. Blindly trusting /releases/latest
 * would leave Windows users unable to install anything.
 *
 * Exported for testing — this is pure logic over the API payload.
 */
function pickWindowsRelease(releases) {
  const list = Array.isArray(releases) ? releases : [];
  const withAsset = list.filter(
    (r) => !r.draft && Array.isArray(r.assets) && r.assets.some((a) => a.name === WIN_ASSET)
  );
  if (withAsset.length === 0) return null;
  // Sort by version numbers in the tag, descending, so "newest that has Windows" wins
  // regardless of how GitHub ordered them or which one is flagged latest.
  const key = (r) => String(r.tag_name || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  withAsset.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
      const d = (kb[i] || 0) - (ka[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  const rel = withAsset[0];
  return {
    tag: rel.tag_name,
    zipUrl: rel.assets.find((a) => a.name === WIN_ASSET)?.browser_download_url,
    sumsUrl: rel.assets.find((a) => a.name === SUMS_ASSET)?.browser_download_url || null,
  };
}

/**
 * Parse a SHA256SUMS file ("<hex>  <filename>" per line) into { filename: hex }.
 * Exported for testing.
 */
function parseSums(text) {
  const out = {};
  String(text || '')
    .split('\n')
    .forEach((line) => {
      const m = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
      if (m) out[m[2].trim()] = m[1].toLowerCase();
    });
  return out;
}

function httpsGet(url, { asBuffer = false, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'anty-browser', Accept: '*/*' } },
      (res) => {
        // GitHub release downloads redirect to a CDN host.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(httpsGet(res.headers.location, { asBuffer, redirects: redirects + 1 }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(asBuffer ? buf : buf.toString('utf8'));
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Download timed out')));
  });
}

/** Locate chrome.exe inside an extracted Fortress directory (layout may be nested). */
function findChromeExe(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/^(chrome|tilion|fortress)\.exe$/i.test(e.name)) return p;
    }
  }
  return null;
}

// Memoised: findChromeExe walks an entire extracted Chromium tree (thousands of
// files), and this is consulted on every profile launch — twice, via getActiveEngine
// and again to resolve the path. Re-walking that per launch is pure latency. The
// install path clears the cache, and a stale hit is self-correcting because the
// cached path is existence-checked before use.
let cachedEnginePath;

/** Path to an already-installed engine, or null. */
function resolveInstalledEngine() {
  if (cachedEnginePath !== undefined) {
    if (cachedEnginePath === null || fs.existsSync(cachedEnginePath)) return cachedEnginePath;
    cachedEnginePath = undefined; // binary vanished — fall through and re-scan
  }
  const root = getEnginesRoot();
  if (!fs.existsSync(root)) { cachedEnginePath = null; return null; }
  let versions;
  try { versions = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()); } catch (_) { cachedEnginePath = null; return null; }
  versions.sort().reverse();
  for (const v of versions) {
    const exe = findChromeExe(path.join(root, v));
    if (exe) { cachedEnginePath = exe; return exe; }
  }
  cachedEnginePath = null;
  return null;
}

function clearEngineCache() {
  cachedEnginePath = undefined;
}

function getInstallStatus() {
  const supported = isSupportedPlatform();
  const installedPath = supported ? resolveInstalledEngine() : null;
  return {
    supported,
    platform: process.platform,
    installed: Boolean(installedPath),
    path: installedPath,
    reason: supported
      ? null
      : 'Fortress publishes native Windows/Linux builds only — macOS has no free native build yet. Use "Open without automation" for Google on macOS.',
  };
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // bsdtar ships with Windows 10 1803+ and handles .zip; Expand-Archive is the fallback.
  try {
    execFileSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'ignore' });
    return;
  } catch (_) { /* fall through */ }
  execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
    { stdio: 'ignore' }
  );
}

/**
 * Download, verify and unpack the engine. Returns { ok, path } or { ok:false, error }.
 * onProgress(stage, detail) is optional and purely informational.
 */
async function installEngine(onProgress = () => {}) {
  if (!isSupportedPlatform()) {
    return { ok: false, error: getInstallStatus().reason };
  }
  const existing = resolveInstalledEngine();
  if (existing) return { ok: true, path: existing, alreadyInstalled: true };

  let tmpZip = null;
  try {
    onProgress('query', 'Looking up the newest Fortress release with a Windows build…');
    const releases = JSON.parse(await httpsGet(RELEASES_API));
    const rel = pickWindowsRelease(releases);
    if (!rel || !rel.zipUrl) return { ok: false, error: 'No Fortress release currently ships a Windows x64 build.' };

    onProgress('download', `Downloading ${rel.tag} (~235 MB)…`);
    const zip = await httpsGet(rel.zipUrl, { asBuffer: true });

    onProgress('verify', 'Verifying SHA256…');
    if (!rel.sumsUrl) return { ok: false, error: 'Release has no SHA256SUMS — refusing to install an unverified browser binary.' };
    const expected = parseSums(await httpsGet(rel.sumsUrl))[WIN_ASSET];
    if (!expected) return { ok: false, error: `SHA256SUMS has no entry for ${WIN_ASSET} — refusing to install.` };
    const actual = crypto.createHash('sha256').update(zip).digest('hex');
    if (actual !== expected) {
      return { ok: false, error: `Checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — download rejected.` };
    }

    onProgress('extract', 'Unpacking…');
    const destDir = path.join(getEnginesRoot(), rel.tag);
    fs.mkdirSync(destDir, { recursive: true });
    tmpZip = path.join(os.tmpdir(), `fortress-${Date.now()}.zip`);
    fs.writeFileSync(tmpZip, zip);
    extractZip(tmpZip, destDir);

    clearEngineCache();
    const exe = findChromeExe(destDir);
    if (!exe) {
      try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) {}
      return { ok: false, error: 'Unpacked archive contains no chrome.exe — layout unexpected.' };
    }
    onProgress('done', exe);
    return { ok: true, path: exe, version: rel.tag };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    if (tmpZip) { try { fs.unlinkSync(tmpZip); } catch (_) {} }
  }
}

module.exports = {
  isSupportedPlatform,
  getEnginesRoot,
  resolveInstalledEngine,
  clearEngineCache,
  getInstallStatus,
  installEngine,
  pickWindowsRelease,
  parseSums,
};
