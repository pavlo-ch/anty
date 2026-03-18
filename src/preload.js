const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Profiles
  getProfiles: () => ipcRenderer.invoke('profile:list'),
  createProfile: (data) => ipcRenderer.invoke('profile:create', data),
  updateProfile: (id, data) => ipcRenderer.invoke('profile:update', id, data),
  deleteProfile: (id) => ipcRenderer.invoke('profile:delete', id),
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

  // Window controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  // Events
  onProfileStatus: (callback) => {
    ipcRenderer.on('browser:status', (_, data) => callback(data));
  }
});
