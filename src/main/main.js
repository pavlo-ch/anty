const { app, BrowserWindow, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const { initDatabase } = require('./database');
const { registerIpcHandlers } = require('./ipc-handlers');
const { registerUpdater } = require('./updater');
const launcher = require('./launcher');
const db = require('./database');
const auth = require('./auth');
const profileSync = require('./profile-sync');
const { isStaleRunningLock } = require('./running-lock');
const { createWebLaunchController, parseLaunchUrl } = require('./web-launch');

let mainWindow;
let isGracefulQuitInProgress = false;
let suppressActivationUntil = 0;
const appIconPath = path.join(__dirname, '..', 'renderer', 'assets', 'desktop-icon-mac.png');

const webLaunch = createWebLaunchController({
  auth, db, launcher, profileSync, isStaleRunningLock,
  getWindow: () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow({ show: false });
    return mainWindow;
  },
  showError(message) {
    focusMainWindow();
    void dialog.showMessageBox(mainWindow, { type: 'info', title: 'Anty Browser', message });
  },
});
function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (process.platform === 'darwin' && app.dock) void app.dock.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
function enqueueWebLaunch(url) {
  if (!parseLaunchUrl(url)) return false;
  // Opening a custom protocol activates its owner on macOS. Keep that activation
  // from surfacing the manager while the requested Chrome profile starts.
  suppressActivationUntil = Date.now() + 15000;
  if (process.platform === 'darwin' && app.dock && app.isReady?.()) app.dock.hide();
  return webLaunch.enqueue(url);
}
function registerProtocolClient() {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('anty', process.execPath, [path.resolve(process.argv[1])]);
  } else if (!process.defaultApp) app.setAsDefaultProtocolClient('anty');
}
// Register before ready: macOS sends the cold-start URL during initialization.
app.on('open-url', (event, url) => {
  event.preventDefault();
  enqueueWebLaunch(url);
});
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
app.on('second-instance', (_event, argv) => {
  const url = argv.find(arg => parseLaunchUrl(arg));
  if (url) enqueueWebLaunch(url);
  else focusMainWindow();
});
const startupUrl = process.argv.find(arg => parseLaunchUrl(arg));
if (startupUrl) enqueueWebLaunch(startupUrl);

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    show,
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

  // Initialize the renderer for IPC/account services even on a hidden launch.
  mainWindow.webContents.once('did-finish-load', () => { void webLaunch.start(); });

  // Window controls via IPC
  ipcMain.removeAllListeners('window:minimize');
  ipcMain.removeAllListeners('window:maximize');
  ipcMain.removeAllListeners('window:close');
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

if (gotSingleInstanceLock) app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(appIconPath);
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
    if (webLaunch.hasPending()) app.dock.hide();
  }

  registerProtocolClient();
  initDatabase();
  registerIpcHandlers();
  createWindow({ show: !webLaunch.hasPending() });

  app.on('activate', () => {
    if (!webLaunch.hasPending() && Date.now() >= suppressActivationUntil) focusMainWindow();
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
