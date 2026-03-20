const { app, ipcMain, BrowserWindow, shell } = require('electron');
const db = require('./database');
const launcher = require('./launcher');
const auth = require('./auth');

function requireLoggedIn() {
  if (!auth.isLoggedIn()) {
    throw new Error('LOGIN_REQUIRED');
  }
}

function registerIpcHandlers() {
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:open-external', async (_, url) => {
    const target = String(url || '').trim();
    if (!target) return { ok: false, reason: 'missing_url' };
    try {
      await shell.openExternal(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'open_failed', message: err.message };
    }
  });
  ipcMain.handle('app:restart', () => {
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  // ---- PROFILES ----
  ipcMain.handle('profile:list', () => {
    requireLoggedIn();
    return db.listProfiles();
  });
  ipcMain.handle('profile:get', (_, id) => {
    requireLoggedIn();
    return db.getProfile(id);
  });
  ipcMain.handle('profile:create', (_, data) => {
    requireLoggedIn();
    return db.createProfile(data || {});
  });
  ipcMain.handle('profile:update', (_, id, data) => {
    requireLoggedIn();
    return db.updateProfile(id, data);
  });
  ipcMain.handle('profile:delete', (_, id) => {
    requireLoggedIn();
    return launcher.deleteProfile(id);
  });
  ipcMain.handle('profile:sync-locale-from-proxy', async (_, id) => {
    requireLoggedIn();
    return launcher.syncProfileLocaleFromProxy(id);
  });

  // ---- PROXIES ----
  ipcMain.handle('proxy:list', () => {
    requireLoggedIn();
    return db.listProxies();
  });
  ipcMain.handle('proxy:create', (_, data) => {
    requireLoggedIn();
    return db.createProxy(data);
  });
  ipcMain.handle('proxy:update', (_, id, data) => {
    requireLoggedIn();
    return db.updateProxy(id, data);
  });
  ipcMain.handle('proxy:delete', (_, id) => {
    requireLoggedIn();
    return db.deleteProxy(id);
  });
  ipcMain.handle('proxy:check', (_, data) => {
    requireLoggedIn();
    return launcher.checkProxy(data);
  });

  // ---- FOLDERS ----
  ipcMain.handle('folder:list', () => {
    requireLoggedIn();
    return db.listFolders();
  });
  ipcMain.handle('folder:create', (_, name) => {
    requireLoggedIn();
    return db.createFolder(name);
  });

  // ---- GROUPS ----
  ipcMain.handle('group:list', () => {
    requireLoggedIn();
    return db.listGroups();
  });
  ipcMain.handle('group:create', (_, name) => {
    requireLoggedIn();
    return db.createGroup(name);
  });

  // ---- BROWSER ----
  ipcMain.handle('browser:launch', (event, id) => {
    requireLoggedIn();
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    return launcher.launchProfile(id, mainWindow);
  });
  ipcMain.handle('browser:stop', (_, id) => {
    requireLoggedIn();
    return launcher.stopProfile(id);
  });
  ipcMain.handle('browser:running', () => {
    requireLoggedIn();
    return launcher.getRunningProfiles();
  });

  // ---- ACCOUNT / PLATFORM ----
  ipcMain.handle('account:state', () => auth.getAccountState());
  ipcMain.handle('account:events', (_, limit) => auth.listAccountEvents(limit));
  ipcMain.handle('account:login', (_, payload) => auth.login(payload || {}));
  ipcMain.handle('account:logout', (_, payload) => auth.logout(payload || {}));
}

module.exports = { registerIpcHandlers };
