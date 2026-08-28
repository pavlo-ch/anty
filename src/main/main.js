const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const db = require('./database');
const { initDatabase } = require('./database');
const { registerIpcHandlers } = require('./ipc-handlers');
const { registerUpdater } = require('./updater');
const launcher = require('./launcher');
const auth = require('./auth');
const profileSync = require('./profile-sync');

let mainWindow;
let isGracefulQuitInProgress = false;
const appIconPath = path.join(__dirname, '..', 'renderer', 'assets', 'desktop-icon-mac.png');

// ── anty:// deep links ──────────────────────────────────────────────────────
// The web build of the app (the platform's /anty-browser page) manages profiles
// but cannot start a browser process, so its Launch button hands the profile
// over to this app through `anty://launch/<remoteId>`. The remote id is the only
// id both sides agree on: the web mirror numbers its own rows locally.
const LAUNCH_PROTOCOL = 'anty';
// A link can arrive before the window exists — macOS delivers 'open-url' during
// a cold start, and Windows passes the URL in argv — so it waits here.
let pendingDeepLink = null;
let appIsReady = false;

function registerProtocolClient() {
  if (process.defaultApp) {
    // `electron .` during development: the OS has to be told which script to
    // run, otherwise it would hand the URL to a bare Electron binary.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(LAUNCH_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
    return;
  }
  app.setAsDefaultProtocolClient(LAUNCH_PROTOCOL);
}

function findDeepLink(argv) {
  return (argv || []).find((arg) => typeof arg === 'string' && arg.startsWith(`${LAUNCH_PROTOCOL}://`)) || null;
}

/** `anty://launch/<remoteId>` (also accepts `anty://launch?id=<remoteId>`). */
function parseLaunchUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${LAUNCH_PROTOCOL}:`) return null;
    if (url.hostname !== 'launch') return null;
    const fromPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    return fromPath || url.searchParams.get('id') || null;
  } catch (_) {
    return null;
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notifyRenderer(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deeplink:launch', payload);
  }
}

async function handleDeepLink(rawUrl) {
  const remoteId = parseLaunchUrl(rawUrl);
  if (!remoteId) return;

  console.log(`[DeepLink] Launch requested for remote profile ${remoteId}`);
  focusMainWindow();

  if (!auth.isLoggedIn()) {
    console.log('[DeepLink] Rejected: not logged in');
    notifyRenderer({ ok: false, reason: 'login_required' });
    return;
  }

  let profile = db.getProfileByRemoteId(remoteId);
  if (!profile) {
    // The profile may have been created on the web moments ago; pull before
    // deciding it does not exist.
    try {
      await profileSync.runFullSync({ fullPull: true });
    } catch (error) {
      console.error('[DeepLink] Sync before launch failed:', error.message);
    }
    profile = db.getProfileByRemoteId(remoteId);
  }

  if (!profile) {
    console.log(`[DeepLink] Rejected: no local profile for remote ${remoteId}`);
    notifyRenderer({ ok: false, reason: 'not_found', remoteId });
    return;
  }

  if (launcher.getRunningProfiles().includes(profile.id)) {
    console.log(`[DeepLink] Profile ${profile.id} is already running here`);
    notifyRenderer({ ok: true, profileId: profile.id, name: profile.name, alreadyRunning: true });
    return;
  }

  if (profile.status === 'running') {
    console.log(`[DeepLink] Profile ${profile.id} is running on another device`);
    notifyRenderer({ ok: false, reason: 'running_elsewhere', profileId: profile.id, name: profile.name });
    return;
  }

  console.log(`[DeepLink] Launching profile ${profile.id} (${profile.name})`);
  const result = await launcher.launchProfile(profile.id, mainWindow);
  if (result.success) {
    // Same as the in-app launch: let the team see the running status right away.
    const updated = db.getProfile(profile.id);
    if (updated) profileSync.onLocalProfileUpsert(updated);
    profileSync.scheduleSync();
  }
  notifyRenderer({
    ok: Boolean(result.success),
    profileId: profile.id,
    name: profile.name,
    error: result.error || '',
  });
}

function consumePendingDeepLink() {
  const url = pendingDeepLink;
  pendingDeepLink = null;
  if (url) void handleDeepLink(url);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    frame: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    backgroundColor: '#0a0a1a',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  registerUpdater(mainWindow);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // A link that arrived before the UI existed is only actionable once the
  // renderer can show the outcome.
  mainWindow.webContents.once('did-finish-load', consumePendingDeepLink);

  // Window controls via IPC
  ipcMain.on('window:minimize', () => mainWindow.minimize());
  ipcMain.on('window:maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.on('window:close', () => mainWindow.close());
}

// macOS delivers deep links as an event, and it can fire before 'ready'.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (!appIsReady) {
    pendingDeepLink = url;
    return;
  }
  void handleDeepLink(url);
});

// Windows and Linux pass the URL as an argument to a second launch, which the
// single-instance lock funnels back into the running app.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    focusMainWindow();
    const url = findDeepLink(argv);
    if (url) void handleDeepLink(url);
  });

  app.whenReady().then(() => {
    appIsReady = true;

    if (process.platform === 'darwin' && app.dock) {
      const dockIcon = nativeImage.createFromPath(appIconPath);
      if (!dockIcon.isEmpty()) {
        app.dock.setIcon(dockIcon);
      }
    }

    registerProtocolClient();
    initDatabase();
    registerIpcHandlers();
    createWindow();

    // Cold start from a link on Windows/Linux.
    const argvLink = findDeepLink(process.argv);
    if (argvLink) pendingDeepLink = argvLink;

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', async (event) => {
  if (isGracefulQuitInProgress) return;
  isGracefulQuitInProgress = true;
  event.preventDefault();

  try {
    await launcher.stopAllProfiles();
  } catch (error) {
    console.error('[Main] Failed to stop running profiles before quit:', error.message);
  }

  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
