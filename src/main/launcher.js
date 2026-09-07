// rebrowser-playwright-core (installed as the "playwright-core" alias) patches the
// CDP `Runtime.enable` leak that Google BotGuard uses to block sign-in with the
// "This browser or app may not be secure" screen. "addBinding" defers Runtime work
// into an isolated world so it is never enabled on the main page context.
// Must be set BEFORE requiring the module. See fingerprint.js for the JS-level stealth.
if (!process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE) {
  process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding';
}
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const extensionsLibrary = require('./extensions');
const { buildInjectionScript, getLocaleByCountry, countryCodeToFlag, parseUA, alignUAToInstalledChrome } = require('./fingerprint');
const { resolveChromeExecutable, candidatePaths } = require('./chrome-binary');
const { resolveEngineExecutable, engineUsesJsInjection, buildEngineFlags } = require('./engine');
const { getProfile, updateProfile, deleteProfile: deleteProfileRow, markProfileLaunched } = require('./database');
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

function detectAccessChallenge(url, title, bodyText) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  const host = parsed.hostname.toLowerCase();
  const pathAndText = `${parsed.pathname} ${title} ${bodyText}`.toLowerCase();

  if (
    host.includes('google.') && (
      parsed.pathname === '/sorry/' ||
      pathAndText.includes('unusual traffic') ||
      pathAndText.includes('not a robot')
    )
  ) return 'Google';

  if (
    pathAndText.includes('just a moment') ||
    pathAndText.includes('verify you are human') ||
    pathAndText.includes('cf-chl-') ||
    pathAndText.includes('challenge-platform')
  ) return 'Cloudflare';

  return null;
}

function installAccessChallengeMonitor(context, profileId, mainWindow) {
  const pages = new Set();
  const reported = new Set();
  let stopped = false;

  const inspect = async (page) => {
    if (stopped || !page || page.isClosed()) return;
    try {
      const url = page.url();
      const title = await page.title().catch(() => '');
      const bodyText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
      const provider = detectAccessChallenge(url, title, bodyText.slice(0, 12000));
      if (!provider) return;
      const key = `${provider}:${url}`;
      if (reported.has(key)) return;
      reported.add(key);
      const event = { profileId, provider, url, manualActionRequired: true };
      console.warn(`[Launcher] ${provider} access challenge detected for profile ${profileId}: ${url}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser:challenge', event);
      }
    } catch (_) {}
  };

  const track = (page) => {
    if (!page || pages.has(page)) return;
    pages.add(page);
    const inspectPage = () => { void inspect(page); };
    page.on('domcontentloaded', inspectPage);
    page.on('load', inspectPage);
    page.__antyChallengeMonitorHandlers = { inspectPage };
    void inspect(page);
  };

  context.pages().forEach(track);
  context.on('page', track);

  return () => {
    stopped = true;
    try { context.off('page', track); } catch (_) {}
    for (const page of pages) {
      const handlers = page.__antyChallengeMonitorHandlers;
      if (!handlers) continue;
      try { page.off('domcontentloaded', handlers.inspectPage); } catch (_) {}
      try { page.off('load', handlers.inspectPage); } catch (_) {}
      try { delete page.__antyChallengeMonitorHandlers; } catch (_) {}
    }
    pages.clear();
  };
}

/**
 * Render the profile's language list the way Chrome does: the primary tag bare,
 * then each fallback with a descending q-weight ("en-US,en;q=0.9,de;q=0.8").
 */
function buildAcceptLanguage(fingerprint) {
  const langs = Array.isArray(fingerprint.locale?.languages) && fingerprint.locale.languages.length
    ? fingerprint.locale.languages
    : [fingerprint.locale?.language || 'en-US'];
  return langs
    .map((lang, i) => (i === 0 ? lang : `${lang};q=${(1 - i * 0.1).toFixed(1)}`))
    .join(',');
}

/**
 * Align a profile's stored fingerprint with the Chrome binary that is about to run.
 *
 * Chrome auto-updates, so a version baked into a fingerprint at creation time goes
 * stale on its own. Whenever it drifts, every request the profile makes carries a
 * JA4/HTTP2 fingerprint from the real build alongside a UA claiming another one —
 * measured to be the same JA4 whether or not anty's config is applied, so the UA is
 * the only side that can move. Re-pins the UA and persists it, so the profile list,
 * the platform sync, and the wire all agree.
 *
 * Returns the (possibly rewritten) fingerprint object.
 */
function alignFingerprintToChrome(profileId, fingerprint) {
  const alignedUA = alignUAToInstalledChrome(fingerprint.userAgent || '');
  if (!alignedUA || alignedUA === fingerprint.userAgent) return fingerprint;

  const previousUA = fingerprint.userAgent;
  fingerprint.userAgent = alignedUA;
  fingerprint.browserVersion = parseUA(alignedUA)?.version || fingerprint.browserVersion;
  console.log(`[Launcher] Re-pinned profile ${profileId} to installed Chrome: ${previousUA} -> ${alignedUA}`);

  try {
    const updated = updateProfile(profileId, {
      fingerprint: JSON.stringify(fingerprint),
      user_agent: alignedUA,
    });
    if (updated?.__changed) enqueueProfileSync(profileId);
  } catch (e) {
    // A failed persist only means we re-align on the next launch — never block it.
    console.error(`[Launcher] Could not persist re-pinned fingerprint: ${e.message}`);
  }
  return fingerprint;
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

// How long a single tab may take to hand back its localStorage before the autosave
// gives up on it for this tick. A tab stuck in a navigation or a heavy script must
// not stall the whole save.
const LIVE_STORAGE_READ_TIMEOUT_MS = 1500;

function pageHttpOrigin(page) {
  try {
    const parsed = new URL(page.url());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch (_) {
    return null;
  }
}

function readPageLocalStorage(page) {
  const read = page.evaluate(() => {
    const entries = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        entries.push({ name, value: localStorage.getItem(name) });
      }
    } catch (_) {}
    return entries;
  });
  read.catch(() => {});
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('localStorage read timed out')), LIVE_STORAGE_READ_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

function parseSavedStorageOrigins(profile) {
  const raw = profile?.storage_state;
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed?.origins) ? parsed.origins : [];
  } catch (_) {
    return [];
  }
}

/**
 * Snapshot the session WITHOUT `context.storageState()`.
 *
 * Playwright's storageState() remembers every origin the context has ever visited
 * and, for each one that has no open tab, opens a blank page, navigates it to that
 * origin, reads its storage and closes it again. Run on a timer that is a tab
 * flashing open and shut in the user's window every tick. So the live snapshot only
 * reads localStorage from tabs that are already open (a plain evaluate — no new
 * page), and keeps whatever was previously saved for origins that are not open
 * right now. The close paths still take a full storageState() once the window is
 * going away, so nothing visited in the session is lost.
 */
async function collectLiveStorageState(profileId, context, cookies) {
  const byOrigin = new Map();
  for (const entry of parseSavedStorageOrigins(getProfile(profileId))) {
    if (entry && typeof entry.origin === 'string') byOrigin.set(entry.origin, entry);
  }

  let openPages = [];
  try {
    openPages = context.pages().filter((page) => !page.isClosed());
  } catch (_) {
    openPages = [];
  }

  const readOrigins = new Set();
  for (const page of openPages) {
    const origin = pageHttpOrigin(page);
    if (!origin || readOrigins.has(origin)) continue;
    try {
      const localStorage = await readPageLocalStorage(page);
      if (!Array.isArray(localStorage)) continue;
      readOrigins.add(origin);
      if (localStorage.length > 0) byOrigin.set(origin, { origin, localStorage });
      else byOrigin.delete(origin);
    } catch (_) {
      // Page is navigating, crashed, or slow — keep the previously saved entry.
    }
  }

  // Stable ordering so an unchanged session serialises identically and does not
  // look "changed" (and re-queue a cloud sync) on every tick.
  const origins = [...byOrigin.values()].sort((a, b) => a.origin.localeCompare(b.origin));
  return { cookies, origins };
}

function startStateAutosave(profileId, context) {
  let stopped = false;
  let saving = false;
  const openTabsTracker = createOpenTabsTracker(profileId, context);

  const flush = async () => {
    if (stopped || saving) return;
    saving = true;
    try {
      await openTabsTracker.flush();

      const allCookies = await context.cookies();
      let changed = false;
      if (allCookies.length > 0) {
        const updated = updateProfile(profileId, { cookies: JSON.stringify(allCookies) });
        changed = Boolean(updated?.__changed) || changed;
      }

      // Never context.storageState() here — see collectLiveStorageState().
      const state = await collectLiveStorageState(profileId, context, allCookies);
      const cookieCount = Array.isArray(state?.cookies) ? state.cookies.length : 0;
      const originCount = Array.isArray(state?.origins) ? state.origins.length : 0;
      if (cookieCount > 0 || originCount > 0) {
        const updated = updateProfile(profileId, { storage_state: JSON.stringify(state) });
        changed = Boolean(updated?.__changed) || changed;
      }

      if (changed) {
        enqueueProfileSync(profileId);
      }
    } catch (_) {
      // Ignore autosave failures while the profile is navigating or closing.
    } finally {
      saving = false;
    }
  };

  // Capture cookies + storage on a timer, not only when the profile is closed cleanly.
  // Before this, a login was written to the profile only in finalizeClose, so a crash,
  // a force-quit, or the machine sleeping/dying lost the whole session — exactly how a
  // freshly-logged-in profile ended up with nothing to sync. Every ~20s the current
  // session is saved and (if it changed) queued for cloud sync, so a login survives.
  const timer = setInterval(() => { void flush(); }, 20000);
  timer.unref?.();

  return {
    flush,
    stop() {
      stopped = true;
      clearInterval(timer);
      openTabsTracker.stop();
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

// The "FB Acc" bookmark is a javascript: bookmarklet, kept in a config asset rather
// than hardcoded here: it is ~25KB of user-owned tooling and can change without a code
// edit. Read once, validated (must be a javascript: URL). Missing/invalid file → the
// bookmark falls back to the old fbacc.io site, so nothing regresses before the asset
// is provided. Searched in both the dev tree and the packaged app (config/**/* ships
// in the asar per package.json "files").
const FB_ACC_LEGACY_URL = 'https://fbacc.io/';

function loadFbAccBookmarklet() {
  const candidates = [];
  try { const { app } = require('electron'); candidates.push(path.join(app.getAppPath(), 'config', 'bookmarks', 'fb-acc.txt')); } catch (_) {}
  candidates.push(path.join(__dirname, '..', '..', 'config', 'bookmarks', 'fb-acc.txt'));
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw.toLowerCase().startsWith('javascript:') && raw.length > 'javascript:'.length) return raw;
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

const FB_ACC_BOOKMARKLET = loadFbAccBookmarklet();

// Bookmarks every profile should start with. Seeded once per profile — deleting one in
// the browser must not bring it back on the next launch.
const DEFAULT_BOOKMARKS = [
  { name: 'Facebook', url: 'https://www.facebook.com/' },
  { name: 'Ads Manager', url: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns' },
  { name: 'Whoer', url: 'https://whoer.net/' },
  { name: 'FB Acc', url: FB_ACC_BOOKMARKLET || FB_ACC_LEGACY_URL },
];

// The marker used to be a bare timestamp, written when only these three existed.
// Profiles carrying one have already been offered exactly this set.
const LEGACY_SEEDED_URLS = [
  'https://www.facebook.com/',
  'https://adsmanager.facebook.com/adsmanager/manage/campaigns',
  'https://whoer.net/',
];

const normalizeBookmarkUrl = (url) => String(url || '').replace(/\/+$/, '');

/** Chrome timestamps are microseconds since 1601-01-01, stored as a string. */
function chromeTimestamp() {
  return String((BigInt(Date.now()) + 11644473600000n) * 1000n);
}

function collectBookmarkUrls(node, into) {
  if (!node || typeof node !== 'object') return into;
  if (node.type === 'url' && node.url) into.add(String(node.url).replace(/\/+$/, ''));
  for (const child of node.children || []) collectBookmarkUrls(child, into);
  return into;
}

/**
 * Rewrite bookmark URLs in place across the tree. `mapping` is keyed by the normalized
 * old URL; each value is the replacement { name, url }. Used to turn a profile's old
 * fbacc.io bookmark into the FB Acc bookmarklet without adding a duplicate. Returns the
 * number of nodes changed.
 */
function migrateBookmarkUrls(node, mapping, now) {
  if (!node || typeof node !== 'object') return 0;
  let changed = 0;
  if (node.type === 'url' && node.url) {
    const replacement = mapping.get(normalizeBookmarkUrl(node.url));
    if (replacement && node.url !== replacement.url) {
      node.url = replacement.url;
      node.name = replacement.name;
      node.date_modified = now;
      changed += 1;
    }
  }
  for (const child of node.children || []) changed += migrateBookmarkUrls(child, mapping, now);
  return changed;
}

function highestBookmarkId(node, current = 0) {
  if (!node || typeof node !== 'object') return current;
  const id = Number(node.id);
  let max = Number.isFinite(id) ? Math.max(current, id) : current;
  for (const child of node.children || []) max = highestBookmarkId(child, max);
  return max;
}

/**
 * The marker records which URLs have already been offered, not just that seeding ran.
 * Adding a bookmark to the list above therefore reaches profiles that were seeded
 * earlier, while one the user deleted in the browser stays deleted.
 */
function readSeededUrls(marker) {
  if (!fs.existsSync(marker)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (Array.isArray(parsed?.seeded)) return new Set(parsed.seeded.map(normalizeBookmarkUrl));
  } catch (_) { /* legacy timestamp marker */ }
  return new Set(LEGACY_SEEDED_URLS.map(normalizeBookmarkUrl));
}

function seedDefaultBookmarks(userDataDir) {
  const marker = path.join(userDataDir, '.anty_default_bookmarks');
  const alreadySeeded = readSeededUrls(marker);
  const isFirstSeed = alreadySeeded === null;
  const seeded = alreadySeeded || new Set();
  if (DEFAULT_BOOKMARKS.every((b) => seeded.has(normalizeBookmarkUrl(b.url)))) return;

  const defaultDir = path.join(userDataDir, 'Default');
  const bookmarksPath = path.join(defaultDir, 'Bookmarks');

  try {
    const now = chromeTimestamp();
    const emptyFolder = (id, name) => ({
      children: [], date_added: now, date_modified: now, date_last_used: '0',
      guid: crypto.randomUUID(), id, name, type: 'folder',
    });

    const existing = readJsonFileSafe(bookmarksPath);
    const data = existing?.roots ? existing : {
      roots: { bookmark_bar: emptyFolder('1', 'Bookmarks bar'), other: emptyFolder('2', 'Other bookmarks'), synced: emptyFolder('3', 'Mobile bookmarks') },
      version: 1,
    };

    const bar = data.roots.bookmark_bar;
    if (!bar) return;
    bar.children = bar.children || [];

    const present = collectBookmarkUrls({ children: Object.values(data.roots) }, new Set());
    let nextId = highestBookmarkId({ children: Object.values(data.roots) }, 3) + 1;

    // Migrate profiles that were seeded with the old fbacc.io site to the FB Acc
    // bookmarklet, rewriting the existing node in place. Doing this before the add loop
    // (and registering the new URL as "present") means the loop won't also append a
    // duplicate FB Acc bookmark.
    let migrated = 0;
    if (FB_ACC_BOOKMARKLET) {
      const mapping = new Map([[normalizeBookmarkUrl(FB_ACC_LEGACY_URL), { name: 'FB Acc', url: FB_ACC_BOOKMARKLET }]]);
      migrated = migrateBookmarkUrls({ children: Object.values(data.roots) }, mapping, now);
      if (migrated > 0) present.add(normalizeBookmarkUrl(FB_ACC_BOOKMARKLET));
    }

    let added = 0;
    for (const bookmark of DEFAULT_BOOKMARKS) {
      const key = normalizeBookmarkUrl(bookmark.url);
      if (seeded.has(key)) continue;
      seeded.add(key);
      if (present.has(key)) continue;
      bar.children.push({
        date_added: now, date_last_used: '0', guid: crypto.randomUUID(),
        id: String(nextId++), name: bookmark.name, type: 'url', url: bookmark.url,
      });
      added += 1;
    }

    if (added > 0 || migrated > 0) {
      bar.date_modified = now;
      // Chrome stores an MD5 of the tree here and rewrites it on load; a stale value
      // would make it treat the file as tampered with, so drop it entirely.
      delete data.checksum;
      fs.mkdirSync(defaultDir, { recursive: true });
      writeJsonFileAtomic(bookmarksPath, data);
      // Chrome prefers Bookmarks.bak when it distrusts the main file; a stale backup
      // would silently undo the seed.
      fs.rmSync(`${bookmarksPath}.bak`, { force: true });
    }

    // Chrome only shows the bar on the new-tab page unless this is set, so the seeded
    // bookmarks would exist but stay invisible on every real page. Written directly
    // rather than through writeJsonFileSafe, which skips files that do not exist yet —
    // and a profile that has never been launched has no Preferences file. Only on the
    // first seed: re-pinning later would override someone who hid the bar on purpose.
    if (isFirstSeed) {
      const prefsPath = path.join(defaultDir, 'Preferences');
      const prefs = readJsonFileSafe(prefsPath) || {};
      prefs.bookmark_bar = { ...(prefs.bookmark_bar || {}), show_on_all_tabs: true };
      fs.mkdirSync(defaultDir, { recursive: true });
      writeJsonFileAtomic(prefsPath, prefs);
    }

    writeJsonFileAtomic(marker, { seeded: [...seeded], updated_at: new Date().toISOString() });
  } catch (err) {
    console.error('[Bookmarks] Could not seed defaults:', err.message);
  }
}

/**
 * Hand the user's own unpacked extensions to a running browser.
 *
 * --load-extension is ignored by current Chrome, and a folder dropped into the profile
 * is rejected for lacking Chrome's MAC signature. The CDP Extensions.loadUnpacked
 * command is the supported route, but it only exists on a browser-level session, so the
 * browser has to expose a debugging port. The load is per-session, hence a fresh call
 * on every launch.
 */
async function loadLibraryExtensions(userDataDir) {
  const paths = extensionsLibrary.getLibraryLoadPaths();
  if (!paths.length) return { loaded: 0 };

  // Chrome writes the port it actually bound to, which is the only reliable value
  // when it was asked for port 0.
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  let port = null;
  for (let attempt = 0; attempt < 40 && !port; attempt += 1) {
    try {
      const line = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (line) port = Number(line);
    } catch (_) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!port) {
    console.error('[Extensions] No DevToolsActivePort; skipped loading', paths.length, 'extension(s)');
    return { loaded: 0 };
  }

  let cdpBrowser = null;
  let loaded = 0;
  try {
    cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const session = await cdpBrowser.newBrowserCDPSession();
    for (const extensionPath of paths) {
      try {
        await session.send('Extensions.loadUnpacked', { path: extensionPath });
        loaded += 1;
      } catch (err) {
        console.error('[Extensions] Could not load', extensionPath, '-', err.message);
      }
    }
  } catch (err) {
    console.error('[Extensions] CDP connection failed:', err.message);
  } finally {
    // Detaches this client; the browser Playwright launched keeps running.
    if (cdpBrowser) { try { await cdpBrowser.close(); } catch (_) {} }
  }
  return { loaded };
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

/* Chrome reads a profile's display name from two files, and it must be in both
   or the browser keeps calling it "Person 1": the per-profile Preferences and
   the info_cache entry in Local State that the profile menu is built from.

   Note this is NOT the OS window title — that stays "<page> — Google Chrome",
   and on macOS the Dock and Cmd-Tab keep showing "Google Chrome" for every
   profile, because that name comes from the .app bundle they all share.
   Faking it with an extension that rewrites document.title was rejected on
   purpose: a page-visible title that no real Chrome would produce is exactly
   the kind of tell this browser exists to avoid. */
function setChromeProfileName(userDataDir, profileName) {
  const name = String(profileName || '').trim();
  if (!name) return;

  // A profile's first launch has no Preferences yet, so these must create the
  // file rather than patch it — writeJsonFileSafe deliberately skips missing ones.
  const patch = (filePath, patcher) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      let parsed = {};
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        parsed = raw ? JSON.parse(raw) : {};
      }
      fs.writeFileSync(filePath, JSON.stringify(patcher(parsed) || parsed));
    } catch (_) {}
  };

  patch(path.join(userDataDir, 'Default', 'Preferences'), (prefs) => {
    prefs.profile = { ...(prefs.profile || {}), name };
    return prefs;
  });

  patch(path.join(userDataDir, 'Local State'), (state) => {
    const profileState = state.profile || {};
    const infoCache = profileState.info_cache || {};
    state.profile = {
      ...profileState,
      info_cache: {
        ...infoCache,
        Default: { ...(infoCache.Default || {}), name, is_using_default_name: false },
      },
    };
    return state;
  });
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

  const ignoreSocketReset = (socket) => {
    socket.on('error', (err) => {
      const code = String(err?.code || '').toUpperCase();
      if (code && code !== 'ECONNRESET' && code !== 'EPIPE') {
        console.warn(`[Launcher] Proxy bridge socket error ignored: ${err.message || code}`);
      }
    });
  };

  server.on('connection', (socket) => {
    sockets.add(socket);
    ignoreSocketReset(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('request', async (req, res) => {
    let parsedUrl = null;
    req.on('error', () => {});
    res.on('error', () => {});
    try {
      parsedUrl = new URL(req.url);
      const targetPort = Number(parsedUrl.port) || 80;
      const upstream = await connectThroughSocks5(proxyData, parsedUrl.hostname, targetPort);
      sockets.add(upstream);
      ignoreSocketReset(upstream);
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
    ignoreSocketReset(clientSocket);
    try {
      const upstream = await connectThroughSocks5(proxyData, targetHost, targetPort);
      sockets.add(upstream);
      ignoreSocketReset(upstream);
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

  const ignoreSocketReset = (socket) => {
    socket.on('error', (err) => {
      const code = String(err?.code || '').toUpperCase();
      if (code && code !== 'ECONNRESET' && code !== 'EPIPE') {
        console.warn(`[Launcher] Proxy bridge socket error ignored: ${err.message || code}`);
      }
    });
  };

  const proxyHost = String(proxyData.host || '').trim();
  const proxyPort = toNumber(proxyData.port, 80);
  const proxyAuthHeaders = buildProxyHeaders(proxyData);

  server.on('connection', (socket) => {
    sockets.add(socket);
    ignoreSocketReset(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('request', (req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
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
    ignoreSocketReset(clientSocket);
    ignoreSocketReset(upstream);
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

  if (manualLoginSessions.has(Number(profileId))) {
    return { success: false, error: 'A manual-login window is open for this profile. Close it first.' };
  }

  const profile = getProfile(profileId);
  if (!profile) {
    return { success: false, error: 'Profile not found' };
  }

  const fingerprint = alignFingerprintToChrome(profileId, JSON.parse(profile.fingerprint || '{}'));
  const userDataDir = getUserDataDir(profileId);
  let proxyBridge = null;
  const startAction = String(fingerprint.startAction || 'open-page');

  console.log(`[Launcher] Launching profile ${profileId}: ${profile.name}`);
  console.log(`[Launcher] User data dir: ${userDataDir}`);

  try {
    ensureSharedExtensionsDir(userDataDir);
    seedDefaultBookmarks(userDataDir);
    disableChromeSessionRestore(userDataDir, startAction);
    setChromeProfileName(userDataDir, profile.name);

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
    // Port 0 lets Chrome pick a free one and record it in DevToolsActivePort. Only
    // requested when the user actually has extensions, so a plain launch is unchanged.
    const hasLibraryExtensions = extensionsLibrary.getLibraryLoadPaths().length > 0;

    const launchOptions = {
      headless: false,
      args: [
        ...(hasLibraryExtensions ? ['--remote-debugging-port=0'] : []),
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-quic',
        '--disable-features=AsyncDns,UseDnsHttpsSvcbAlpn',
        // Stop WebRTC from gathering real-IP ICE candidates (srflx/host) that
        // bypass the HTTP proxy over UDP. Without this, STUN leaks the true
        // public IPv4/IPv6 even when all HTTP traffic goes through the proxy.
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        // Language is set through Chrome's own flags rather than Playwright's
        // `locale` option. Measured difference: the option makes Chrome emit
        // accept-language 6th (right after user-agent), where real Chrome emits it
        // second-to-last, and emits a bare "en-US" with no q-weights while
        // navigator.languages still reported ["en-US","en"] — a header/JS
        // contradiction. The flags reproduce real Chrome on all three counts.
        `--accept-lang=${buildAcceptLanguage(fingerprint)}`,
        `--lang=${fingerprint.locale?.language || 'en-US'}`,
        `--window-size=${viewportWidth},${viewportHeight}`,
      ],
    };
    // Find the executable. resolveEngineExecutable honours the ANTY_ENGINE flag:
    // stock Chrome by default, or a patched Fortress binary when opted in. With the
    // flag off this returns exactly what resolveChromeExecutable() did before.
    const { engine, executablePath } = resolveEngineExecutable();
    if (engine !== 'chrome') {
      // Engine-level spoofing replaces anty's JS injection: push the per-profile
      // persona down as engine switches instead. Solves the Google sign-in block;
      // does NOT get past Cloudflare (that needs the no-CDP window) — see engine.js.
      const engineArgs = buildEngineFlags(engine, fingerprint);
      launchOptions.args.push(...engineArgs);
      console.log(`[Launcher] Engine: ${engine} (${engineArgs.length} flags, JS injection off)`);
    }
    if (executablePath) {
      launchOptions.executablePath = executablePath;
    } else {
      const installHint = process.platform === 'win32'
        ? 'Install Google Chrome from https://www.google.com/chrome and try again.'
        : 'Install Google Chrome and try again.';
      throw new Error(
        `Google Chrome or Chromium not found.\n${installHint}\n` +
        'Expected paths:\n' + candidatePaths().join('\n')
      );
    }

    // Context options — keep GUI viewport dynamic so fullscreen/window resize is real.
    // A fixed viewport pins page height and can clip sticky bottom buttons.
    //
    // Sec-CH-UA headers are deliberately NOT set here. Chrome derives the whole
    // client-hint set from the UA override itself, and — measured against a bare
    // launch — gets it right: the correct three low-entropy hints on a first request,
    // high-entropy ones only after the origin sends Accept-CH, in native header
    // order, with the build's real GREASE brand. Injecting them via extraHTTPHeaders
    // instead appended five headers (including the deprecated Sec-CH-UA-Full-Version)
    // to EVERY request, in a position no real Chrome uses — a deterministic bot tell
    // on exactly the first-contact request that Cloudflare challenges.
    const contextOptions = {
      userAgent: fingerprint.userAgent,
      timezoneId: fingerprint.locale?.timezone || 'America/New_York',
      viewport: null,
      screen: {
        width: fingerprint.screen?.width || 1920,
        height: fingerprint.screen?.height || 1080,
      },
      colorScheme: 'no-preference',
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
    // The permission list replaces the context's whole grant set, so a bare
    // ['geolocation'] left camera/mic denied outright — getUserMedia then fails without
    // ever prompting, which sites report as "we couldn't access your camera".
    contextOptions.permissions = ['camera', 'microphone'];
    if (geo) {
      contextOptions.geolocation = geo;
      contextOptions.permissions.push('geolocation');
    }

    // Under Fortress the persona is enforced in the engine, so the JS injection is
    // skipped — running it would re-add the very prototype-override layer we're moving
    // away from. null here makes both addInitScript sites below no-op.
    const injectionScript = engineUsesJsInjection(engine) ? buildInjectionScript(fingerprint) : null;
    const warmupUrl = profile.warmup_url;
    const startPage = profile.start_page || 'https://whoer.net';
    const savedOpenTabs = startAction === 'new-tab' ? [] : parseSavedOpenTabs(profile);
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
          const updated = updateProfile(profileId, { cookies: JSON.stringify(allCookies) });
          if (updated?.__changed) {
            enqueueProfileSync(profileId);
            console.log(`[Launcher] Saved ${allCookies.length} cookies for profile ${profileId}`);
          }
        }
      } catch (e) {
        console.log(`[Launcher] Could not save cookies: ${e.message}`);
      }
    }

    async function saveStorageState(ctx) {
      try {
        const state = await ctx.storageState();
        if (state && (Array.isArray(state.cookies) || Array.isArray(state.origins))) {
          const updated = updateProfile(profileId, { storage_state: JSON.stringify(state) });
          if (updated?.__changed) {
            enqueueProfileSync(profileId);
            console.log(`[Launcher] Saved storage_state for profile ${profileId}`);
          }
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

    async function restoreSavedTabs(ctx, firstPage) {
      if (savedOpenTabs.length === 0) {
        await navigate(firstPage);
        return firstPage;
      }

      let activePage = firstPage;
      if (!activePage || activePage.isClosed()) activePage = await ctx.newPage();

      // Create the tabs in order first (newPage is cheap), then navigate them all at
      // once with waitUntil:'commit'. Previously each tab was opened one-after-another
      // and awaited to FULL load, so restore time was the sum of every page's load —
      // painfully slow behind a proxy. 'commit' returns as soon as the navigation is
      // accepted; the pages finish loading in the background, exactly like a real
      // browser restoring a session, and they open concurrently so the total wait is
      // the single slowest tab rather than all of them added up.
      const pages = [activePage];
      for (let i = 1; i < savedOpenTabs.length; i += 1) {
        pages.push(await ctx.newPage());
      }
      await Promise.all(
        pages.map((pg, i) => pg.goto(savedOpenTabs[i], { waitUntil: 'commit' }).catch(() => {}))
      );

      return activePage;
    }

    async function openInitialTabs(ctx, firstPage) {
      if (startAction === 'continue-session' && getContextOpenTabUrls(ctx).length > 0) {
        return firstPage;
      }
      return restoreSavedTabs(ctx, firstPage);
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
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
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

      if (injectionScript) await context.addInitScript(injectionScript);
      if (!parsedStorageState) {
        await importCookies(context);
      }

      const cleanupStartupBlocker = await installStartupNoiseBlocker(context).catch(() => null);
      let page = await context.newPage();
      page = await openInitialTabs(context, page);
      cleanupStartupBlocker?.();
      const stopAccessChallengeMonitor = installAccessChallengeMonitor(context, profileId, mainWindow);
      const autosave = startStateAutosave(profileId, context);

      let finalized = false;
      let closeWatcher = null;
      const finalizeClose = async () => {
        if (finalized) return;
        finalized = true;
        try { closeWatcher?.stop?.(); } catch (_) {}
        try { stopAccessChallengeMonitor(); } catch (_) {}
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
      runningBrowsers.set(profileId, { browserServer, browser, context, page, wsEndpoint, isServer: true, proxyBridge, closeWatcher, autosave, userDataDir, stopAccessChallengeMonitor });
      updateProfile(profileId, { status: 'running', running_on: os.hostname() });
      markProfileLaunched(profileId);
      enqueueProfileSync(profileId);

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

    if (hasLibraryExtensions) {
      const { loaded } = await loadLibraryExtensions(userDataDir);
      if (loaded) console.log(`[Extensions] Loaded ${loaded} extension(s) into profile ${profileId}`);
    }

    if (injectionScript) await context.addInitScript(injectionScript);
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
    page = await openInitialTabs(context, page);
    cleanupStartupBlocker?.();
    const stopAccessChallengeMonitor = installAccessChallengeMonitor(context, profileId, mainWindow);
    const autosave = startStateAutosave(profileId, context);

    let finalized = false;
    let closeWatcher = null;
    const finalizeClose = async () => {
      if (finalized) return;
      finalized = true;
      try { closeWatcher?.stop?.(); } catch (_) {}
      try { stopAccessChallengeMonitor(); } catch (_) {}
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
    runningBrowsers.set(profileId, { context, page, proxyBridge, closeWatcher, autosave, userDataDir, stopAccessChallengeMonitor });
    updateProfile(profileId, { status: 'running', running_on: os.hostname() });
    markProfileLaunched(profileId);
    enqueueProfileSync(profileId);

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
    try { instance.stopAccessChallengeMonitor?.(); } catch {}
    try {
      await instance.autosave?.flush?.();
      instance.autosave?.stop?.();
    } catch {}
    try {
      const allCookies = await instance.context.cookies();
      if (allCookies.length > 0) {
        const updated = updateProfile(profileId, { cookies: JSON.stringify(allCookies) });
        if (updated?.__changed) {
          enqueueProfileSync(profileId);
          console.log(`[Launcher] Saved ${allCookies.length} cookies for profile ${profileId}`);
        }
      }
    } catch {}
    try {
      const state = await instance.context.storageState();
      const cookieCount = Array.isArray(state?.cookies) ? state.cookies.length : 0;
      const originCount = Array.isArray(state?.origins) ? state.origins.length : 0;
      if (cookieCount > 0 || originCount > 0) {
        const updated = updateProfile(profileId, { storage_state: JSON.stringify(state) });
        if (updated?.__changed) {
          enqueueProfileSync(profileId);
          console.log(`[Launcher] Saved storage_state for profile ${profileId}`);
        }
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

function normalizeRestorableTabUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch (_) {
    return null;
  }
}

function normalizeRestorableTabUrls(values, limit = 30) {
  if (!Array.isArray(values)) return [];
  const urls = [];
  for (const value of values) {
    const url = normalizeRestorableTabUrl(value);
    if (!url) continue;
    urls.push(url);
    if (urls.length >= limit) break;
  }
  return urls;
}

function parseSavedOpenTabs(profile) {
  try {
    return normalizeRestorableTabUrls(JSON.parse(profile.last_open_tabs || '[]'));
  } catch (_) {
    return [];
  }
}

function getContextOpenTabUrls(context) {
  try {
    return normalizeRestorableTabUrls(
      context.pages()
        .filter((page) => !page.isClosed())
        .map((page) => page.url())
    );
  } catch (_) {
    return [];
  }
}

function createOpenTabsTracker(profileId, context) {
  const trackedPages = new Set();
  const knownPageUrls = new Map();
  let stopped = false;
  let saveTimer = null;
  let lastTabs = getContextOpenTabUrls(context);

  const capturePage = (page) => {
    if (!page || page.isClosed()) return;
    const url = normalizeRestorableTabUrl(page.url());
    if (url) knownPageUrls.set(page, url);
    else knownPageUrls.delete(page);
  };

  const readCurrentTabs = () => {
    let openPages = [];
    try {
      openPages = context.pages().filter((page) => !page.isClosed());
    } catch (_) {
      openPages = [];
    }

    for (const page of openPages) capturePage(page);
    const urls = normalizeRestorableTabUrls(
      openPages.map((page) => knownPageUrls.get(page) || page.url())
    );
    if (urls.length > 0 || openPages.length > 0) lastTabs = urls;
    return { urls, openPages };
  };

  const persist = (urls) => {
    try {
      updateProfile(profileId, { last_open_tabs: JSON.stringify(urls) });
    } catch (_) {}
  };

  const flush = async () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    const { urls, openPages } = readCurrentTabs();
    persist(openPages.length > 0 ? urls : lastTabs);
  };

  // Refresh the in-memory snapshot NOW, then debounce the DB write. The synchronous
  // readCurrentTabs() keeps `lastTabs` current on every tab event, so if the profile
  // window is closed faster than the debounce, finalizeClose's flush still persists the
  // real current set instead of a stale one — that was why a tab opened and closed
  // quickly went missing on the next launch. The debounce only coalesces the writes.
  const snapshot = () => {
    readCurrentTabs();
    scheduleFlush();
  };

  const scheduleFlush = () => {
    if (stopped) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void flush();
    }, 250);
    saveTimer.unref?.();
  };

  const trackPage = (page) => {
    if (!page || trackedPages.has(page)) return;
    trackedPages.add(page);
    // A newly opened tab is captured and snapshotted right away, so it survives an
    // immediate close even before it finishes navigating.
    snapshot();

    const onNavigated = (frame) => {
      if (frame && frame !== page.mainFrame()) return;
      snapshot();
    };
    const onLoaded = () => {
      snapshot();
    };
    const onClose = () => {
      setTimeout(() => {
        if (stopped) return;
        let openPages = [];
        try {
          openPages = context.pages().filter((candidate) => !candidate.isClosed());
        } catch (_) {
          openPages = [];
        }
        if (openPages.length > 0) knownPageUrls.delete(page);
        void flush();
      }, 250).unref?.();
    };

    page.on('framenavigated', onNavigated);
    page.on('domcontentloaded', onLoaded);
    page.on('load', onLoaded);
    page.on('close', onClose);
    page.__antyTabTrackerHandlers = { onNavigated, onLoaded, onClose };
  };

  context.pages().forEach(trackPage);
  context.on('page', trackPage);

  return {
    trackPage,
    flush,
    stop() {
      stopped = true;
      clearTimeout(saveTimer);
      try { context.off('page', trackPage); } catch (_) {}
      for (const page of trackedPages) {
        const handlers = page.__antyTabTrackerHandlers;
        if (!handlers) continue;
        try { page.off('framenavigated', handlers.onNavigated); } catch (_) {}
        try { page.off('domcontentloaded', handlers.onLoaded); } catch (_) {}
        try { page.off('load', handlers.onLoaded); } catch (_) {}
        try { page.off('close', handlers.onClose); } catch (_) {}
        try { delete page.__antyTabTrackerHandlers; } catch (_) {}
      }
      trackedPages.clear();
      knownPageUrls.clear();
    }
  };
}

// Profiles currently open in a no-CDP manual-login window. Keyed by id so a normal
// CDP launch can refuse while one is open (they share a user-data-dir, which Chrome
// locks to a single process).
const manualLoginSessions = new Set();

/**
 * Open a profile in a plain Chrome window with NO CDP attached, for the user to sign
 * in to sites that block automation — Google's "This browser or app may not be
 * secure" being the motivating case.
 *
 * Why this exists: measured live, Google's sign-in rejects the CDP-driven browser at
 * the identifier step (redirects to /signin/rejected) no matter the fingerprint,
 * version, or IP — the trigger is the CDP attachment itself, which JS and launch
 * flags cannot hide. A plain Chrome subprocess on the same profile dir has no CDP, so
 * it reaches the password field like any normal browser. Cookies land in the profile
 * dir, and every later anty launch reuses that session — the block only gates the
 * sign-in action, not the use of an existing session.
 *
 * Deliberately a fully-consistent REAL Chrome during login — no UA/canvas spoofing.
 * The proven-good path (importing a session captured in a real browser) works
 * precisely because the sign-in happens in a coherent browser; layering a Windows UA
 * over a Mac's real WebGL/canvas would reintroduce an inconsistency for no benefit,
 * since the block is about automation, not identity. The one thing that must match is
 * the egress, so the same proxy is applied — Google records the same IP it will later
 * see. Locale is passed for correct language. The resulting session is the trust
 * anchor; the login-vs-use fingerprint gap is the same one the existing cookie/storage
 * import already accepts, and which is known to work.
 *
 * Resolves when the user closes the window; the caller can then launch normally.
 */
async function openProfileForManualLogin(profileId, options = {}) {
  const { spawn } = require('child_process');
  const numericId = Number(profileId);

  if (runningBrowsers.has(numericId)) {
    return { success: false, error: 'Profile is already running. Close it first, then use manual login.' };
  }
  if (manualLoginSessions.has(numericId)) {
    return { success: false, error: 'A login window for this profile is already open.' };
  }

  const profile = getProfile(numericId);
  if (!profile) return { success: false, error: 'Profile not found' };

  const executablePath = resolveChromeExecutable();
  if (!executablePath) return { success: false, error: 'Google Chrome not found' };

  const fingerprint = alignFingerprintToChrome(numericId, JSON.parse(profile.fingerprint || '{}'));
  const userDataDir = getUserDataDir(numericId);
  // Caller-supplied URL wins; otherwise the profile's start page; else Google sign-in.
  // This window is the only way into sites that block CDP outright — not just Google
  // sign-in but Cloudflare-gated sites (e.g. blackhatworld): proven that a CDP launch
  // is re-challenged even when it carries a cf_clearance obtained here, because
  // Cloudflare re-runs its check and detects the automation. Such sites can only be
  // used in this no-CDP window, so it needs to open them, not just the login page.
  const startUrl =
    (options.url && String(options.url).trim()) ||
    (profile.start_page && String(profile.start_page).trim()) ||
    'https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn';

  let proxyBridge = null;
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
  const lang = fingerprint.locale?.language || 'en-US';
  args.push(`--lang=${lang}`, `--accept-lang=${buildAcceptLanguage(fingerprint)}`);

  try {
    ensureSharedExtensionsDir(userDataDir);
    seedDefaultBookmarks(userDataDir);
    disableChromeSessionRestore(userDataDir, 'open-page');
    setChromeProfileName(userDataDir, profile.name);

    if (profile.proxy_host) {
      const proxyType = String(profile.proxy_type || 'http').toLowerCase();
      const isSocks5 = proxyType === 'socks5' || proxyType === 'sock5';
      if (isSocks5) {
        proxyBridge = await createSocks5HttpBridge({
          type: 'socks5', host: profile.proxy_host, port: profile.proxy_port || 1080,
          username: profile.proxy_username || '', password: profile.proxy_password || '',
        });
        args.push(`--proxy-server=${proxyBridge.serverUrl}`);
      } else if (profile.proxy_username) {
        proxyBridge = await createHttpProxyBridge({
          type: proxyType === 'https' ? 'http' : proxyType, host: profile.proxy_host,
          port: profile.proxy_port || 80, username: profile.proxy_username || '', password: profile.proxy_password || '',
        });
        args.push(`--proxy-server=${proxyBridge.serverUrl}`);
      } else {
        const chromeProxyType = proxyType === 'https' ? 'http' : proxyType;
        args.push(`--proxy-server=${chromeProxyType}://${profile.proxy_host}:${profile.proxy_port || 80}`);
      }
      args.push('--proxy-bypass-list=<-loopback>');
    }

    args.push(startUrl);

    manualLoginSessions.add(numericId);
    updateProfile(numericId, { status: 'running', running_on: os.hostname() });
    markProfileLaunched(numericId);
    enqueueProfileSync(numericId);
    console.log(`[Launcher] Manual-login (no CDP) window for profile ${numericId}`);

    const child = spawn(executablePath, args, { detached: false, stdio: 'ignore' });

    await new Promise((resolve) => {
      child.on('exit', resolve);
      child.on('error', (err) => { console.error('[Launcher] Manual-login Chrome error:', err.message); resolve(); });
    });

    return { success: true };
  } catch (err) {
    console.error('[Launcher] Manual-login failed:', err.message);
    return { success: false, error: err.message };
  } finally {
    manualLoginSessions.delete(numericId);
    if (proxyBridge && typeof proxyBridge.close === 'function') {
      try { proxyBridge.close(); } catch (_) {}
    }
    updateProfile(numericId, { status: 'ready', running_on: '' });
  }
}

module.exports = {
  launchProfile,
  openProfileForManualLogin,
  stopProfile,
  stopAllProfiles,
  getRunningProfiles,
  getWsEndpoint,
  getStorageState,
  checkProxy,
  syncProfileLocaleFromProxy,
  deleteProfile,
};
