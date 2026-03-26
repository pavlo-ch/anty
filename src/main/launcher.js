const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { buildInjectionScript, getLocaleByCountry, countryCodeToFlag, parseUA } = require('./fingerprint');
const { getProfile, updateProfile, deleteProfile: deleteProfileRow } = require('./database');
const profileSync = require('./profile-sync');
const http = require('http');

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
    const fullVer = `${majorVersion}.0.0.0`;
    return {
      'Sec-CH-UA': secCHUA,
      'Sec-CH-UA-Mobile': isMobile ? '?1' : '?0',
      'Sec-CH-UA-Platform': `"${platform}"`,
      'Sec-CH-UA-Platform-Version': `"${platformVersion}"`,
      'Sec-CH-UA-Arch': '"x86"',
      'Sec-CH-UA-Bitness': '"64"',
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
  if (proxyType !== 'http' && proxyType !== 'https') {
    return {
      success: false,
      error: 'Proxy check for locale supports only HTTP/HTTPS proxies.',
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
    const geoResponse = await requestThroughHttpProxy(
      proxyData,
      'http://ip-api.com/json/?fields=status,message,query,countryCode,timezone,country',
      10000
    );
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

  console.log(`[Launcher] Launching profile ${profileId}: ${profile.name}`);
  console.log(`[Launcher] User data dir: ${userDataDir}`);

  try {
    // Cap viewport to reasonable desktop size (never larger than 1920x1080 for actual window)
    const viewportWidth = Math.min(fingerprint.screen?.width || 1280, 1440);
    const viewportHeight = Math.min(fingerprint.screen?.height || 900, 900);

    // Build launch options
    const launchOptions = {
      headless: false,
      args: [
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
        `--window-size=${viewportWidth},${viewportHeight}`,
      ],
    };

    // Find Chromium executable — try common paths
    const chromiumPaths = [
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
      throw new Error(
        'Google Chrome or Chromium not found.\n' +
        'Install Google Chrome and try again.\n' +
        'Expected paths:\n' + chromiumPaths.join('\n')
      );
    }

    // Context options — use capped viewport for actual window, but spoof full resolution in fingerprint
    const secChHeaders = buildSecChUaHeaders(fingerprint);
    const contextOptions = {
      userAgent: fingerprint.userAgent,
      locale: fingerprint.locale?.language || 'en-US',
      timezoneId: fingerprint.locale?.timezone || 'America/New_York',
      viewport: {
        width: viewportWidth,
        height: viewportHeight,
      },
      screen: {
        width: fingerprint.screen?.width || 1920,
        height: fingerprint.screen?.height || 1080,
      },
      colorScheme: 'no-preference',
      deviceScaleFactor: 1,
      ...(Object.keys(secChHeaders).length > 0 ? { extraHTTPHeaders: secChHeaders } : {}),
    };

    // Add proxy if configured
    if (profile.proxy_host && profile.proxy_host !== '') {
      contextOptions.proxy = {
        server: `${profile.proxy_type || 'http'}://${profile.proxy_host}:${profile.proxy_port || 80}`,
      };
      if (profile.proxy_username) {
        contextOptions.proxy.username = profile.proxy_username;
        contextOptions.proxy.password = profile.proxy_password || '';
      }
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

    // Helper: save cookies from a context
    async function saveCookies(ctx) {
      try {
        const allCookies = await ctx.cookies();
        if (allCookies.length > 0) {
          updateProfile(profileId, { cookies: JSON.stringify(allCookies) });
          console.log(`[Launcher] Saved ${allCookies.length} cookies for profile ${profileId}`);
        }
      } catch (e) {
        console.log(`[Launcher] Could not save cookies: ${e.message}`);
      }
    }

    // Helper: navigate warmup + start page
    async function navigate(page) {
      if (warmupUrl && !warmupUrl.startsWith('chrome://')) {
        await page.goto(warmupUrl).catch(() => {});
        await page.waitForTimeout(2500).catch(() => {});
      }
      if (!startPage.startsWith('chrome://')) {
        await page.goto(startPage).catch(() => {});
      }
    }

    // ── SERVER / HEADLESS MODE ──────────────────────────────────────────────
    if (mainWindow === null || (typeof mainWindow === 'object' && mainWindow && mainWindow.__serverMode)) {
      const browserServer = await chromium.launchServer({
        headless: true,
        executablePath,
        args: [
          `--user-data-dir=${userDataDir}`,
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-infobars',
          '--no-first-run',
          '--no-default-browser-check',
          `--window-size=${viewportWidth},${viewportHeight}`,
        ],
        ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
      });

      const wsEndpoint = browserServer.wsEndpoint();
      const browser = await chromium.connect(wsEndpoint);
      const context = await browser.newContext({ ...contextOptions });

      await context.addInitScript(injectionScript);
      await importCookies(context);

      const page = await context.newPage();
      await navigate(page);

      runningBrowsers.set(profileId, { browserServer, browser, context, page, wsEndpoint, isServer: true });
      updateProfile(profileId, { status: 'running' });

      context.on('close', async () => {
        await saveCookies(context);
        runningBrowsers.delete(profileId);
        updateProfile(profileId, { status: 'ready' });
        console.log(`[Launcher] Profile ${profileId} closed (server mode)`);
      });

      console.log(`[Launcher] Profile ${profileId} launched (headless) — wsEndpoint: ${wsEndpoint}`);
      return { success: true, wsEndpoint };
    }

    // ── ELECTRON / GUI MODE ─────────────────────────────────────────────────
    // chromiumSandbox: false — prevents Chrome crash on macOS when closing from Dock
    // (sandbox + Playwright's persistent context causes SIGTERM crash on macOS 13+)
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      ...contextOptions,
      chromiumSandbox: false,
      ignoreDefaultArgs: ['--enable-automation'],
    });

    await context.addInitScript(injectionScript);
    await importCookies(context);

    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    await navigate(page);

    runningBrowsers.set(profileId, { context, page });
    updateProfile(profileId, { status: 'running' });

    if (mainWindow) {
      mainWindow.webContents.send('browser:status', { profileId, status: 'running' });
    }

    context.on('close', async () => {
      // Save cookies defensively — context may already be partially closed
      try { await saveCookies(context); } catch {}
      runningBrowsers.delete(profileId);
      try { updateProfile(profileId, { status: 'ready' }); } catch {}
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser:status', { profileId, status: 'ready' });
      }
      console.log(`[Launcher] Profile ${profileId} closed`);
    });

    console.log(`[Launcher] Profile ${profileId} launched successfully`);
    return { success: true };

  } catch (error) {
    console.error(`[Launcher] Failed to launch profile ${profileId}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function stopProfile(profileId) {
  const instance = runningBrowsers.get(profileId);
  if (!instance) {
    return { success: false, error: 'Profile is not running' };
  }

  try {
    try {
      const allCookies = await instance.context.cookies();
      if (allCookies.length > 0) {
        updateProfile(profileId, { cookies: JSON.stringify(allCookies) });
        console.log(`[Launcher] Saved ${allCookies.length} cookies for profile ${profileId}`);
      }
    } catch {}
    await instance.context.close();
    if (instance.browserServer) await instance.browserServer.close().catch(() => {});
    runningBrowsers.delete(profileId);
    updateProfile(profileId, { status: 'ready' });
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

module.exports = {
  launchProfile,
  stopProfile,
  stopAllProfiles,
  getRunningProfiles,
  getWsEndpoint,
  checkProxy,
  syncProfileLocaleFromProxy,
  deleteProfile,
};
