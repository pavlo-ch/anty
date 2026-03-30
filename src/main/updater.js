const { app, dialog, ipcMain, safeStorage, shell } = require('electron');
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
let mandatoryDownloadRequested = false;
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
const PLAIN_PREFIX = 'plain:v1:';
const ANTY_SOURCE = 'anty-browser';
const USE_KEYCHAIN = String(process.env.ANTY_USE_KEYCHAIN || '').trim().toLowerCase() === 'true';

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
  if (String(value).startsWith(PLAIN_PREFIX)) {
    try {
      return Buffer.from(String(value).slice(PLAIN_PREFIX.length), 'base64').toString('utf8');
    } catch (_) {
      return '';
    }
  }
  try {
    if (String(value).startsWith(ENCRYPTED_PREFIX)) {
      if (!USE_KEYCHAIN) return '';
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
  const fileUrlMatches = [...rawText.matchAll(/^\s*-\s+url:\s*(.+)$/gm)]
    .map((match) => stripQuotes(match[1]))
    .filter(Boolean);
  const preferredFile = fileUrlMatches.find((url) => url.toLowerCase().endsWith('.dmg'))
    || fileUrlMatches.find((url) => url.toLowerCase().endsWith('.zip'))
    || fileUrlMatches[0]
    || '';

  const version = stripQuotes(versionMatch[1]);
  const filePath = stripQuotes(preferredFile || (pathMatch && pathMatch[1]) || 'Anty-Browser.dmg');
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

function fileNameFromUrl(url, fallback = 'Anty-Browser.dmg') {
  try {
    const parsed = new URL(url);
    const baseName = path.basename(parsed.pathname || '').trim();
    return baseName || fallback;
  } catch (_) {
    return fallback;
  }
}

function getMandatoryDownloadPath(version, downloadUrl) {
  const fileName = fileNameFromUrl(downloadUrl, 'Anty-Browser.dmg');
  const updatesDir = path.join(app.getPath('userData'), 'updates');
  const versionDir = path.join(updatesDir, String(version || 'unknown'));
  return path.join(versionDir, fileName);
}

function isNoSpaceError(err) {
  const code = String(err?.code || '').toUpperCase();
  const message = String(err?.message || '').toLowerCase();
  return code === 'ENOSPC' || message.includes('enospc') || message.includes('no space left on device');
}

function formatNoSpaceMessage() {
  return 'Not enough disk space to download update. Free at least 2 GB and try again.';
}

async function downloadFileWithProgress(downloadUrl, targetPath, onProgress) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.part`;

  const response = await fetch(downloadUrl, { cache: 'no-store' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status})`);
  }

  const total = Number(response.headers.get('content-length') || 0);
  const reader = response.body.getReader();
  const writer = fs.createWriteStream(tmpPath);
  let downloaded = 0;
  let streamError = null;

  writer.on('error', (err) => {
    streamError = err;
  });

  try {
    while (true) {
      if (streamError) throw streamError;
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        downloaded += value.length;
        await new Promise((resolve, reject) => {
          writer.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
        });
        const percent = total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
        onProgress({
          percent: Number(percent.toFixed(2)),
          downloadedBytes: downloaded,
          totalBytes: total
        });
      }
    }

    await new Promise((resolve, reject) => writer.end((err) => (err ? reject(err) : resolve())));
    if (streamError) throw streamError;
    fs.renameSync(tmpPath, targetPath);
    onProgress({
      percent: 100,
      downloadedBytes: downloaded,
      totalBytes: total || downloaded
    });
    return { filePath: targetPath, downloadedBytes: downloaded, totalBytes: total || downloaded };
  } catch (err) {
    try { await reader.cancel(); } catch (_) {}
    writer.destroy();
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    if (isNoSpaceError(err)) {
      const wrapped = new Error(formatNoSpaceMessage());
      wrapped.code = 'ENOSPC';
      throw wrapped;
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
    const downloadUrl = String(mandatoryUpdateInfo?.downloadUrl || '').trim();
    if (!version || !downloadUrl) {
      return { ok: false, reason: 'missing_update_info', message: 'Update metadata is missing.' };
    }

    const targetPath = getMandatoryDownloadPath(version, downloadUrl);
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath);
      if (stats.isFile() && stats.size > 0) {
        updateMandatoryState({
          state: 'mandatory_downloaded',
          version,
          percent: 100,
          downloadedBytes: stats.size,
          totalBytes: stats.size,
          attempts: 1,
          filePath: targetPath,
          message: null,
        });
        logEvent('info', 'mandatory_download_reused', { version, filePath: targetPath, size: stats.size });
        return { ok: true, version, filePath: targetPath, mode: 'direct_download_reuse' };
      }
    }

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        mandatoryDownloadRequested = true;
        updateMandatoryState({
          state: 'mandatory_downloading',
          version,
          percent: 0,
          downloadedBytes: 0,
          totalBytes: 0,
          attempts: attempt,
          filePath: null,
          message: null,
        });

        const result = await downloadFileWithProgress(downloadUrl, targetPath, (progress) => {
          updateMandatoryState({
            state: 'mandatory_downloading',
            version,
            percent: progress.percent,
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
            attempts: attempt,
            filePath: null,
            message: null,
          });
        });

        updateMandatoryState({
          state: 'mandatory_downloaded',
          version,
          percent: 100,
          downloadedBytes: Number(result.downloadedBytes || 0),
          totalBytes: Number(result.totalBytes || result.downloadedBytes || 0),
          attempts: attempt,
          filePath: result.filePath,
          message: null,
        });
        logEvent('info', 'mandatory_download_completed', {
          version,
          attempts: attempt,
          filePath: result.filePath,
        });
        mandatoryDownloadRequested = false;
        return { ok: true, version, filePath: result.filePath, mode: 'direct_download' };
      } catch (err) {
        mandatoryDownloadRequested = false;
        lastError = err;
        const message = isNoSpaceError(err) ? formatNoSpaceMessage() : err.message;
        logEvent('warn', 'mandatory_download_attempt_failed', {
          version,
          attempt,
          maxAttempts,
          message,
        });
        updateMandatoryState({
          state: 'mandatory_download_retry',
          version,
          attempts: attempt,
          filePath: null,
          message: isNoSpaceError(err)
            ? message
            : `Download attempt ${attempt}/${maxAttempts} failed.`,
        });
        if (isNoSpaceError(err)) break;
      }
    }

    const failMessage = isNoSpaceError(lastError)
      ? formatNoSpaceMessage()
      : (lastError?.message || 'Failed to download update.');
    updateMandatoryState({
      state: 'mandatory_download_error',
      version,
      filePath: null,
      message: failMessage,
    });
    logEvent('error', 'mandatory_download_failed', { version, message: failMessage });
    return { ok: false, reason: 'download_failed', message: failMessage };
  })().finally(() => {
    mandatoryDownloadRequested = false;
    mandatoryDownloadPromise = null;
  });

  return mandatoryDownloadPromise;
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
    };

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

    emitStatus({
      state: 'required',
      mandatory: true,
      version: latest.version,
      currentVersion,
      downloadUrl: latest.downloadUrl,
      downloaded: false,
      localFilePath: null,
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

    const isMandatory = Boolean(mandatoryUpdateInfo && isNewerVersion(info?.version || '', app.getVersion()));
    if (isMandatory) {
      if (!mandatoryDownloadRequested) {
        logEvent('info', 'mandatory_update_waiting_for_user_action', { version: info?.version || null });
      }
      return;
    }

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
    if (mandatoryUpdateInfo) {
      updateMandatoryState({
        state: 'mandatory_downloading',
        version: mandatoryUpdateInfo.version,
        percent,
        downloadedBytes: Number(progress?.transferred || 0),
        totalBytes: Number(progress?.total || 0),
        attempts: Number(mandatoryDownloadState.attempts || 1),
        filePath: null,
        message: null,
      });
    }
    emitStatus({ state: 'downloading', percent });
    logEvent('info', 'download_progress', { percent });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    downloadTriggered = false;
    logEvent('info', 'update_downloaded', { version: info?.version });

    const isMandatory = Boolean(mandatoryUpdateInfo && isNewerVersion(info?.version || '', app.getVersion()));
    if (isMandatory) {
      updateMandatoryState({
        state: 'mandatory_downloaded',
        version: info?.version || mandatoryUpdateInfo.version,
        percent: 100,
        downloadedBytes: Number(mandatoryDownloadState.downloadedBytes || 0),
        totalBytes: Number(mandatoryDownloadState.totalBytes || 0),
        attempts: Number(mandatoryDownloadState.attempts || 1),
        filePath: null,
        message: null,
      });
      emitStatus({ state: 'mandatory_downloaded', version: info?.version || mandatoryUpdateInfo.version, mandatory: true });
      return;
    }

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

    // 404 on latest-mac.yml means the macOS release artifacts aren't uploaded yet
    // (e.g. build still in progress). Treat as "already up to date" — don't alarm the user.
    if (message.includes('404') && message.includes('latest-mac.yml')) {
      logEvent('info', 'update_check_skipped_mac_artifacts_not_ready', { message });
      emitStatus({ state: 'latest' });
      return;
    }

    const mandatoryActive = mandatoryDownloadRequested
      || mandatoryDownloadState.state === 'mandatory_downloading'
      || mandatoryDownloadState.state === 'mandatory_download_retry';
    if (mandatoryActive) {
      updateMandatoryState({
        state: 'mandatory_download_error',
        version: mandatoryUpdateInfo?.version || mandatoryDownloadState.version,
        message,
      });
    }
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

    if (mandatoryDownloadState.state !== 'mandatory_downloaded') {
      return { ok: false, reason: 'not_downloaded', message: 'Download the update first.' };
    }

    const localPath = String(mandatoryDownloadState.filePath || '').trim();
    if (!localPath || !fs.existsSync(localPath)) {
      return { ok: false, reason: 'missing_local_installer', message: 'Downloaded installer file is missing. Re-download update.' };
    }

    logEvent('info', 'mandatory_open_installer', { version: mandatoryUpdateInfo.version, filePath: localPath });
    const openError = await shell.openPath(localPath);
    if (openError) {
      logEvent('error', 'mandatory_open_installer_failed', { version: mandatoryUpdateInfo.version, filePath: localPath, message: openError });
      return { ok: false, reason: 'open_installer_failed', message: openError };
    }

    emitStatus({
      state: 'mandatory_installer_opened',
      mandatory: true,
      version: mandatoryUpdateInfo.version,
      localFilePath: localPath
    });

    setTimeout(() => {
      try {
        app.quit();
        setTimeout(() => {
          app.exit(0);
        }, 1200);
      } catch (_) {
        app.exit(0);
      }
    }, 250);

    return { ok: true, action: 'quit_and_install', localFilePath: localPath };
  });

  setTimeout(() => {
    void runStartupUpdateFlow();
  }, 2500);
}

module.exports = { registerUpdater, checkForUpdates };
