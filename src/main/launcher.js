const { chromium } = require('playwright-core');
const path = require('path');
const { app } = require('electron');
const { buildInjectionScript } = require('./fingerprint');
const { getProfile, updateProfile } = require('./database');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// Track running browser instances
const runningBrowsers = new Map(); // profileId -> { browser, context, page }

function getUserDataDir(profileId) {
  return path.join(app.getPath('userData'), 'profiles', `profile_${profileId}`);
}

// ===== PROXY CHECK =====
async function checkProxy(proxyData) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ success: false, error: 'Timeout (10s)', ip: null, country: null });
    }, 10000);

    try {
      const proxyUrl = `${proxyData.type || 'http'}://${proxyData.host}:${proxyData.port}`;
      
      // Use a simple HTTP request through proxy to check IP
      const options = {
        hostname: 'api.ipify.org',
        port: 80,
        path: '/?format=json',
        method: 'GET',
        timeout: 8000,
      };

      // For HTTP proxy, connect via proxy
      if (proxyData.type === 'http' || proxyData.type === 'https') {
        options.hostname = proxyData.host;
        options.port = proxyData.port;
        options.path = 'http://api.ipify.org/?format=json';
        if (proxyData.username) {
          const auth = Buffer.from(`${proxyData.username}:${proxyData.password || ''}`).toString('base64');
          options.headers = { 'Proxy-Authorization': `Basic ${auth}` };
        }
      }

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          clearTimeout(timeout);
          try {
            const json = JSON.parse(data);
            resolve({ success: true, ip: json.ip, country: null, latency: Date.now() });
          } catch {
            // Maybe we got the IP as plain text
            const ip = data.trim();
            if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
              resolve({ success: true, ip: ip, country: null });
            } else {
              resolve({ success: true, ip: 'Connected', country: null });
            }
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message, ip: null });
      });

      req.on('timeout', () => {
        clearTimeout(timeout);
        req.destroy();
        resolve({ success: false, error: 'Connection timeout', ip: null });
      });

      req.end();
    } catch (err) {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message, ip: null });
    }
  });
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
        '--disable-blink-features=AutomationControlled',
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
    const fs = require('fs');
    for (const p of chromiumPaths) {
      if (fs.existsSync(p)) {
        executablePath = p;
        break;
      }
    }

    if (executablePath) {
      launchOptions.executablePath = executablePath;
    }

    // Context options — use capped viewport for actual window, but spoof full resolution in fingerprint
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

    // Launch persistent context
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      ...contextOptions,
      // Hide Chrome "controlled by automated test software" banner.
      ignoreDefaultArgs: ['--enable-automation'],
    });

    // Inject fingerprint script
    const injectionScript = buildInjectionScript(fingerprint);
    await context.addInitScript(injectionScript);

    // Import cookies if any
    if (profile.cookies && profile.cookies !== '[]') {
      try {
        const cookies = JSON.parse(profile.cookies);
        if (cookies.length > 0) {
          await context.addCookies(cookies);
        }
      } catch (e) {
        console.error('[Launcher] Failed to import cookies:', e.message);
      }
    }

    // Get existing page or create new
    let page = context.pages()[0];
    if (!page) {
      page = await context.newPage();
    }

    // Navigate to start page
    const startPage = profile.start_page || 'chrome://new-tab-page';
    if (!startPage.startsWith('chrome://')) {
      await page.goto(startPage).catch(() => {});
    }

    // Track running instance
    runningBrowsers.set(profileId, { context, page });

    // Update status
    updateProfile(profileId, { status: 'running' });

    if (mainWindow) {
      mainWindow.webContents.send('browser:status', { profileId, status: 'running' });
    }

    // Handle close
    context.on('close', () => {
      runningBrowsers.delete(profileId);
      updateProfile(profileId, { status: 'ready' });
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
    await instance.context.close();
    runningBrowsers.delete(profileId);
    updateProfile(profileId, { status: 'ready' });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getRunningProfiles() {
  return Array.from(runningBrowsers.keys());
}

module.exports = { launchProfile, stopProfile, getRunningProfiles, checkProxy };
