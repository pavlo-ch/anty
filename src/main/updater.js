const { app, dialog, ipcMain, shell, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const db = require('./database');

let mainWindow = null;
let initialized = false;
let checkInProgress = false;
let downloadTriggered = false;
let activeUpdateSource = 'generic';
let activeUpdateUrl = null;
let mandatoryUpdateInfo = null;
let autoOpenedMandatoryVersion = null;
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

async function openInstallerDownload(url, mode = 'manual') {
  if (!url) return { ok: false, reason: 'missing_url' };
  try {
    await shell.openExternal(url);
    logEvent('info', mode === 'auto' ? 'mandatory_download_auto_opened' : 'mandatory_download_opened', { url });
    return { ok: true, url };
  } catch (err) {
    logEvent('error', 'mandatory_download_open_failed', { message: err.message, url });
    return { ok: false, reason: 'open_failed', message: err.message };
  }
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
    return { required: false, reason: 'dev_mode' };
  }

  try {
    const latest = await fetchLatestManifest();
    const currentVersion = app.getVersion();

    if (!isNewerVersion(latest.version, currentVersion)) {
      mandatoryUpdateInfo = null;
      return { required: false, reason: 'latest' };
    }

    mandatoryUpdateInfo = {
      version: latest.version,
      currentVersion,
      downloadUrl: latest.downloadUrl,
      manifestUrl: latest.manifestUrl
    };

    emitStatus({
      state: 'required',
      mandatory: true,
      version: latest.version,
      currentVersion,
      downloadUrl: latest.downloadUrl
    });

    logEvent('warn', 'mandatory_update_required', {
      version: latest.version,
      currentVersion,
      downloadUrl: latest.downloadUrl
    });

    if (autoOpenedMandatoryVersion !== latest.version) {
      autoOpenedMandatoryVersion = latest.version;
      await openInstallerDownload(latest.downloadUrl, 'auto');
    }

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
    mandatoryUpdate: mandatoryUpdateInfo
  }));

  ipcMain.handle('app:update:startup-check', () => runStartupUpdateFlow());
  ipcMain.handle('app:update:check', () => checkForUpdates());

  ipcMain.handle('app:update:install', () => {
    autoUpdater.quitAndInstall();
    return { ok: true };
  });

  ipcMain.handle('app:update:open-installer', async () => {
    const targetUrl = mandatoryUpdateInfo?.downloadUrl
      || toAbsoluteUrl(getUpdateBaseUrl(), 'Anty-Browser.dmg');
    return openInstallerDownload(targetUrl, 'manual');
  });

  setTimeout(() => {
    void runStartupUpdateFlow();
  }, 2500);
}

module.exports = { registerUpdater, checkForUpdates };
