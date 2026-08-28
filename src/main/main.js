const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { initDatabase, getProfileByRemoteId } = require('./database');
const { registerIpcHandlers } = require('./ipc-handlers');
const { registerUpdater } = require('./updater');
const launcher = require('./launcher');

let mainWindow;
let isGracefulQuitInProgress = false;
const appIconPath = path.join(__dirname, '..', 'renderer', 'assets', 'desktop-icon-mac.png');

/**
 * Deep links from the web build: anty://launch/<remoteId>.
 *
 * The web app manages the same cloud profiles but cannot start a browser — that
 * needs a real Chrome process on this machine. So its Launch button hands the
 * profile back to us instead of dead-ending on an error.
 *
 * The id in the link is the platform's remote_id, not our local row id: the web
 * only ever sees cloud ids, and remote_id is what profile-sync maps them to.
 */
const DEEP_LINK_SCHEME = 'anty';

// A link can arrive before the window exists (cold start, or macOS 'open-url'
// firing ahead of 'ready'), so hold it until createWindow has run.
let pendingDeepLink = null;

// Only the first instance may run: on Windows a deep link starts a second copy,
// which must forward the URL to the running app rather than open its own window.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

function findDeepLinkArg(argv) {
  if (!Array.isArray(argv)) return null;
  return argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${DEEP_LINK_SCHEME}://`)) || null;
}

/** anty://launch/<remoteId> — anything else is ignored rather than guessed at. */
function parseDeepLink(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  if (parsed.hostname !== 'launch') return null;

  const remoteId = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).trim();
  return remoteId ? { remoteId } : null;
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function handleDeepLink(url) {
  const link = parseDeepLink(url);
  if (!link) return;

  if (!mainWindow) {
    pendingDeepLink = url;
    return;
  }

  // Bring the app forward first: the user clicked Launch in a browser tab and
  // expects to land here, whether or not the profile turns out to be launchable.
  focusMainWindow();

  // Scoped to the signed-in account, so a link for someone else's profile — or
  // one that has not synced to this machine yet — simply finds nothing.
  const profile = getProfileByRemoteId(link.remoteId);
  if (!profile) {
    console.warn(`[Main] Deep link: no local profile for remote id ${link.remoteId}`);
    return;
  }

  try {
    const result = await launcher.launchProfile(profile.id, mainWindow);
    if (!result?.success) {
      console.warn(`[Main] Deep link launch failed: ${result?.error || 'unknown error'}`);
    }
  } catch (error) {
    console.error('[Main] Deep link launch threw:', error.message);
  }
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

// macOS delivers deep links as an event; it can fire before 'ready'.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Windows and Linux deliver them as argv to a second instance.
app.on('second-instance', (_event, argv) => {
  const url = findDeepLinkArg(argv);
  if (url) handleDeepLink(url);
  else focusMainWindow();
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;

  // Claim anty:// for this build. In development the executable is Electron
  // itself, so the entry script has to be passed along or the OS would relaunch
  // a bare Electron with no app.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }

  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(appIconPath);
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }

  initDatabase();
  registerIpcHandlers();
  createWindow();

  // A cold start from a link: on Windows it is in our own argv, and on macOS
  // 'open-url' may already have parked it in pendingDeepLink.
  const startupLink = pendingDeepLink || findDeepLinkArg(process.argv);
  if (startupLink) {
    pendingDeepLink = null;
    // Let the renderer finish loading so the launch shows up in the UI.
    mainWindow.webContents.once('did-finish-load', () => handleDeepLink(startupLink));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

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
