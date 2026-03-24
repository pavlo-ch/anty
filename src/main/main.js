const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { initDatabase } = require('./database');
const { registerIpcHandlers } = require('./ipc-handlers');
const { registerUpdater } = require('./updater');
const launcher = require('./launcher');

let mainWindow;
let isGracefulQuitInProgress = false;
const appIconPath = path.join(__dirname, '..', 'renderer', 'assets', 'desktop-icon-mac.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hiddenInset',
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

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(appIconPath);
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }

  initDatabase();
  registerIpcHandlers();
  createWindow();

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
