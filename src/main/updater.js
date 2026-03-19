const { app, dialog, ipcMain, shell, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { once } = require('events');
const db = require('./database');

let mainWindow = null;
let initialized = false;
let checkInProgress = false;
let downloadTriggered = false;
let activeUpdateSource = 'generic';
let activeUpdateUrl = null;
let mandatoryUpdateInfo = null;
let mandatoryDownloadPromise = null;
let mandatoryDownloadState = {
  state: 'idle',
  version: null,
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  attempts: 0,
  filePath: null,
  message: null,
};
const DEFAULT_GITHUB_UPDATE_URL = 'https://github.com/pavlo-ch/anty/releases/latest/download';
const DEFAULT_PLATFORM_LOG_URL = '';
const ENCRYPTED_PREFIX = 'enc:v1:';
const ANTY_SOURCE = 'anty-browser';

function getPlatformLogUrl() {
  return (db.getSetting('platform_log_url') || process.env.ANTY_PLATFORM_LOG_URL || DEFAULT_PLATFORM_LOG_URL || '').trim();
}

function getOrCreateStableDeviceId() {
  const existing = String(db.getSetting('anty_device_id') || '').trim();
  if (existing) return existing;
  const generated = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')).replace(/-/g, '');
  db.setSetting('anty_device_id', generated);
  return generated;
}

function getDeviceInfo() {
  return {
    deviceId: getOrCreateStableDeviceId(),
    deviceName: os.hostname(),
    os: `${os.platform()}-${os.release()}`,
    arch: os.arch()
  };
}

function decryptSecret(value) {
  if (!value) return '';
  try {
    if (String(value).startsWith(ENCRYPTED_PREFIX)) {
      const encoded = String(value).slice(ENCRYPTED_PREFIX.length);
      const buffer = Buffer.from(encoded, 'base64');
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(buffer);
      }
      return buffer.toString('utf8');
    }
  } catch (_) {
    // Ignore decrypt failures and fallback to plain empty token.
  }
  return '';
}

function getAccessTokenForLogs() {
  try {
    const row = db.getDb().prepare('SELECT access_token FROM account_state WHERE id = 1').get();
    return decryptSecret(row?.access_token || '');
  } catch (_) {
    return '';
  }
}

function logToFile(level, event, payload = {}) {
  try {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logLine = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      payload
    });
    fs.appendFileSync(path.join(logsDir, 'updater.log'), `${logLine}\n`);
  } catch (_) {
    // Ignore logging errors to avoid breaking update flow.
  }
}

async function logToPlatform(level, event, payload = {}) {
  const url = getPlatformLogUrl();
  if (!url) return;

  try {
    const token = getAccessTokenForLogs();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: ANTY_SOURCE,
        appVersion: app.getVersion(),
        level,
        category: 'updater',
        event,
        message: `Updater event: ${event}`,
        context: payload,
        device: getDeviceInfo()
      })
    });
    if (!response.ok) {
      logToFile('warn', 'platform_log_failed', { status: response.status, event });
    }
  } catch (err) {
    logToFile('warn', 'platform_log_failed', { message: err.message });
  }
}

function logEvent(level, event, payload = {}) {
  const line = `[Updater] ${event} ${JSON.stringify(payload)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  logToFile(level, event, payload);
  void logToPlatform(level, event, payload);
}

function emitStatus(data) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('app:update-status', data);
}

function stripQuotes(value = '') {
  const trimmed = String(value).trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getUpdateBaseUrl() {
  return (db.getSetting('update_url') || process.env.ANTY_UPDATE_URL || DEFAULT_GITHUB_UPDATE_URL).trim();
}

function toAbsoluteUrl(baseUrl, fileName) {
  const normalizedBase = `${baseUrl.replace(/\/+$/, '')}/`;
  return new URL(fileName, normalizedBase).toString();
}

function parseVersion(version = '') {
  const cleaned = String(version).trim().replace(/^v/i, '').split('-')[0];
  const [major = '0', minor = '0', patch = '0'] = cleaned.split('.');
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor, 10) || 0,
    Number.parseInt(patch, 10) || 0
  ];
}

function isNewerVersion(remoteVersion, localVersion) {
  const [rMaj, rMin, rPatch] = parseVersion(remoteVersion);
  const [lMaj, lMin, lPatch] = parseVersion(localVersion);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPatch > lPatch;
}

function parseLatestMacYml(rawText) {
  const versionMatch = rawText.match(/^version:\s*(.+)$/m);
  if (!versionMatch) return null;

  const pathMatch = rawText.match(/^path:\s*(.+)$/m);
  const fileUrlMatch = rawText.match(/^\s*-\s+url:\s*(.+)$/m);

  const version = stripQuotes(versionMatch[1]);
  const filePath = stripQuotes((fileUrlMatch && fileUrlMatch[1]) || (pathMatch && pathMatch[1]) || 'Anty-Browser.dmg');
  return { version, filePath };
}

async function fetchLatestManifest() {
  const baseUrl = getUpdateBaseUrl();
  const manifestUrl = toAbsoluteUrl(baseUrl, 'latest-mac.yml');
  const response = await fetch(manifestUrl, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch latest-mac.yml (${response.status})`);
  }
  const raw = await response.text();
  const parsed = parseLatestMacYml(raw);
  if (!parsed) throw new Error('Invalid latest-mac.yml format');

  return {
    baseUrl,
    manifestUrl,
    version: parsed.version,
    downloadUrl: toAbsoluteUrl(baseUrl, parsed.filePath)
  };
}

function getMandatoryDownloadDir() {
  return path.join(app.getPath('userData'), 'updates');
}

function getMandatoryDownloadPath(version, downloadUrl) {
  const safeVersion = String(version || 'latest').replace(/[^a-zA-Z0-9._-]/g, '_');
  let ext = '.dmg';
  try {
    const fileName = decodeURIComponent(path.basename(new URL(downloadUrl).pathname || ''));
    if (fileName.toLowerCase().endsWith('.dmg')) ext = '.dmg';
  } catch (_) {
    ext = '.dmg';
  }
  return path.join(getMandatoryDownloadDir(), `Anty-Browser-${safeVersion}${ext}`);
}

function fileExistsAndHasContent(filePath) {
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (_) {
    return false;
  }
}

function updateMandatoryState(patch = {}) {
  mandatoryDownloadState = { ...mandatoryDownloadState, ...patch };
  emitStatus({
    state: mandatoryDownloadState.state,
    mandatory: true,
    version: mandatoryDownloadState.version,
    percent: mandatoryDownloadState.percent,
    downloadedBytes: mandatoryDownloadState.downloadedBytes,
    totalBytes: mandatoryDownloadState.totalBytes,
    attempts: mandatoryDownloadState.attempts,
    filePath: mandatoryDownloadState.filePath,
    message: mandatoryDownloadState.message,
  });
}

async function streamDownloadToFile(url, targetPath, attempt, version) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.part`;
  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  } catch (_) {
    // ignore stale part cleanup errors
  }

  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to download update (${response.status})`);
  }

  const totalBytes = Number.parseInt(response.headers.get('content-length') || '0', 10) || 0;
  let downloadedBytes = 0;
  let lastEmitAt = 0;

  const emitProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < 140) return;
    lastEmitAt = now;
    const percent = totalBytes > 0 ? Number(((downloadedBytes / totalBytes) * 100).toFixed(2)) : 0;
    updateMandatoryState({
      state: 'mandatory_downloading',
      version,
      attempts: attempt,
      percent,
      downloadedBytes,
      totalBytes,
      message: null,
      filePath: null,
    });
  };

  const writable = fs.createWriteStream(tempPath);
  try {
    emitProgress(true);

    if (!response.body) {
      const ab = await response.arrayBuffer();
      const buf = Buffer.from(ab);
      writable.write(buf);
      downloadedBytes = buf.length;
    } else {
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        const chunk = Buffer.from(value);
        downloadedBytes += chunk.length;
        if (!writable.write(chunk)) {
          await once(writable, 'drain');
        }
        emitProgress(false);
      }
    }

    writable.end();
    await once(writable, 'finish');

    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    fs.renameSync(tempPath, targetPath);
    emitProgress(true);
    return {
      ok: true,
      filePath: targetPath,
      downloadedBytes,
      totalBytes,
      percent: 100,
    };
  } catch (err) {
    try {
      writable.destroy();
    } catch (_) {
      // ignore
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {
      // ignore
    }
    throw err;
  }
}

async function downloadMandatoryUpdate(options = {}) {
  if (mandatoryDownloadPromise) return mandatoryDownloadPromise;

  mandatoryDownloadPromise = (async () => {
    const retryCountRaw = Number(options.retryCount);
    const maxAttempts = Number.isFinite(retryCountRaw) && retryCountRaw > 0
      ? Math.min(Math.floor(retryCountRaw), 5)
      : 3;

    if (!mandatoryUpdateInfo) {
      const check = await checkMandatoryUpdate();
      if (!check.required) {
        return { ok: false, reason: 'no_mandatory_update', message: 'No mandatory update available.' };
      }
    }

    const version = mandatoryUpdateInfo?.version;
    const downloadUrl = mandatoryUpdateInfo?.downloadUrl;
    if (!version || !downloadUrl) {
      return { ok: false, reason: 'missing_update_info', message: 'Update metadata is missing.' };
    }

    const targetPath = getMandatoryDownloadPath(version, downloadUrl);
    mandatoryUpdateInfo.localFilePath = targetPath;

    if (fileExistsAndHasContent(targetPath)) {
      updateMandatoryState({
        state: 'mandatory_downloaded',
        version,
        percent: 100,
        filePath: targetPath,
        message: null,
      });
      return { ok: true, version, filePath: targetPath, alreadyDownloaded: true };
    }

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await streamDownloadToFile(downloadUrl, targetPath, attempt, version);
        updateMandatoryState({
          state: 'mandatory_downloaded',
          version,
          percent: 100,
          downloadedBytes: result.downloadedBytes,
          totalBytes: result.totalBytes,
          attempts: attempt,
          filePath: targetPath,
          message: null,
        });
        logEvent('info', 'mandatory_download_completed', {
          version,
          filePath: targetPath,
          attempts: attempt,
        });
        return { ok: true, version, filePath: targetPath };
      } catch (err) {
        lastError = err;
        logEvent('warn', 'mandatory_download_attempt_failed', {
          version,
          attempt,
          maxAttempts,
          message: err.message,
        });
        updateMandatoryState({
          state: 'mandatory_download_retry',
          version,
          attempts: attempt,
          filePath: null,
          message: `Download attempt ${attempt}/${maxAttempts} failed.`,
        });
      }
    }

    const failMessage = lastError?.message || 'Failed to download update.';
    updateMandatoryState({
      state: 'mandatory_download_error',
      version,
      filePath: null,
      message: failMessage,
    });
    logEvent('error', 'mandatory_download_failed', { version, message: failMessage });
    return { ok: false, reason: 'download_failed', message: failMessage };
  })().finally(() => {
    mandatoryDownloadPromise = null;
  });

  return mandatoryDownloadPromise;
}

async function openLocalInstaller(filePath) {
  if (!filePath || !fileExistsAndHasContent(filePath)) {
    return { ok: false, reason: 'missing_file', message: 'Downloaded DMG not found. Download update first.' };
  }

  const errMsg = await shell.openPath(filePath);
  if (errMsg) {
    logEvent('error', 'mandatory_installer_open_failed', { message: errMsg, filePath });
    return { ok: false, reason: 'open_failed', message: errMsg };
  }

  logEvent('info', 'mandatory_installer_opened', { filePath });
  emitStatus({
    state: 'mandatory_installer_opened',
    mandatory: true,
    version: mandatoryUpdateInfo?.version || null,
    filePath,
  });
  return { ok: true, filePath };
}

function configureUpdateSource() {
  const updateUrl = getUpdateBaseUrl();
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: updateUrl
  });
  activeUpdateSource = 'generic';
  activeUpdateUrl = updateUrl;
  logEvent('info', 'using_update_url', { url: updateUrl });
  return true;
}

async function checkMandatoryUpdate() {
  if (!app.isPackaged) {
    mandatoryUpdateInfo = null;
    updateMandatoryState({
      state: 'idle',
      version: null,
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      attempts: 0,
      filePath: null,
      message: null,
    });
    return { required: false, reason: 'dev_mode' };
  }

  try {
    const latest = await fetchLatestManifest();
    const currentVersion = app.getVersion();

    if (!isNewerVersion(latest.version, currentVersion)) {
      mandatoryUpdateInfo = null;
      updateMandatoryState({
        state: 'idle',
        version: null,
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        attempts: 0,
        filePath: null,
        message: null,
      });
      return { required: false, reason: 'latest' };
    }

    mandatoryUpdateInfo = {
      version: latest.version,
      currentVersion,
      downloadUrl: latest.downloadUrl,
      manifestUrl: latest.manifestUrl,
      localFilePath: getMandatoryDownloadPath(latest.version, latest.downloadUrl),
    };

    const localAlready = fileExistsAndHasContent(mandatoryUpdateInfo.localFilePath);
    if (localAlready) {
      updateMandatoryState({
        state: 'mandatory_downloaded',
        version: latest.version,
        percent: 100,
        filePath: mandatoryUpdateInfo.localFilePath,
        message: null,
      });
    } else {
      updateMandatoryState({
        state: 'required',
        version: latest.version,
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        attempts: 0,
        filePath: null,
        message: null,
      });
    }

    emitStatus({
      state: 'required',
      mandatory: true,
      version: latest.version,
      currentVersion,
      downloadUrl: latest.downloadUrl,
      downloaded: localAlready,
      localFilePath: localAlready ? mandatoryUpdateInfo.localFilePath : null,
    });

    logEvent('warn', 'mandatory_update_required', {
      version: latest.version,
      currentVersion,
      downloadUrl: latest.downloadUrl
    });

    return { required: true, ...mandatoryUpdateInfo };
  } catch (err) {
    logEvent('error', 'mandatory_update_check_failed', { message: err.message });
    return { required: false, reason: 'check_failed', message: err.message };
  }
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    logEvent('info', 'check_skipped_dev_mode');
    emitStatus({ state: 'disabled', reason: 'dev_mode' });
    return { ok: false, reason: 'dev_mode' };
  }

  if (checkInProgress) {
    return { ok: false, reason: 'in_progress' };
  }

  if (!configureUpdateSource()) {
    return { ok: false, reason: 'provider_not_configured' };
  }

  checkInProgress = true;
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } finally {
    checkInProgress = false;
  }
}

async function runStartupUpdateFlow() {
  const mandatory = await checkMandatoryUpdate();
  if (mandatory.required) {
    return { ok: true, required: true, version: mandatory.version, currentVersion: mandatory.currentVersion };
  }
  return checkForUpdates();
}

function registerUpdater(window) {
  mainWindow = window;
  if (initialized) return;
  initialized = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    logEvent('info', 'checking_for_update');
    emitStatus({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    logEvent('info', 'update_available', { version: info?.version });
    emitStatus({ state: 'available', version: info?.version || null });

    if (!downloadTriggered) {
      downloadTriggered = true;
      void autoUpdater.downloadUpdate().catch((err) => {
        logEvent('error', 'download_failed', { message: err.message });
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    downloadTriggered = false;
    logEvent('info', 'update_not_available');
    emitStatus({ state: 'latest' });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Number((progress?.percent || 0).toFixed(2));
    emitStatus({ state: 'downloading', percent });
    logEvent('info', 'download_progress', { percent });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    downloadTriggered = false;
    logEvent('info', 'update_downloaded', { version: info?.version });
    emitStatus({ state: 'downloaded', version: info?.version || null });

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Version ${info?.version || 'new'} is downloaded.`,
      detail: 'Restart app to install update.'
    });

    if (response === 0) {
      logEvent('info', 'quit_and_install');
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (err) => {
    downloadTriggered = false;
    const message = err?.message || String(err);
    logEvent('error', 'updater_error', { message });
    emitStatus({ state: 'error', message });
  });

  ipcMain.handle('app:update:status', () => ({
    packaged: app.isPackaged,
    updateUrlConfigured: Boolean(process.env.ANTY_UPDATE_URL),
    platformLogUrlConfigured: Boolean(getPlatformLogUrl()),
    updateSource: activeUpdateSource,
    effectiveUpdateUrl: activeUpdateUrl || DEFAULT_GITHUB_UPDATE_URL,
    mandatoryUpdate: mandatoryUpdateInfo,
    mandatoryDownload: mandatoryDownloadState,
  }));

  ipcMain.handle('app:update:startup-check', () => runStartupUpdateFlow());
  ipcMain.handle('app:update:check', () => checkForUpdates());

  ipcMain.handle('app:update:install', () => {
    autoUpdater.quitAndInstall();
    return { ok: true };
  });

  ipcMain.handle('app:update:download-mandatory', async (_, options) => {
    return downloadMandatoryUpdate(options || {});
  });

  ipcMain.handle('app:update:open-installer', async () => {
    if (!mandatoryUpdateInfo) {
      const check = await checkMandatoryUpdate();
      if (!check.required) {
        return { ok: false, reason: 'no_mandatory_update', message: 'No mandatory update available.' };
      }
    }

    const localFilePath = mandatoryUpdateInfo?.localFilePath;
    if (fileExistsAndHasContent(localFilePath)) {
      return openLocalInstaller(localFilePath);
    }

    return { ok: false, reason: 'not_downloaded', message: 'Download the update first.' };
  });

  setTimeout(() => {
    void runStartupUpdateFlow();
  }, 2500);
}

module.exports = { registerUpdater, checkForUpdates };
