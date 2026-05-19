const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { buildInjectionScript, getLocaleByCountry, countryCodeToFlag, parseUA } = require('./fingerprint');
const { getProfile, updateProfile, deleteProfile: deleteProfileRow } = require('./database');
const profileSync = require('./profile-sync');
const warmup = require('./warmup');
const http = require('http');
const net = require('net');

const STARTUP_NOISE_HOST_PATTERNS = [
  'adtrafficquality.google',
  'googleadservices.com',
  'googlesyndication.com',
  'doubleclick.net',
  'pubmatic.com',
  'openx.net',
  'rubiconproject.com',
  'criteo.com',
  'adsrvr.org',
  'adform.net',
  'adgrx.com',
  'adkernel.com',
  'smartadserver.com',
  'indexww.com',
  'connatix.com',
  'yellowblue.io',
  '3lift.com',
  'id5-sync.com',
  'gumgum.com',
  'simpli.fi',
  'amazon-adsystem.com',
  'btloader.com',
  'botfaqtor.ru',
  'measureadv.com',
  'eskimi.com',
  'creativecdn.com',
  'ctnsnet.com',
  'smilewanted.com',
  'the-ozone-project.com',
  'mediavine.com',
  'pubnation.com',
  'journeymv.com',
  'de17a.com',
  'wp.pl',
];

/**
 * Realistic Chrome patch versions per major version.
 * Google User-Agent reduction makes `navigator.userAgent` always report
 * "X.0.0.0", but Sec-CH-UA-Full-Version / Full-Version-List is supposed to
 * carry the REAL patch number. Setting "X.0.0.0" here is a strong bot signal.
 */
const CHROME_PATCH_VERSIONS = {
  146: ['146.0.7103.113', '146.0.7103.92', '146.0.7103.49'],
  145: ['145.0.7049.95', '145.0.7049.85', '145.0.7049.52'],
  144: ['144.0.6991.101', '144.0.6991.52'],
  143: ['143.0.6965.81', '143.0.6965.51'],
  142: ['142.0.6908.103', '142.0.6908.52'],
  141: ['141.0.6871.87', '141.0.6871.51'],
  140: ['140.0.6849.99', '140.0.6849.62'],
  139: ['139.0.6821.81', '139.0.6821.42'],
  138: ['138.0.6770.111', '138.0.6770.60'],
  137: ['137.0.6735.90', '137.0.6735.51'],
  136: ['136.0.6706.95', '136.0.6706.52'],
  135: ['135.0.6678.82', '135.0.6678.47'],
};

function pickPatchVersion(majorVersion, fingerprintSeed) {
  const pool = CHROME_PATCH_VERSIONS[majorVersion];
  if (!pool || pool.length === 0) return `${majorVersion}.0.0.0`;
  // Deterministic pick per profile so the value is stable between launches.
  const idx = Math.floor(Math.abs((fingerprintSeed || 0) * 1000)) % pool.length;
  return pool[idx];
}

/**
 * Build Sec-CH-UA headers that match the fingerprint UA.
 * Without these, browsers expose the real Chromium version in CH headers
 * which contradicts the spoofed UA — easily detectable by antifraud.
 */
function buildSecChUaHeaders(fingerprint) {
  const ua = fingerprint.userAgent || '';
  const parsed = parseUA(ua);
  if (!parsed || !parsed.browser) return {};

  const majorVersion = parseInt(parsed.version, 10) || 0;
  const isMobile = fingerprint.hardware?.maxTouchPoints > 0;

  // Sec-CH-UA-Platform mapping
  const platformMap = {
    Win: 'Windows', Mac: 'macOS', Linux: 'Linux',
    Android: 'Android', iOS: 'iOS',
  };
  const platform = platformMap[parsed.osShort] || 'Windows';

  // Platform version — Windows always reports "10.0.0" for privacy
  const platformVersionMap = {
    Windows: '10.0.0', macOS: '10_15_7', Linux: '', Android: '10', iOS: '17.0.0',
  };
  const platformVersion = platformVersionMap[platform] || '';

  // Not_A_Brand value varies by Chrome version
  const brandVersion = majorVersion >= 130 ? '24' : majorVersion >= 100 ? '8' : '99';
  const brandName = majorVersion >= 100 ? 'Not_A Brand' : 'Not;A=Brand';

  if (parsed.browser === 'Chrome' || parsed.browser === 'Edge') {
    const edgeBrand = parsed.browser === 'Edge' ? `, "Microsoft Edge";v="${majorVersion}"` : '';
    const secCHUA = `"${brandName}";v="${brandVersion}", "Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}"${edgeBrand}`;
    const fullVer = pickPatchVersion(majorVersion, fingerprint.canvas?.noiseSeed);
    return {
      'Sec-CH-UA': secCHUA,
      'Sec-CH-UA-Mobile': isMobile ? '?1' : '?0',
      'Sec-CH-UA-Platform': `"${platform}"`,
      'Sec-CH-UA-Platform-Version': `"${platformVersion}"`,
      'Sec-CH-UA-Arch': isMobile ? '""' : (platform === 'macOS' && process.arch === 'arm64' ? '"arm"' : '"x86"'),
      'Sec-CH-UA-Bitness': isMobile ? '""' : '"64"',
      'Sec-CH-UA-Full-Version': `"${fullVer}"`,
      'Sec-CH-UA-Full-Version-List': `"${brandName}";v="${brandVersion}.0.0.0", "Chromium";v="${fullVer}", "Google Chrome";v="${fullVer}"${edgeBrand}`,
    };
  }

  if (parsed.browser === 'Firefox') {
    // Firefox doesn't send Sec-CH-UA at all
    return {};
  }

  return {};
}

// Track running browser instances
// Electron mode: { context, page }
// Server mode:   { browserServer, browser, context, page, wsEndpoint, isServer: true }
const runningBrowsers = new Map();

function enqueueProfileSync(profileId) {
  try {
    const profile = getProfile(profileId);
    if (!profile) return;
    profileSync.onLocalProfileUpsert(profile);
    profileSync.scheduleSync();
  } catch (_) {}
}

function startStateAutosave(profileId, context) {
  let stopped = false;
  let saving = false;

  const flush = async () => {
    if (stopped || saving) return;
    saving = true;
    try {
      const allCookies = await context.cookies();
      if (allCookies.length > 0) {
        updateProfile(profileId, { cookies: JSON.stringify(allCookies) });
      }

      const state = await context.storageState();
      const cookieCount = Array.isArray(state?.cookies) ? state.cookies.length : 0;
      const originCount = Array.isArray(state?.origins) ? state.origins.length : 0;
      if (cookieCount > 0 || originCount > 0) {
        updateProfile(profileId, { storage_state: JSON.stringify(state) });
      }

      if (allCookies.length > 0 || cookieCount > 0 || originCount > 0) {
        enqueueProfileSync(profileId);
      }
    } catch (_) {
      // Ignore autosave failures while the profile is navigating or closing.
    } finally {
      saving = false;
    }
  };

  return {
    flush,
    stop() {
      stopped = true;
    }
  };
}

function watchAllPagesClosed(context, onAllPagesClosed) {
  const trackedPages = new Set();
  let stopped = false;
  let closeTimer = null;

  const scheduleCheck = () => {
    if (stopped) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (stopped) return;
      let pages = [];
      try {
        pages = context.pages();
      } catch (_) {
        pages = [];
      }
      if (pages.length === 0) {
        onAllPagesClosed();
      }
    }, 300);
  };

  const trackPage = (targetPage) => {
    if (!targetPage || trackedPages.has(targetPage)) return;
    trackedPages.add(targetPage);
    targetPage.on('close', scheduleCheck);
  };

  context.pages().forEach(trackPage);
  context.on('page', trackPage);

  return {
    stop() {
      stopped = true;
      clearTimeout(closeTimer);
      try { context.off('page', trackPage); } catch (_) {}
      for (const trackedPage of trackedPages) {
        try { trackedPage.off('close', scheduleCheck); } catch (_) {}
      }
      trackedPages.clear();
    },
  };
}

async function installStartupNoiseBlocker(context) {
  const handler = async (route) => {
    const url = route.request().url();
    if (isStartupNoiseUrl(url)) {
      await route.abort('blockedbyclient').catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  };

  await context.route('**/*', handler);
  return () => context.unroute('**/*', handler).catch(() => {});
}

function getDataDir() {
  if (process.env.ANTY_DATA_DIR) return process.env.ANTY_DATA_DIR;
  try {
    const { app } = require('electron');
    return app.getPath('userData');
  } catch {
    return path.join(os.homedir(), '.anty');
  }
}

function getUserDataDir(profileId) {
  return path.join(getDataDir(), 'profiles', `profile_${profileId}`);
}

function getSharedExtensionsDir() {
  return path.join(getDataDir(), 'shared_extensions', 'Extensions');
}

function getSharedExtensionsStatePath() {
  return path.join(getDataDir(), 'shared_extensions', 'extensions_state.json');
}

function readJsonFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return null;
  }
}

function writeJsonFileAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value));
  fs.renameSync(tmpPath, filePath);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function copyDirectoryContents(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (fs.existsSync(targetPath)) continue;
    fs.cpSync(sourcePath, targetPath, { recursive: true, errorOnExist: false });
  }
}

function copyLevelDbDirectoryContents(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === 'LOCK') continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (fs.existsSync(targetPath)) continue;
    fs.cpSync(sourcePath, targetPath, { recursive: true, errorOnExist: false });
  }
}

function replaceDirectoryContents(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  copyLevelDbDirectoryContents(sourceDir, targetDir);
}

function hasValidExtensionVersion(extensionDir) {
  if (!fs.existsSync(extensionDir)) return false;
  try {
    return fs.readdirSync(extensionDir, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && fs.existsSync(path.join(extensionDir, entry.name, 'manifest.json')));
  } catch (_) {
    return false;
  }
}

function getValidExtensionIds(extensionsRoot) {
  if (!fs.existsSync(extensionsRoot)) return [];
  try {
    return fs.readdirSync(extensionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'Temp')
      .map((entry) => entry.name)
      .filter((extensionId) => hasValidExtensionVersion(path.join(extensionsRoot, extensionId)));
  } catch (_) {
    return [];
  }
}

function getLatestExtensionRelativePath(extensionsRoot, extensionId) {
  const extensionDir = path.join(extensionsRoot, extensionId);
  if (!fs.existsSync(extensionDir)) return null;

  try {
    const versions = fs.readdirSync(extensionDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((version) => fs.existsSync(path.join(extensionDir, version, 'manifest.json')))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    return versions[0] ? path.join(extensionId, versions[0]) : null;
  } catch (_) {
    return null;
  }
}

function removeInvalidExtensionDirs(extensionsRoot) {
  if (!fs.existsSync(extensionsRoot)) return;
  try {
    for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'Temp') continue;
      const extensionDir = path.join(extensionsRoot, entry.name);
      if (!hasValidExtensionVersion(extensionDir)) {
        fs.rmSync(extensionDir, { recursive: true, force: true });
      }
    }
  } catch (_) {}
}

function copyValidExtensions(sourceRoot, targetRoot) {
  if (!fs.existsSync(sourceRoot)) return;
  fs.mkdirSync(targetRoot, { recursive: true });
  removeInvalidExtensionDirs(sourceRoot);

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'Temp') continue;
    const sourceExtensionDir = path.join(sourceRoot, entry.name);
    if (!hasValidExtensionVersion(sourceExtensionDir)) continue;
    const targetExtensionDir = path.join(targetRoot, entry.name);
    copyDirectoryContents(sourceExtensionDir, targetExtensionDir);
  }
}

const EXTENSION_RUNTIME_DIRS = ['Extension Rules'];

function copyExtensionRuntimeStores(sourceDefaultDir, targetRootDir, replace = false) {
  for (const dirName of EXTENSION_RUNTIME_DIRS) {
    const sourceDir = path.join(sourceDefaultDir, dirName);
    const targetDir = path.join(targetRootDir, dirName);
    if (!fs.existsSync(sourceDir)) continue;
    if (replace) replaceDirectoryContents(sourceDir, targetDir);
    else copyDirectoryContents(sourceDir, targetDir);
  }
}

function syncExtensionSettingsToShared(userDataDir) {
  const defaultDir = path.join(userDataDir, 'Default');
  const profileExtensionsDir = path.join(defaultDir, 'Extensions');
  const securePrefs = readJsonFileSafe(path.join(defaultDir, 'Secure Preferences'));
  if (!securePrefs?.extensions?.settings) return;

  const extensionIds = getValidExtensionIds(profileExtensionsDir);
  if (extensionIds.length === 0) return;
  copyExtensionRuntimeStores(defaultDir, path.join(getDataDir(), 'shared_extensions'), true);

  const statePath = getSharedExtensionsStatePath();
  const sharedState = readJsonFileSafe(statePath) || {};
  sharedState.version = 1;
  sharedState.settings = sharedState.settings || {};
  sharedState.macs = sharedState.macs || {};

  let changed = false;
  for (const extensionId of extensionIds) {
    const setting = securePrefs.extensions.settings[extensionId];
    if (!setting) continue;

    const nextSetting = cloneJson(setting);
    const relativePath = getLatestExtensionRelativePath(profileExtensionsDir, extensionId);
    if (relativePath) nextSetting.path = relativePath;

    sharedState.settings[extensionId] = nextSetting;
    const mac = securePrefs.protection?.macs?.extensions?.settings?.[extensionId];
    if (mac) sharedState.macs[extensionId] = mac;
    changed = true;
  }

  if (changed) writeJsonFileAtomic(statePath, sharedState);
}

function applySharedExtensionSettings(userDataDir) {
  const sharedState = readJsonFileSafe(getSharedExtensionsStatePath());
  if (!sharedState?.settings) return;

  const defaultDir = path.join(userDataDir, 'Default');
  const profileExtensionsDir = path.join(defaultDir, 'Extensions');
  const securePrefsPath = path.join(defaultDir, 'Secure Preferences');
  const securePrefs = readJsonFileSafe(securePrefsPath) || {};

  securePrefs.extensions = securePrefs.extensions || {};
  securePrefs.extensions.settings = securePrefs.extensions.settings || {};

  let changed = false;
  for (const [extensionId, setting] of Object.entries(sharedState.settings)) {
    if (securePrefs.extensions.settings[extensionId]) continue;

    const relativePath = getLatestExtensionRelativePath(profileExtensionsDir, extensionId);
    if (!relativePath) continue;
    copyExtensionRuntimeStores(path.join(getDataDir(), 'shared_extensions'), defaultDir, true);

    const nextSetting = cloneJson(setting);
    nextSetting.path = relativePath;
    securePrefs.extensions.settings[extensionId] = nextSetting;

    const mac = sharedState.macs?.[extensionId];
    if (mac) {
      securePrefs.protection = securePrefs.protection || {};
      securePrefs.protection.macs = securePrefs.protection.macs || {};
      securePrefs.protection.macs.extensions = securePrefs.protection.macs.extensions || {};
      securePrefs.protection.macs.extensions.settings = securePrefs.protection.macs.extensions.settings || {};
      securePrefs.protection.macs.extensions.settings[extensionId] = mac;
    }
    changed = true;
  }

  if (changed) writeJsonFileAtomic(securePrefsPath, securePrefs);
}

function ensureSharedExtensionsDir(userDataDir) {
  const defaultDir = path.join(userDataDir, 'Default');
  const profileExtensionsDir = path.join(defaultDir, 'Extensions');
  const sharedExtensionsDir = getSharedExtensionsDir();

  try {
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.mkdirSync(sharedExtensionsDir, { recursive: true });

    if (fs.existsSync(profileExtensionsDir)) {
      const stat = fs.lstatSync(profileExtensionsDir);
      if (stat.isSymbolicLink()) {
        fs.rmSync(profileExtensionsDir, { recursive: true, force: true });
      } else if (stat.isDirectory()) {
        copyValidExtensions(profileExtensionsDir, sharedExtensionsDir);
      } else {
        fs.rmSync(profileExtensionsDir, { force: true });
      }
    }

    fs.mkdirSync(profileExtensionsDir, { recursive: true });
    removeInvalidExtensionDirs(profileExtensionsDir);
    copyValidExtensions(sharedExtensionsDir, profileExtensionsDir);
    applySharedExtensionSettings(userDataDir);
  } catch (err) {
    console.warn(`[Launcher] Shared extensions setup skipped: ${err.message}`);
  }
}

function syncProfileExtensionsToShared(userDataDir) {
  const profileExtensionsDir = path.join(userDataDir, 'Default', 'Extensions');
  const sharedExtensionsDir = getSharedExtensionsDir();

  try {
    if (!fs.existsSync(profileExtensionsDir)) return;
    if (fs.lstatSync(profileExtensionsDir).isSymbolicLink()) return;
    fs.mkdirSync(sharedExtensionsDir, { recursive: true });
    copyValidExtensions(profileExtensionsDir, sharedExtensionsDir);
    syncExtensionSettingsToShared(userDataDir);
  } catch (err) {
    console.warn(`[Launcher] Shared extensions save skipped: ${err.message}`);
  }
}

function writeJsonFileSafe(filePath, patcher) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = raw ? JSON.parse(raw) : {};
    const next = patcher(parsed) || parsed;
    fs.writeFileSync(filePath, JSON.stringify(next));
    return true;
  } catch (_) {
    return false;
  }
}

function isStartupNoiseUrl(rawUrl) {
  try {
    const host = new URL(String(rawUrl || '')).hostname.replace(/^www\./, '').toLowerCase();
    return STARTUP_NOISE_HOST_PATTERNS.some((pattern) => host === pattern || host.endsWith(`.${pattern}`));
  } catch (_) {
    return false;
  }
}

function cleanupStartupNoiseHistory(userDataDir) {
  const historyPath = path.join(userDataDir, 'Default', 'History');
  if (!fs.existsSync(historyPath)) return;

  let chromeHistoryDb = null;
  try {
    const Database = require('better-sqlite3');
    chromeHistoryDb = new Database(historyPath);
    const rows = chromeHistoryDb.prepare('SELECT id, url FROM urls').all();
    const ids = rows
      .filter((row) => isStartupNoiseUrl(row.url))
      .map((row) => row.id)
      .filter((id) => Number.isFinite(Number(id)));

    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(',');
    chromeHistoryDb.prepare(`DELETE FROM visits WHERE url IN (${placeholders})`).run(...ids);
    chromeHistoryDb.prepare(`DELETE FROM urls WHERE id IN (${placeholders})`).run(...ids);
  } catch (_) {
    // Chrome may have History locked; the network blocker still prevents new noise.
  } finally {
    try { chromeHistoryDb?.close?.(); } catch (_) {}
  }
}

function disableChromeSessionRestore(userDataDir, startAction = 'open-page') {
  if (startAction === 'continue-session') return;

  try {
    const sessionsDir = path.join(userDataDir, 'Default', 'Sessions');
    if (fs.existsSync(sessionsDir)) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  } catch (_) {}

  writeJsonFileSafe(path.join(userDataDir, 'Default', 'Preferences'), (prefs) => {
    prefs.profile = {
      ...(prefs.profile || {}),
      exit_type: 'Normal',
      exited_cleanly: true,
    };
    prefs.session = {
      ...(prefs.session || {}),
      restore_on_startup: 5,
      startup_urls: [],
    };
    return prefs;
  });

  writeJsonFileSafe(path.join(userDataDir, 'Local State'), (state) => {
    state.exited_cleanly = true;
    return state;
  });

  cleanupStartupNoiseHistory(userDataDir);
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildProxyHeaders(proxyData) {
  if (!proxyData.username) return {};
  const auth = Buffer.from(`${proxyData.username}:${proxyData.password || ''}`).toString('base64');
  return { 'Proxy-Authorization': `Basic ${auth}` };
}

function requestThroughHttpProxy(proxyData, targetUrl, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: proxyData.host,
      port: toNumber(proxyData.port, 0),
      path: targetUrl,
      method: 'GET',
      timeout: timeoutMs,
      headers: buildProxyHeaders(proxyData),
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({
        ok: true,
        statusCode: res.statusCode || 0,
        body: data,
      }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Connection timeout' });
    });
    req.end();
  });
}

function connectThroughSocks5(proxyData, targetHost, targetPort, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: proxyData.host,
      port: toNumber(proxyData.port, 1080),
    });
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    let settled = false;

    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(message));
    };

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      resolve(socket);
    };

    const timer = setTimeout(() => fail('SOCKS5 connection timeout'), timeoutMs);

    const sendConnect = () => {
      const host = Buffer.from(String(targetHost));
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
        host,
        Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
      ]));
      stage = 'connect';
    };

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05) return fail('Invalid SOCKS5 greeting response');
        const method = buffer[1];
        buffer = buffer.slice(2);
        if (method === 0xff) return fail('SOCKS5 proxy rejected authentication methods');
        if (method === 0x02) {
          const username = Buffer.from(String(proxyData.username || ''));
          const password = Buffer.from(String(proxyData.password || ''));
          if (username.length > 255 || password.length > 255) return fail('SOCKS5 credentials are too long');
          socket.write(Buffer.concat([
            Buffer.from([0x01, username.length]),
            username,
            Buffer.from([password.length]),
            password,
          ]));
          stage = 'auth';
          return;
        }
        if (method !== 0x00) return fail('Unsupported SOCKS5 authentication method');
        sendConnect();
        return;
      }

      if (stage === 'auth') {
        if (buffer.length < 2) return;
        if (buffer[1] !== 0x00) return fail('SOCKS5 authentication failed');
        buffer = buffer.slice(2);
        sendConnect();
        return;
      }

      if (stage === 'connect') {
        if (buffer.length < 5) return;
        if (buffer[1] !== 0x00) return fail(`SOCKS5 connect failed (${buffer[1]})`);
        const atyp = buffer[3];
        let responseLength = 0;
        if (atyp === 0x01) responseLength = 10;
        else if (atyp === 0x03) responseLength = 5 + buffer[4] + 2;
        else if (atyp === 0x04) responseLength = 22;
        else return fail('Invalid SOCKS5 address type');
        if (buffer.length < responseLength) return;
        done();
      }
    };

    socket.on('connect', () => {
      const wantsAuth = Boolean(proxyData.username);
      socket.write(Buffer.from(wantsAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    });
    socket.on('data', onData);
    socket.on('error', (err) => fail(err.message || 'SOCKS5 connection failed'));
    socket.on('end', () => fail('SOCKS5 connection closed early'));
  });
}

function requestThroughSocks5Proxy(proxyData, targetUrl, timeoutMs = 10000) {
  return new Promise(async (resolve) => {
    let parsedUrl = null;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (_) {
      resolve({ ok: false, error: 'Invalid URL' });
      return;
    }

    const targetPort = Number(parsedUrl.port) || (parsedUrl.protocol === 'https:' ? 443 : 80);
    let socket = null;
    let response = Buffer.alloc(0);
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, error: 'HTTP response timeout' }), timeoutMs);

    try {
      socket = await connectThroughSocks5(proxyData, parsedUrl.hostname, targetPort, timeoutMs);
      socket.write(`GET ${parsedUrl.pathname}${parsedUrl.search} HTTP/1.1\r\nHost: ${parsedUrl.hostname}\r\nConnection: close\r\n\r\n`);
      socket.on('data', (chunk) => { response = Buffer.concat([response, chunk]); });
      socket.on('error', (err) => finish({ ok: false, error: err.message || 'SOCKS5 request failed' }));
      socket.on('end', () => {
        const raw = response.toString('utf8');
        const headerEnd = raw.indexOf('\r\n\r\n');
        const header = headerEnd >= 0 ? raw.slice(0, headerEnd) : '';
        const body = headerEnd >= 0 ? raw.slice(headerEnd + 4) : raw;
        const statusCode = Number(header.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] || 0);
        finish({ ok: true, statusCode, body });
      });
    } catch (err) {
      finish({ ok: false, error: err.message || 'SOCKS5 request failed' });
    }
  });
}

async function createSocks5HttpBridge(proxyData) {
  const sockets = new Set();
  let closed = false;
  const server = http.createServer();

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('request', async (req, res) => {
    let parsedUrl = null;
    try {
      parsedUrl = new URL(req.url);
      const targetPort = Number(parsedUrl.port) || 80;
      const upstream = await connectThroughSocks5(proxyData, parsedUrl.hostname, targetPort);
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      const requestPath = `${parsedUrl.pathname}${parsedUrl.search}`;
      const headers = Object.entries(req.headers)
        .filter(([key]) => key.toLowerCase() !== 'proxy-connection')
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n');
      upstream.write(`${req.method} ${requestPath} HTTP/1.1\r\n${headers}\r\n\r\n`);
      req.pipe(upstream);
      upstream.pipe(res);
      upstream.on('error', () => res.end());
      res.on('close', () => upstream.destroy());
    } catch (err) {
      if (!res.headersSent) res.writeHead(502);
      res.end(err.message || 'SOCKS5 bridge failed');
    }
  });

  server.on('connect', async (req, clientSocket, head) => {
    const [targetHost, rawPort] = String(req.url || '').split(':');
    const targetPort = Number(rawPort) || 443;
    try {
      const upstream = await connectThroughSocks5(proxyData, targetHost, targetPort);
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    } catch (_) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      if (closed) return resolve();
      closed = true;
      for (const socket of sockets) {
        try { socket.destroy(); } catch (_) {}
      }
      try { server.close(() => resolve()); } catch (_) { resolve(); }
    }),
  };
}

async function createHttpProxyBridge(proxyData) {
  const sockets = new Set();
  let closed = false;
  const server = http.createServer();

  const proxyHost = String(proxyData.host || '').trim();
  const proxyPort = toNumber(proxyData.port, 80);
  const proxyAuthHeaders = buildProxyHeaders(proxyData);

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('request', (req, res) => {
    const headers = { ...req.headers, ...proxyAuthHeaders };
    delete headers['proxy-connection'];

    const upstream = http.request({
      host: proxyHost,
      port: proxyPort,
      method: req.method,
      path: req.url,
      headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(err.message || 'HTTP proxy bridge failed');
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    const upstream = net.createConnection({ host: proxyHost, port: proxyPort });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));

    let response = Buffer.alloc(0);
    let connected = false;

    const fail = () => {
      try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (_) {}
      try { clientSocket.destroy(); } catch (_) {}
      try { upstream.destroy(); } catch (_) {}
    };

    upstream.on('connect', () => {
      const authLine = proxyAuthHeaders['Proxy-Authorization']
        ? `Proxy-Authorization: ${proxyAuthHeaders['Proxy-Authorization']}\r\n`
        : '';
      upstream.write(
        `CONNECT ${req.url} HTTP/1.1\r\n` +
        `Host: ${req.url}\r\n` +
        authLine +
        'Proxy-Connection: keep-alive\r\n' +
        '\r\n'
      );
    });

    upstream.on('data', (chunk) => {
      if (connected) return;
      response = Buffer.concat([response, chunk]);
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const header = response.slice(0, headerEnd).toString('latin1');
      const statusCode = Number(header.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] || 0);
      if (statusCode < 200 || statusCode >= 300) {
        fail();
        return;
      }

      connected = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = response.slice(headerEnd + 4);
      if (rest.length) clientSocket.write(rest);
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on('error', fail);
    clientSocket.on('error', () => upstream.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      if (closed) return resolve();
      closed = true;
      for (const socket of sockets) {
        try { socket.destroy(); } catch (_) {}
      }
      try { server.close(() => resolve()); } catch (_) { resolve(); }
    }),
  };
}

async function requestDirectGeo(timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      'http://ip-api.com/json/?fields=status,message,query,countryCode,timezone,country',
      { cache: 'no-store', signal: controller.signal }
    );
    if (!response.ok) {
      return { success: false, error: `Geo request failed (${response.status})`, ip: null, country: null };
    }

    let geo = null;
    try {
      geo = await response.json();
    } catch {
      geo = null;
    }
    if (!geo || geo.status !== 'success') {
      return { success: false, error: geo?.message || 'Failed to resolve direct geolocation.', ip: null, country: null };
    }

    return {
      success: true,
      ip: String(geo.query || ''),
      country: String(geo.country || ''),
      countryCode: String(geo.countryCode || '').toUpperCase(),
      timezone: String(geo.timezone || ''),
      latencyMs: null,
    };
  } catch (err) {
    return { success: false, error: err.message, ip: null, country: null };
  } finally {
    clearTimeout(timeout);
  }
}

function buildEnglishLocale(countryCode, timezone) {
  const code = String(countryCode || '').trim().toUpperCase();
  const tz = String(timezone || '').trim();
  const preset = getLocaleByCountry(code, tz);
  const fallbackCountry = code || preset?.country || 'US';
  const fallbackTimezone = tz || preset?.timezone || 'America/New_York';
  return {
    lang: 'en-US',
    langs: ['en-US', 'en'],
    timezone: fallbackTimezone,
    country: fallbackCountry,
    flag: preset?.flag || countryCodeToFlag(fallbackCountry),
  };
}

function normalizeSameSite(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v === 'unspecified' || v === 'no_restriction') return undefined;
  if (v === 'lax') return 'Lax';
  if (v === 'strict') return 'Strict';
  if (v === 'none') return 'None';
  return undefined;
}

function normalizeCookieForPlaywright(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = String(raw.name || '').trim();
  const value = raw.value == null ? '' : String(raw.value);
  if (!name) return null;

  const url = String(raw.url || '').trim();
  const domain = String(raw.domain || '').trim();
  const cookiePath = String(raw.path || '/').trim() || '/';

  const cookie = { name, value };
  if (url) {
    cookie.url = url;
  } else if (domain) {
    cookie.domain = domain;
    cookie.path = cookiePath;
  } else {
    return null;
  }

  if (typeof raw.httpOnly === 'boolean') cookie.httpOnly = raw.httpOnly;
  if (typeof raw.secure === 'boolean') cookie.secure = raw.secure;

  const sameSite = normalizeSameSite(raw.sameSite);
  if (sameSite) cookie.sameSite = sameSite;
  if (cookie.sameSite === 'None' && cookie.secure !== true) cookie.secure = true;

  const expiresNum = Number(raw.expires ?? raw.expirationDate);
  if (Number.isFinite(expiresNum) && expiresNum > 0 && !raw.session) {
    cookie.expires = expiresNum;
  }

  return cookie;
}

// ===== PROXY CHECK =====
async function checkProxy(proxyData) {
  const proxyType = String(proxyData.type || 'http').toLowerCase();
  const isSocks5 = proxyType === 'socks5' || proxyType === 'sock5';
  if (proxyType !== 'http' && proxyType !== 'https' && !isSocks5) {
    return {
      success: false,
      error: 'Proxy check for locale supports only HTTP/HTTPS/SOCKS5 proxies.',
      ip: null,
      country: null,
    };
  }

  if (!proxyData.host || !proxyData.port) {
    return {
      success: false,
      error: 'Proxy host/port is required.',
      ip: null,
      country: null,
    };
  }

  const startedAt = Date.now();
  try {
    const geoUrl = 'http://ip-api.com/json/?fields=status,message,query,countryCode,timezone,country';
    const geoResponse = isSocks5
      ? await requestThroughSocks5Proxy(proxyData, geoUrl, 10000)
      : await requestThroughHttpProxy(proxyData, geoUrl, 10000);
    if (!geoResponse.ok) {
      return { success: false, error: geoResponse.error || 'Proxy request failed', ip: null, country: null };
    }
    if (geoResponse.statusCode >= 400) {
      return { success: false, error: `Proxy request failed (${geoResponse.statusCode})`, ip: null, country: null };
    }

    let geo = null;
    try {
      geo = JSON.parse(geoResponse.body || '{}');
    } catch {
      geo = null;
    }
    if (!geo || geo.status !== 'success') {
      return {
        success: false,
        error: geo?.message || 'Failed to resolve proxy geolocation.',
        ip: null,
        country: null,
      };
    }

    const countryCode = String(geo.countryCode || '').toUpperCase();
    const timezone = String(geo.timezone || '');
    const locale = buildEnglishLocale(countryCode, timezone);

    return {
      success: true,
      ip: String(geo.query || ''),
      country: String(geo.country || ''),
      countryCode,
      timezone,
      language: locale?.lang || null,
      languages: locale?.langs || null,
      flag: locale?.flag || null,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    return { success: false, error: err.message, ip: null, country: null };
  }
}

async function syncProfileLocaleFromProxy(profileId) {
  const profile = getProfile(profileId);
  if (!profile) {
    return { success: false, error: 'Profile not found' };
  }
  const hasProxy = Boolean(profile.proxy_host && profile.proxy_port);
  const geoResult = hasProxy
    ? await checkProxy({
      type: profile.proxy_type || 'http',
      host: profile.proxy_host,
      port: profile.proxy_port,
      username: profile.proxy_username || '',
      password: profile.proxy_password || '',
    })
    : await requestDirectGeo();
  if (!geoResult.success) return geoResult;

  const locale = buildEnglishLocale(geoResult.countryCode, geoResult.timezone);

  let fingerprint = {};
  try {
    fingerprint = JSON.parse(profile.fingerprint || '{}');
  } catch {
    fingerprint = {};
  }

  fingerprint.locale = {
    language: locale.lang,
    languages: locale.langs,
    timezone: locale.timezone,
    country: locale.country,
    flag: locale.flag,
  };

  const updated = updateProfile(profileId, { fingerprint });
  return {
    success: true,
    source: hasProxy ? 'proxy' : 'direct',
    profile: updated,
    proxy: {
      ip: geoResult.ip,
      countryCode: geoResult.countryCode,
      timezone: geoResult.timezone,
      language: locale.lang,
      flag: locale.flag,
    },
  };
}

async function deleteProfile(profileId, options = {}) {
  const numericId = toNumber(profileId, 0);
  if (!numericId) {
    return { success: false, error: 'Invalid profile id' };
  }

  const profile = getProfile(numericId);
  if (!profile) {
    return { success: false, error: 'Profile not found' };
  }

  if (runningBrowsers.has(numericId)) {
    const stopped = await stopProfile(numericId);
    if (!stopped.success) {
      return { success: false, error: `Failed to stop running profile: ${stopped.error}` };
    }
  }

  if (options.enqueueCloudDelete !== false) {
    try {
      profileSync.onLocalProfileDelete(profile);
      profileSync.scheduleSync();
    } catch (_) {
      // Keep local delete robust even if sync queue fails.
    }
  }

  const result = deleteProfileRow(numericId);
  if (!result.changes) {
    return { success: false, error: 'Profile not found' };
  }

  const userDataDir = getUserDataDir(numericId);
  try {
    if (fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  } catch (err) {
    return { success: false, error: `Profile removed from DB, but files cleanup failed: ${err.message}` };
  }

  return { success: true };
}

async function launchProfile(profileId, mainWindow) {
  if (runningBrowsers.has(profileId)) {
    console.log(`[Launcher] Profile ${profileId} is already running`);
    return { success: false, error: 'Profile is already running' };
  }

  const profile = getProfile(profileId);
  if (!profile) {
    return { success: false, error: 'Profile not found' };
  }

  const fingerprint = JSON.parse(profile.fingerprint || '{}');
  const userDataDir = getUserDataDir(profileId);
  let proxyBridge = null;
  const startAction = String(fingerprint.startAction || 'open-page');

  console.log(`[Launcher] Launching profile ${profileId}: ${profile.name}`);
  console.log(`[Launcher] User data dir: ${userDataDir}`);

  try {
    ensureSharedExtensionsDir(userDataDir);
    disableChromeSessionRestore(userDataDir, startAction);

    // Cap viewport to reasonable desktop size (never larger than 1920x1080 for actual window)
    const viewportWidth = Math.min(fingerprint.screen?.width || 1280, 1440);
    const viewportHeight = Math.min(fingerprint.screen?.height || 900, 900);

    // Build launch options
    // NOTE: do NOT pass --disable-blink-features=AutomationControlled.
    // Chrome 136+ marks it as "unsupported command-line flag" and shows a
    // yellow warning banner, which Google uses as a strong bot signal.
    // navigator.webdriver is already handled by:
    //  1) ignoreDefaultArgs: ['--enable-automation'] (Chrome doesn't set it)
    //  2) prototype-level override in buildInjectionScript (fingerprint.js)
    const launchOptions = {
      headless: false,
      args: [
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-quic',
        '--disable-features=AsyncDns,UseDnsHttpsSvcbAlpn',
        `--window-size=${viewportWidth},${viewportHeight}`,
      ],
    };
    // Find Chromium executable — try common paths per platform
    const isWin = process.platform === 'win32';
    const pf64 = process.env['ProgramW6432'] || process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';

    const chromiumPaths = isWin
      ? [
          `${pf64}\\Google\\Chrome\\Application\\chrome.exe`,
          `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
          local ? `${local}\\Google\\Chrome\\Application\\chrome.exe` : '',
          `${pf64}\\Chromium\\Application\\chrome.exe`,
          `${pf86}\\Chromium\\Application\\chrome.exe`,
        ].filter(Boolean)
      : [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/google-chrome',
        ];

    let executablePath = null;
    for (const p of chromiumPaths) {
      if (fs.existsSync(p)) {
        executablePath = p;
        break;
      }
    }

    if (executablePath) {
      launchOptions.executablePath = executablePath;
    } else {
      const installHint = isWin
        ? 'Install Google Chrome from https://www.google.com/chrome and try again.'
        : 'Install Google Chrome and try again.';
      throw new Error(
        `Google Chrome or Chromium not found.\n${installHint}\n` +
        'Expected paths:\n' + chromiumPaths.join('\n')
      );
    }

    // Context options — keep GUI viewport dynamic so fullscreen/window resize is real.
    // A fixed viewport pins page height and can clip sticky bottom buttons.
    const secChHeaders = buildSecChUaHeaders(fingerprint);
    const contextOptions = {
      userAgent: fingerprint.userAgent,
      locale: fingerprint.locale?.language || 'en-US',
      timezoneId: fingerprint.locale?.timezone || 'America/New_York',
      viewport: null,
      screen: {
        width: fingerprint.screen?.width || 1920,
        height: fingerprint.screen?.height || 1080,
      },
      colorScheme: 'no-preference',
      ...(Object.keys(secChHeaders).length > 0 ? { extraHTTPHeaders: secChHeaders } : {}),
    };

    // Add proxy if configured
    if (profile.proxy_host && profile.proxy_host !== '') {
      const profileProxyType = String(profile.proxy_type || 'http').toLowerCase();
      const isSocks5 = profileProxyType === 'socks5' || profileProxyType === 'sock5';
      if (isSocks5) {
        proxyBridge = await createSocks5HttpBridge({
          type: 'socks5',
          host: profile.proxy_host,
          port: profile.proxy_port || 1080,
          username: profile.proxy_username || '',
          password: profile.proxy_password || '',
        });
        launchOptions.args.push(`--proxy-server=${proxyBridge.serverUrl}`);
      } else {
        // Most providers label these as "HTTPS proxies", but Chrome expects an
        // HTTP proxy endpoint that uses CONNECT for HTTPS destinations.
        const chromeProxyType = profileProxyType === 'https' ? 'http' : profileProxyType;
        if (profile.proxy_username) {
          proxyBridge = await createHttpProxyBridge({
            type: chromeProxyType,
            host: profile.proxy_host,
            port: profile.proxy_port || 80,
            username: profile.proxy_username || '',
            password: profile.proxy_password || '',
          });
          launchOptions.args.push(`--proxy-server=${proxyBridge.serverUrl}`);
        } else {
          launchOptions.args.push(`--proxy-server=${chromeProxyType}://${profile.proxy_host}:${profile.proxy_port || 80}`);
        }
      }
      launchOptions.args.push('--proxy-bypass-list=<-loopback>');
    }

    // Geolocation based on timezone
    const geoMap = {
      'America/New_York': { latitude: 40.7128, longitude: -74.0060 },
      'America/Chicago': { latitude: 41.8781, longitude: -87.6298 },
      'America/Los_Angeles': { latitude: 34.0522, longitude: -118.2437 },
      'Europe/London': { latitude: 51.5074, longitude: -0.1278 },
      'Europe/Berlin': { latitude: 52.5200, longitude: 13.4050 },
      'Europe/Paris': { latitude: 48.8566, longitude: 2.3522 },
      'Europe/Warsaw': { latitude: 52.2297, longitude: 21.0122 },
      'Europe/Kyiv': { latitude: 50.4501, longitude: 30.5234 },
      'Europe/Madrid': { latitude: 40.4168, longitude: -3.7038 },
      'Europe/Rome': { latitude: 41.9028, longitude: 12.4964 },
      'Europe/Amsterdam': { latitude: 52.3676, longitude: 4.9041 },
      'Europe/Istanbul': { latitude: 41.0082, longitude: 28.9784 },
      'America/Sao_Paulo': { latitude: -23.5505, longitude: -46.6333 },
      'Asia/Tokyo': { latitude: 35.6762, longitude: 139.6503 },
      'Asia/Seoul': { latitude: 37.5665, longitude: 126.9780 },
      'Asia/Shanghai': { latitude: 31.2304, longitude: 121.4737 },
      'Asia/Ho_Chi_Minh': { latitude: 10.8231, longitude: 106.6297 },
      'Asia/Bangkok': { latitude: 13.7563, longitude: 100.5018 },
    };
    
    const geo = geoMap[fingerprint.locale?.timezone];
    if (geo) {
      contextOptions.geolocation = geo;
      contextOptions.permissions = ['geolocation'];
    }

    const injectionScript = buildInjectionScript(fingerprint);
    const warmupUrl = profile.warmup_url;
    const startPage = profile.start_page || 'https://whoer.net';
    const parsedStorageState = (() => {
      try {
        const raw = profile.storage_state ? JSON.parse(profile.storage_state) : null;
        const cookieCount = Array.isArray(raw?.cookies) ? raw.cookies.length : 0;
        const originCount = Array.isArray(raw?.origins) ? raw.origins.length : 0;
        return cookieCount > 0 || originCount > 0 ? raw : null;
      } catch (_) {
        return null;
      }
    })();

    // Helper: import cookies into a context
    async function importCookies(ctx) {
      if (!profile.cookies || profile.cookies === '[]') return;
      try {
        const cookies = JSON.parse(profile.cookies)
          .map(normalizeCookieForPlaywright)
          .filter(Boolean);
        if (cookies.length > 0) await ctx.addCookies(cookies);
      } catch (e) {
        console.error('[Launcher] Failed to import cookies:', e.message);
      }
    }

    async function importStorageState(ctx) {
      if (!parsedStorageState) return false;

      const cookies = Array.isArray(parsedStorageState.cookies)
        ? parsedStorageState.cookies.map(normalizeCookieForPlaywright).filter(Boolean)
        : [];
      if (cookies.length > 0) {
        await ctx.addCookies(cookies);
      }

      const origins = Array.isArray(parsedStorageState.origins)
        ? parsedStorageState.origins
            .filter((entry) => entry && typeof entry.origin === 'string' && Array.isArray(entry.localStorage))
            .map((entry) => ({
              origin: entry.origin,
              localStorage: entry.localStorage
                .filter((item) => item && typeof item.name === 'string')
                .map((item) => ({ name: item.name, value: String(item.value ?? '') }))
            }))
        : [];

      if (origins.length > 0) {
        await ctx.addInitScript(({ origins }) => {
          try {
            const current = window.location.origin;
            const match = origins.find((entry) => entry.origin === current);
            if (!match) return;
            for (const item of match.localStorage) {
              try { window.localStorage.setItem(item.name, item.value); } catch (_) {}
            }
          } catch (_) {}
        }, { origins });
      }

      return cookies.length > 0 || origins.length > 0;
    }

    // Helper: save cookies from a context
    async function saveCookies(ctx) {
      try {
        const allCookies = await ctx.cookies();
        if (allCookies.length > 0) {
          updateProfile(profileId, { cookies: JSON.stringify(allCookies) });
          enqueueProfileSync(profileId);
          console.log(`[Launcher] Saved ${allCookies.length} cookies for profile ${profileId}`);
        }
      } catch (e) {
        console.log(`[Launcher] Could not save cookies: ${e.message}`);
      }
    }

    async function saveStorageState(ctx) {
      try {
        const state = await ctx.storageState();
        if (state && (Array.isArray(state.cookies) || Array.isArray(state.origins))) {
          updateProfile(profileId, { storage_state: JSON.stringify(state) });
          enqueueProfileSync(profileId);
          console.log(`[Launcher] Saved storage_state for profile ${profileId}`);
        }
      } catch (e) {
        console.log(`[Launcher] Could not save storage_state: ${e.message}`);
      }
    }

    // Helper: navigate warmup + start page
    async function navigate(page) {
      if (startAction === 'new-tab') {
        await page.goto('about:blank').catch(() => {});
        return;
      }
      if (warmupUrl && !warmupUrl.startsWith('chrome://')) {
        await page.goto(warmupUrl).catch(() => {});
        await page.waitForTimeout(2500).catch(() => {});
      }
      if (!startPage.startsWith('chrome://')) {
        await page.goto(startPage).catch(() => {});
      }
    }

    // In Linux server mode under root, Chromium must keep --no-sandbox.
    const serverIgnoreDefaultArgs =
      process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
        ? ['--enable-automation']
        : ['--enable-automation', '--no-sandbox'];

    // ── SERVER / HEADLESS MODE ──────────────────────────────────────────────
    if (mainWindow === null || (typeof mainWindow === 'object' && mainWindow && mainWindow.__serverMode)) {
      const browserServer = await chromium.launchServer({
        headless: true,
        executablePath,
        args: [
          '--disable-infobars',
          '--no-first-run',
          '--no-default-browser-check',
          `--window-size=${viewportWidth},${viewportHeight}`,
        ],
        ignoreDefaultArgs: serverIgnoreDefaultArgs,
      });

      const wsEndpoint = browserServer.wsEndpoint();
      const browser = await chromium.connect(wsEndpoint);
      const serverContextOptions = {
        ...contextOptions,
        viewport: { width: viewportWidth, height: viewportHeight },
        deviceScaleFactor: 1,
      };
      const context = parsedStorageState
        ? await browser.newContext({ ...serverContextOptions, storageState: parsedStorageState })
        : await browser.newContext({ ...serverContextOptions });

      await context.addInitScript(injectionScript);
      if (!parsedStorageState) {
        await importCookies(context);
      }

      const cleanupStartupBlocker = await installStartupNoiseBlocker(context).catch(() => null);
      const page = await context.newPage();
      await navigate(page);
      cleanupStartupBlocker?.();
      const autosave = startStateAutosave(profileId, context);

      let finalized = false;
      let closeWatcher = null;
      const finalizeClose = async () => {
        if (finalized) return;
        finalized = true;
        try { closeWatcher?.stop?.(); } catch (_) {}
        try { await autosave.flush(); } catch (_) {}
        try { autosave.stop(); } catch (_) {}
        await saveCookies(context);
        await saveStorageState(context);
        syncProfileExtensionsToShared(userDataDir);
        try { await proxyBridge?.close?.(); } catch (_) {}
        runningBrowsers.delete(profileId);
        const updated = updateProfile(profileId, { status: 'ready', running_on: '' });
        if (updated) {
          profileSync.onLocalProfileUpsert(updated);
          profileSync.scheduleSync();
        }
        console.log(`[Launcher] Profile ${profileId} closed (server mode)`);
      };
      closeWatcher = watchAllPagesClosed(context, () => {
        context.close().catch(() => finalizeClose());
      });
      runningBrowsers.set(profileId, { browserServer, browser, context, page, wsEndpoint, isServer: true, proxyBridge, closeWatcher, autosave, userDataDir });
      updateProfile(profileId, { status: 'running', running_on: os.hostname() });

      context.on('close', finalizeClose);

      console.log(`[Launcher] Profile ${profileId} launched (headless) — wsEndpoint: ${wsEndpoint}`);
      return { success: true, wsEndpoint };
    }

    // ── ELECTRON / GUI MODE ─────────────────────────────────────────────────
    // chromiumSandbox: false — prevents Chrome crash on macOS when closing from Dock
    // (sandbox + Playwright's persistent context causes SIGTERM crash on macOS 13+)
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      ...contextOptions,
      ignoreDefaultArgs: [
        '--enable-automation',
        '--no-sandbox',
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
      ],
    });

    await context.addInitScript(injectionScript);
    const importedStorage = await importStorageState(context);
    if (!importedStorage) {
      await importCookies(context);
    }
    const cleanupStartupBlocker = await installStartupNoiseBlocker(context).catch(() => null);

    // ── WARMUP (first-launch only) ─────────────────────────────────────────
    // If the profile has a warmup config and hasn't been warmed up yet,
    // run the organic browsing session BEFORE opening the start page.
    // This bakes in cookies (NID, CONSENT, _ga, etc.) that massively reduce
    // bot-detection scores on Google, Cloudflare, and friends.
    if (!profile.warmup_completed && profile.warmup_config) {
      let cfg = null;
      try { cfg = JSON.parse(profile.warmup_config); } catch {}
      if (cfg && cfg.enabled) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('warmup:status', { profileId, status: 'started' });
        }
        try {
          await warmup.runWarmup(context, cfg, (progress) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('warmup:progress', { profileId, ...progress });
            }
          });
          // Persist cookies gathered during warmup immediately
          try { await saveCookies(context); } catch {}
          try { await saveStorageState(context); } catch {}
          updateProfile(profileId, { warmup_completed: 1 });
        } catch (e) {
          console.error('[Launcher] Warmup failed:', e.message);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('warmup:status', { profileId, status: 'finished' });
        }
      } else {
        // Config says disabled — still mark as completed so we don't ask again
        updateProfile(profileId, { warmup_completed: 1 });
      }
    }

    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    await navigate(page);
    cleanupStartupBlocker?.();
    const autosave = startStateAutosave(profileId, context);

    let finalized = false;
    let closeWatcher = null;
    const finalizeClose = async () => {
      if (finalized) return;
      finalized = true;
      try { closeWatcher?.stop?.(); } catch (_) {}
      try { await autosave.flush(); } catch (_) {}
      try { autosave.stop(); } catch (_) {}
      // Save cookies defensively — context may already be partially closed
      try { await saveCookies(context); } catch {}
      try { await saveStorageState(context); } catch {}
      syncProfileExtensionsToShared(userDataDir);
      try { await proxyBridge?.close?.(); } catch (_) {}
      runningBrowsers.delete(profileId);
      try {
        const updated = updateProfile(profileId, { status: 'ready', running_on: '' });
        if (updated) {
          profileSync.onLocalProfileUpsert(updated);
          profileSync.scheduleSync();
        }
      } catch {}
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser:status', { profileId, status: 'ready' });
      }
      console.log(`[Launcher] Profile ${profileId} closed`);
    };
    closeWatcher = watchAllPagesClosed(context, () => {
      context.close().catch(() => finalizeClose());
    });
    runningBrowsers.set(profileId, { context, page, proxyBridge, closeWatcher, autosave, userDataDir });
    updateProfile(profileId, { status: 'running', running_on: os.hostname() });

    if (mainWindow) {
      mainWindow.webContents.send('browser:status', { profileId, status: 'running' });
    }

    context.on('close', finalizeClose);

    console.log(`[Launcher] Profile ${profileId} launched successfully`);
    return { success: true };

  } catch (error) {
    try { await proxyBridge?.close?.(); } catch (_) {}
    console.error(`[Launcher] Failed to launch profile ${profileId}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function stopProfile(profileId) {
  const instance = runningBrowsers.get(profileId);
  if (!instance) {
    // Not in the running map — check if the DB has it stuck as 'running' (e.g. after a crash).
    const profile = getProfile(profileId);
    if (profile?.status === 'running') {
      updateProfile(profileId, { status: 'ready', running_on: '' });
      return { success: true };
    }
    return { success: false, error: 'Profile is not running' };
  }

  try {
    try { instance.closeWatcher?.stop?.(); } catch {}
    try {
      await instance.autosave?.flush?.();
      instance.autosave?.stop?.();
    } catch {}
    try {
      const allCookies = await instance.context.cookies();
      if (allCookies.length > 0) {
        updateProfile(profileId, { cookies: JSON.stringify(allCookies) });
        enqueueProfileSync(profileId);
        console.log(`[Launcher] Saved ${allCookies.length} cookies for profile ${profileId}`);
      }
    } catch {}
    try {
      const state = await instance.context.storageState();
      const cookieCount = Array.isArray(state?.cookies) ? state.cookies.length : 0;
      const originCount = Array.isArray(state?.origins) ? state.origins.length : 0;
      if (cookieCount > 0 || originCount > 0) {
        updateProfile(profileId, { storage_state: JSON.stringify(state) });
        enqueueProfileSync(profileId);
        console.log(`[Launcher] Saved storage_state for profile ${profileId}`);
      }
    } catch {}
    await instance.context.close();
    if (instance.browserServer) await instance.browserServer.close().catch(() => {});
    if (instance.userDataDir) {
      syncProfileExtensionsToShared(instance.userDataDir);
    }
    await instance.proxyBridge?.close?.();
    runningBrowsers.delete(profileId);
    const updated = updateProfile(profileId, { status: 'ready', running_on: '' });
    if (updated) {
      profileSync.onLocalProfileUpsert(updated);
      profileSync.scheduleSync();
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function stopAllProfiles() {
  const ids = Array.from(runningBrowsers.keys());
  const failed = [];

  for (const id of ids) {
    try {
      const result = await stopProfile(id);
      if (!result?.success) {
        failed.push({ profileId: id, error: result?.error || 'unknown_error' });
      }
    } catch (error) {
      failed.push({ profileId: id, error: error.message || 'unknown_error' });
    }
  }

  return {
    success: failed.length === 0,
    stopped: ids.length - failed.length,
    failed,
  };
}

function getRunningProfiles() {
  return Array.from(runningBrowsers.keys());
}

function getWsEndpoint(profileId) {
  const instance = runningBrowsers.get(profileId);
  return instance?.wsEndpoint || null;
}

async function getStorageState(profileId) {
  const instance = runningBrowsers.get(profileId);
  if (!instance?.context) return null;
  return instance.context.storageState();
}

module.exports = {
  launchProfile,
  stopProfile,
  stopAllProfiles,
  getRunningProfiles,
  getWsEndpoint,
  getStorageState,
  checkProxy,
  syncProfileLocaleFromProxy,
  deleteProfile,
};
