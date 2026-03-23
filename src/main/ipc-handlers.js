const { app, ipcMain, BrowserWindow, shell } = require('electron');
const db = require('./database');
const launcher = require('./launcher');
const auth = require('./auth');
const profileSync = require('./profile-sync');

function requireLoggedIn() {
  if (!auth.isLoggedIn()) {
    throw new Error('LOGIN_REQUIRED');
  }
}

function toCloudSyncError(prefix, reason, status) {
  const derivedStatus = Number(status) || Number(String(reason || '').match(/_(\d{3})$/)?.[1] || 0);
  const effectiveStatus = derivedStatus || Number(status) || 0;
  if (effectiveStatus === 401 || reason === 'not_logged_in' || reason === 'missing_access_token') {
    return `${prefix}: session expired, login again.`;
  }
  if (effectiveStatus === 404) {
    return `${prefix}: cloud endpoint not found (404). Check profiles URL on platform.`;
  }
  if (effectiveStatus === 403) {
    return `${prefix}: access denied or device limit reached.`;
  }
  if (effectiveStatus === 423) {
    return `${prefix}: account is blocked/inactive.`;
  }
  if (reason === 'profiles_endpoints_not_configured') {
    return `${prefix}: profiles cloud endpoints are not configured.`;
  }
  if (reason) {
    return `${prefix}: ${reason}`;
  }
  return `${prefix}: unknown cloud sync error`;
}

function restoreProfilePatch(snapshot) {
  if (!snapshot) return {};
  return {
    name: snapshot.name,
    folder_id: snapshot.folder_id,
    group_id: snapshot.group_id,
    proxy_id: snapshot.proxy_id,
    remote_id: snapshot.remote_id,
    team_id: snapshot.team_id,
    cloud_updated_at: snapshot.cloud_updated_at,
    status: snapshot.status,
    user_agent: snapshot.user_agent,
    fingerprint: snapshot.fingerprint,
    cookies: snapshot.cookies,
    tags: snapshot.tags,
    notes: snapshot.notes,
    start_page: snapshot.start_page
  };
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
  ipcMain.handle('app:quit', () => {
    app.quit();
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
  ipcMain.handle('profile:create', async (_, data) => {
    requireLoggedIn();

    const cloudRequired = profileSync.isCloudProfilesRequired();
    if (cloudRequired) {
      const ready = await profileSync.ensureCloudReady();
      if (!ready.ok) {
        throw new Error(toCloudSyncError('Cloud sync required', ready.reason, ready?.result?.pull?.status || ready?.result?.push?.status));
      }
    }

    const created = db.createProfile(data || {});
    const synced = await launcher.syncProfileLocaleFromProxy(created.id);
    const finalProfile = synced?.success && synced?.profile ? synced.profile : created;
    if (cloudRequired) {
      const pushed = await profileSync.pushProfileUpsertNow(finalProfile);
      if (!pushed.ok) {
        await launcher.deleteProfile(finalProfile.id, { enqueueCloudDelete: false });
        throw new Error(toCloudSyncError('Create blocked', pushed.reason, pushed.status));
      }
      return db.getProfile(finalProfile.id) || finalProfile;
    }

    profileSync.onLocalProfileUpsert(finalProfile);
    profileSync.scheduleSync();
    return finalProfile;
  });
  ipcMain.handle('profile:update', async (_, id, data) => {
    requireLoggedIn();
    const cloudRequired = profileSync.isCloudProfilesRequired();
    if (cloudRequired) {
      const ready = await profileSync.ensureCloudReady();
      if (!ready.ok) {
        throw new Error(toCloudSyncError('Cloud sync required', ready.reason, ready?.result?.pull?.status || ready?.result?.push?.status));
      }
    }

    const before = db.getProfile(id);
    if (!before) {
      throw new Error('Profile not found');
    }

    const updated = db.updateProfile(id, data);
    if (!updated) {
      throw new Error('Profile not found');
    }
    const hasProxyField = data && Object.prototype.hasOwnProperty.call(data, 'proxy_id');
    const finalProfile = hasProxyField
      ? ((await launcher.syncProfileLocaleFromProxy(id))?.profile || updated)
      : updated;
    if (cloudRequired) {
      const pushed = await profileSync.pushProfileUpsertNow(finalProfile);
      if (!pushed.ok) {
        db.updateProfile(id, restoreProfilePatch(before));
        throw new Error(toCloudSyncError('Save blocked', pushed.reason, pushed.status));
      }
      return db.getProfile(id) || finalProfile;
    }

    profileSync.onLocalProfileUpsert(finalProfile);
    profileSync.scheduleSync();
    return finalProfile;
  });
  ipcMain.handle('profile:delete', async (_, id) => {
    requireLoggedIn();
    const cloudRequired = profileSync.isCloudProfilesRequired();
    if (!cloudRequired) {
      return launcher.deleteProfile(id);
    }

    const ready = await profileSync.ensureCloudReady();
    if (!ready.ok) {
      return { success: false, error: toCloudSyncError('Delete blocked', ready.reason, ready?.result?.pull?.status || ready?.result?.push?.status) };
    }

    const existing = db.getProfile(id);
    if (!existing) {
      return { success: false, error: 'Profile not found' };
    }

    const pushed = await profileSync.pushProfileDeleteNow(existing);
    if (!pushed.ok) {
      return { success: false, error: toCloudSyncError('Delete blocked', pushed.reason, pushed.status) };
    }

    return launcher.deleteProfile(id, { enqueueCloudDelete: false });
  });
  ipcMain.handle('profile:sync-locale-from-proxy', async (_, id) => {
    requireLoggedIn();
    return launcher.syncProfileLocaleFromProxy(id);
  });
  ipcMain.handle('profile:sync:run', async () => {
    requireLoggedIn();
    return profileSync.runFullSync();
  });
  ipcMain.handle('profile:sync:status', () => {
    requireLoggedIn();
    return profileSync.getSyncStatus();
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

  // ---- TAGS ----
  ipcMain.handle('tag:list', () => {
    requireLoggedIn();
    return db.listTags();
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
