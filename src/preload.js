const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // App
  getAppVersion: () => ipcRenderer.invoke('app:version'),

  // Profiles
  getProfiles: () => ipcRenderer.invoke('profile:list'),
  createProfile: (data) => ipcRenderer.invoke('profile:create', data),
  updateProfile: (id, data) => ipcRenderer.invoke('profile:update', id, data),
  deleteProfile: (id) => ipcRenderer.invoke('profile:delete', id),
  syncProfileLocaleFromProxy: (id) => ipcRenderer.invoke('profile:sync-locale-from-proxy', id),
  runProfileCloudSync: () => ipcRenderer.invoke('profile:sync:run'),
  getProfileCloudSyncStatus: () => ipcRenderer.invoke('profile:sync:status'),
  getProfile: (id) => ipcRenderer.invoke('profile:get', id),

  // Proxies
  getProxies: () => ipcRenderer.invoke('proxy:list'),
  createProxy: (data) => ipcRenderer.invoke('proxy:create', data),
  updateProxy: (id, data) => ipcRenderer.invoke('proxy:update', id, data),
  deleteProxy: (id) => ipcRenderer.invoke('proxy:delete', id),
  checkProxy: (data) => ipcRenderer.invoke('proxy:check', data),

  // Folders
  getFolders: () => ipcRenderer.invoke('folder:list'),
  createFolder: (name) => ipcRenderer.invoke('folder:create', name),

  // Groups
  getGroups: () => ipcRenderer.invoke('group:list'),
  createGroup: (name) => ipcRenderer.invoke('group:create', name),

  // Browser
  launchProfile: (id) => ipcRenderer.invoke('browser:launch', id),
  stopProfile: (id) => ipcRenderer.invoke('browser:stop', id),
  getRunningProfiles: () => ipcRenderer.invoke('browser:running'),

  // Account / platform auth
  getAccountState: () => ipcRenderer.invoke('account:state'),
  getAccountEvents: (limit = 50) => ipcRenderer.invoke('account:events', limit),
  loginAccount: (payload) => ipcRenderer.invoke('account:login', payload),
  logoutAccount: (payload) => ipcRenderer.invoke('account:logout', payload),

  // Window controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  // App updates
  getUpdateConfigStatus: () => ipcRenderer.invoke('app:update:status'),
  startupUpdateCheck: () => ipcRenderer.invoke('app:update:startup-check'),
  checkAppUpdates: () => ipcRenderer.invoke('app:update:check'),
  installDownloadedUpdate: () => ipcRenderer.invoke('app:update:install'),
  downloadMandatoryUpdate: (options) => ipcRenderer.invoke('app:update:download-mandatory', options || {}),
  openUpdateInstaller: () => ipcRenderer.invoke('app:update:open-installer'),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  // Events
  onProfileStatus: (callback) => {
    ipcRenderer.on('browser:status', (_, data) => callback(data));
  },
  onUpdateStatus: (callback) => {
    ipcRenderer.on('app:update-status', (_, data) => callback(data));
  }
});
