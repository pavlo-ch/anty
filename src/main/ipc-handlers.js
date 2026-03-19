const { ipcMain, BrowserWindow } = require('electron');
const db = require('./database');
const launcher = require('./launcher');
const auth = require('./auth');

function registerIpcHandlers() {
  // ---- PROFILES ----
  ipcMain.handle('profile:list', () => db.listProfiles());
  ipcMain.handle('profile:get', (_, id) => db.getProfile(id));
  ipcMain.handle('profile:create', (_, data) => db.createProfile(data || {}));
  ipcMain.handle('profile:update', (_, id, data) => db.updateProfile(id, data));
  ipcMain.handle('profile:delete', (_, id) => db.deleteProfile(id));

  // ---- PROXIES ----
  ipcMain.handle('proxy:list', () => db.listProxies());
  ipcMain.handle('proxy:create', (_, data) => db.createProxy(data));
  ipcMain.handle('proxy:update', (_, id, data) => db.updateProxy(id, data));
  ipcMain.handle('proxy:delete', (_, id) => db.deleteProxy(id));
  ipcMain.handle('proxy:check', (_, data) => launcher.checkProxy(data));

  // ---- FOLDERS ----
  ipcMain.handle('folder:list', () => db.listFolders());
  ipcMain.handle('folder:create', (_, name) => db.createFolder(name));

  // ---- GROUPS ----
  ipcMain.handle('group:list', () => db.listGroups());
  ipcMain.handle('group:create', (_, name) => db.createGroup(name));

  // ---- BROWSER ----
  ipcMain.handle('browser:launch', (event, id) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    return launcher.launchProfile(id, mainWindow);
  });
  ipcMain.handle('browser:stop', (_, id) => launcher.stopProfile(id));
  ipcMain.handle('browser:running', () => launcher.getRunningProfiles());

  // ---- ACCOUNT / PLATFORM ----
  ipcMain.handle('account:state', () => auth.getAccountState());
  ipcMain.handle('account:events', (_, limit) => auth.listAccountEvents(limit));
  ipcMain.handle('account:login', (_, payload) => auth.login(payload || {}));
  ipcMain.handle('account:logout', (_, payload) => auth.logout(payload || {}));
  ipcMain.handle('platform:config:get', () => auth.getPlatformConfig());
  ipcMain.handle('platform:config:set', (_, config) => auth.setPlatformConfig(config || {}));
}

module.exports = { registerIpcHandlers };
