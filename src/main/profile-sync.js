const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const db = require('./database');

const ENCRYPTED_PREFIX = 'enc:v1:';
const PLAIN_PREFIX = 'plain:v1:';
const ANTY_SOURCE = 'anty-browser';
const DEFAULT_REFRESH_SEGMENT = 'refresh';
const DEFAULT_PUSH_SEGMENT = 'profiles/push';
const DEFAULT_PULL_SEGMENT = 'profiles/pull';
const CURSOR_SETTING_KEY = 'profiles_sync_cursor';
const CLOUD_BOOTSTRAP_SETTING_KEY = 'profiles_cloud_bootstrapped';
const USE_KEYCHAIN = String(process.env.ANTY_USE_KEYCHAIN || '').trim().toLowerCase() === 'true';

let staticPlatformConfigCache = null;
let syncInProgress = false;
let syncScheduled = null;
let lastSyncResult = { ok: true, skipped: true, reason: 'not_started' };

function loadStaticPlatformConfig() {
  if (staticPlatformConfigCache) return staticPlatformConfigCache;

  const candidatePaths = [
    path.join(app.getAppPath(), 'config', 'platform.json'),
    path.join(process.cwd(), 'config', 'platform.json')
  ];

  for (const filePath of candidatePaths) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      staticPlatformConfigCache = {
        authUrl: String(parsed?.authUrl || '').trim(),
        refreshUrl: String(parsed?.refreshUrl || '').trim(),
        profilesPushUrl: String(parsed?.profilesPushUrl || '').trim(),
        profilesPullUrl: String(parsed?.profilesPullUrl || '').trim(),
        cloudProfilesRequired: parseBoolean(parsed?.cloudProfilesRequired, true)
      };
      return staticPlatformConfigCache;
    } catch (_) {
      // Ignore invalid config and continue fallback chain.
    }
  }

  staticPlatformConfigCache = {
    authUrl: '',
    refreshUrl: '',
    profilesPushUrl: '',
    profilesPullUrl: '',
    cloudProfilesRequired: true
  };
  return staticPlatformConfigCache;
}

function deriveSiblingUrl(baseUrl, targetSegment) {
  if (!baseUrl) return '';
  try {
    const normalized = new URL(baseUrl);
    const segments = normalized.pathname.split('/').filter(Boolean);
    const loginIndex = segments.lastIndexOf('login');
    if (loginIndex >= 0) {
      segments[loginIndex] = targetSegment;
      normalized.pathname = `/${segments.join('/')}`;
      return normalized.toString();
    }
  } catch (_) {
    return '';
  }
  return '';
}

function getAuthUrl() {
  const staticConfig = loadStaticPlatformConfig();
  return (
    db.getSetting('platform_auth_url')
    || process.env.ANTY_PLATFORM_AUTH_URL
    || staticConfig.authUrl
    || ''
  ).trim();
}

function getRefreshUrl() {
  const staticConfig = loadStaticPlatformConfig();
  const configured = (
    db.getSetting('platform_refresh_url')
    || process.env.ANTY_PLATFORM_REFRESH_URL
    || staticConfig.refreshUrl
    || ''
  ).trim();
  if (configured) return configured;
  return deriveSiblingUrl(getAuthUrl(), DEFAULT_REFRESH_SEGMENT);
}

function getProfilesPushUrl() {
  const staticConfig = loadStaticPlatformConfig();
  const configured = (
    db.getSetting('platform_profiles_push_url')
    || process.env.ANTY_PLATFORM_PROFILES_PUSH_URL
    || staticConfig.profilesPushUrl
    || ''
  ).trim();
  if (configured) return configured;
  return deriveSiblingUrl(getAuthUrl(), DEFAULT_PUSH_SEGMENT);
}

function getProfilesPullUrl() {
  const staticConfig = loadStaticPlatformConfig();
  const configured = (
    db.getSetting('platform_profiles_pull_url')
    || process.env.ANTY_PLATFORM_PROFILES_PULL_URL
    || staticConfig.profilesPullUrl
    || ''
  ).trim();
  if (configured) return configured;
  return deriveSiblingUrl(getAuthUrl(), DEFAULT_PULL_SEGMENT);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function isCloudProfilesRequired() {
  const staticConfig = loadStaticPlatformConfig();
  const raw = (
    db.getSetting('platform_profiles_cloud_required')
    || process.env.ANTY_CLOUD_PROFILES_REQUIRED
    || process.env.ANTY_PLATFORM_CLOUD_PROFILES_REQUIRED
    || staticConfig.cloudProfilesRequired
  );
  return parseBoolean(raw, true);
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
    return '';
  }
  return '';
}

function getStateRow() {
  return db.getDb().prepare('SELECT * FROM account_state WHERE id = 1').get();
}

function getAccessToken() {
  const row = getStateRow() || {};
  return decryptSecret(row.access_token || '');
}

function getRefreshToken() {
  const row = getStateRow() || {};
  return decryptSecret(row.refresh_token || '');
}

function encryptSecret(secret) {
  if (!secret) return '';
  if (USE_KEYCHAIN) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return `${ENCRYPTED_PREFIX}${safeStorage.encryptString(secret).toString('base64')}`;
      }
    } catch (_) {}
  }
  return `${PLAIN_PREFIX}${Buffer.from(secret, 'utf8').toString('base64')}`;
}

function saveSessionTokens({ accessToken, refreshToken, expiresAt }) {
  const encryptedAccess = encryptSecret(accessToken || '');
  const encryptedRefresh = encryptSecret(refreshToken || '');
  db.getDb().prepare(`
    UPDATE account_state
    SET
      access_token = ?,
      refresh_token = ?,
      token_expires_at = ?,
      updated_at = datetime('now')
    WHERE id = 1
  `).run(encryptedAccess, encryptedRefresh, String(expiresAt || ''));
}

function normalizeLoginPayload(payload) {
  const root = payload && typeof payload === 'object' ? payload : {};
  const nested = root.data && typeof root.data === 'object' ? root.data : {};
  return {
    accessToken: String(root.access_token || root.accessToken || root.token || nested.access_token || nested.accessToken || nested.token || ''),
    refreshToken: String(root.refresh_token || root.refreshToken || nested.refresh_token || nested.refreshToken || ''),
    tokenExpiresAt: String(root.expires_at || root.expiresAt || nested.expires_at || nested.expiresAt || '')
  };
}

async function refreshAccessToken() {
  const refreshUrl = getRefreshUrl();
  const refreshToken = getRefreshToken();
  if (!refreshUrl) {
    return { ok: false, reason: 'refresh_url_not_configured' };
  }
  if (!refreshToken) {
    return { ok: false, reason: 'missing_refresh_token' };
  }

  try {
    const response = await fetch(refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: refreshToken,
        source: ANTY_SOURCE,
        appVersion: app.getVersion(),
        device: getDeviceInfo()
      })
    });
    const body = parseJsonSafe(await response.text());
    if (!response.ok) {
      return { ok: false, status: response.status, reason: body?.error || `refresh_failed_${response.status}` };
    }

    const normalized = normalizeLoginPayload(body);
    if (!normalized.accessToken) {
      return { ok: false, reason: 'missing_access_token_after_refresh' };
    }

    saveSessionTokens({
      accessToken: normalized.accessToken,
      refreshToken: normalized.refreshToken || refreshToken,
      expiresAt: normalized.tokenExpiresAt
    });
    return { ok: true, accessToken: normalized.accessToken };
  } catch (err) {
    return { ok: false, reason: err.message || 'refresh_exception' };
  }
}

function isLoggedIn() {
  const row = getStateRow() || {};
  return Number(row.is_logged_in || 0) === 1;
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

function parseJsonSafe(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
}

function normalizeTagNames(input) {
  if (!input) return [];
  const source = Array.isArray(input) ? input : String(input).split(',');
  return Array.from(new Set(source
    .map((entry) => {
      if (entry && typeof entry === 'object') return String(entry.name || '').trim();
      return String(entry || '').trim();
    })
    .filter(Boolean)
    .map((name) => name.slice(0, 64))));
}

function normalizeProfileForPayload(profile) {
  if (!profile) return null;
  return {
    localId: profile.id,
    remoteId: profile.remote_id || '',
    teamId: profile.team_id || '',
    name: profile.name || '',
    status: profile.status || 'ready',
    userAgent: profile.user_agent || '',
    fingerprint: parseJsonSafe(profile.fingerprint || '{}'),
    cookies: parseJsonSafe(profile.cookies || '[]'),
    notes: profile.notes || '',
    tags: normalizeTagNames(profile.tags),
    startPage: profile.start_page || 'chrome://new-tab-page',
    createdAt: profile.created_at || '',
    modifiedAt: profile.modified_at || '',
    cloudUpdatedAt: profile.cloud_updated_at || ''
  };
}

function normalizeCloudProfile(item) {
  const root = item && typeof item === 'object' ? item : {};
  return {
    remoteId: String(root.remoteId || root.id || '').trim(),
    teamId: String(root.teamId || '').trim(),
    cloudUpdatedAt: String(root.updatedAt || root.cloudUpdatedAt || '').trim(),
    data: {
      name: String(root.name || 'New Profile'),
      status: String(root.status || 'ready'),
      user_agent: String(root.userAgent || root.user_agent || ''),
      fingerprint: root.fingerprint && typeof root.fingerprint === 'object' ? root.fingerprint : {},
      cookies: Array.isArray(root.cookies) ? root.cookies : [],
      notes: String(root.notes || ''),
      tags: normalizeTagNames(root.tags || root.data?.tags || []),
      start_page: String(root.startPage || root.start_page || 'chrome://new-tab-page'),
      remote_id: String(root.remoteId || root.id || '').trim(),
      team_id: String(root.teamId || '').trim(),
      cloud_updated_at: String(root.updatedAt || root.cloudUpdatedAt || '').trim()
    },
    deleted: Boolean(root.deleted || root.isDeleted)
  };
}

function extractProfilesList(body) {
  if (Array.isArray(body?.profiles)) return body.profiles;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.data?.profiles)) return body.data.profiles;
  if (Array.isArray(body?.data?.items)) return body.data.items;
  return [];
}

function extractCursor(body) {
  return String(body?.cursor || body?.data?.cursor || '').trim();
}

function extractRemoteId(body) {
  return String(
    body?.remoteId
      || body?.profile?.remoteId
      || body?.profile?.id
      || body?.data?.remoteId
      || body?.data?.id
      || ''
  ).trim();
}

function extractTeamId(body) {
  return String(body?.teamId || body?.data?.teamId || '').trim();
}

function extractCloudUpdatedAt(body) {
  return String(body?.updatedAt || body?.data?.updatedAt || '').trim();
}

function setSyncCursor(cursor) {
  if (!cursor) return;
  db.setSetting(CURSOR_SETTING_KEY, cursor);
}

function getSyncCursor() {
  return String(db.getSetting(CURSOR_SETTING_KEY) || '').trim();
}

function onLocalProfileUpsert(profile) {
  const normalized = normalizeProfileForPayload(profile);
  if (!normalized) return null;
  return db.enqueueProfileSync('profile_upsert', { profile: normalized });
}

function onLocalProfileDelete(profile) {
  const normalized = normalizeProfileForPayload(profile);
  if (!normalized) return null;
  return db.enqueueProfileSync('profile_delete', {
    localId: profile.id,
    remoteId: profile.remote_id || '',
    teamId: profile.team_id || '',
    modifiedAt: profile.modified_at || new Date().toISOString(),
    profile: normalized
  });
}

function markCloudBootstrapped(value) {
  db.setSetting(CLOUD_BOOTSTRAP_SETTING_KEY, value ? '1' : '0');
}

function isCloudBootstrapped() {
  return String(db.getSetting(CLOUD_BOOTSTRAP_SETTING_KEY) || '') === '1';
}

async function fetchWithAuthRetry(url, payload) {
  let token = getAccessToken();
  if (!token) {
    return { ok: false, status: 401, body: {}, reason: 'missing_access_token' };
  }

  const send = async (accessToken) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const body = parseJsonSafe(await response.text());
    return { ok: response.ok, status: response.status, body };
  };

  try {
    let result = await send(token);
    if (result.ok || result.status !== 401) return result;

    const refreshed = await refreshAccessToken();
    if (!refreshed.ok) {
      return {
        ok: false,
        status: 401,
        body: result.body || {},
        reason: refreshed.reason || 'refresh_failed'
      };
    }

    token = refreshed.accessToken || getAccessToken();
    if (!token) {
      return { ok: false, status: 401, body: result.body || {}, reason: 'missing_access_token_after_refresh' };
    }
    result = await send(token);
    return result;
  } catch (err) {
    return { ok: false, status: 0, body: {}, reason: err.message || 'request_exception' };
  }
}

async function pushActionToCloud(action, payload) {
  const pushUrl = getProfilesPushUrl();
  if (!isLoggedIn()) {
    return { ok: false, skipped: true, reason: 'not_logged_in' };
  }
  if (!pushUrl) {
    return { ok: false, skipped: true, reason: 'push_url_not_configured' };
  }

  const requestPayload = {
    source: ANTY_SOURCE,
    appVersion: app.getVersion(),
    device: getDeviceInfo(),
    action,
    payload
  };
  const result = await fetchWithAuthRetry(pushUrl, requestPayload);
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      reason: result.body?.error || result.reason || `push_failed_${result.status}`
    };
  }
  return { ok: true, status: result.status, body: result.body };
}

function applyRemoteMetadata(localId, payload, body) {
  const numericLocalId = Number(localId || payload?.profile?.localId || payload?.localId || 0);
  if (!numericLocalId) return;
  const remoteId = extractRemoteId(body);
  if (!remoteId) return;
  db.updateProfile(numericLocalId, {
    remote_id: remoteId,
    team_id: extractTeamId(body) || payload?.profile?.teamId || '',
    cloud_updated_at: extractCloudUpdatedAt(body) || new Date().toISOString()
  });
}

async function pushProfileUpsertNow(profile) {
  const normalized = normalizeProfileForPayload(profile);
  if (!normalized) {
    return { ok: false, reason: 'invalid_profile_payload' };
  }
  const result = await pushActionToCloud('profile_upsert', { profile: normalized });
  if (!result.ok) return result;
  applyRemoteMetadata(normalized.localId, { profile: normalized }, result.body);
  markCloudBootstrapped(true);
  return {
    ok: true,
    remoteId: extractRemoteId(result.body),
    teamId: extractTeamId(result.body),
    cloudUpdatedAt: extractCloudUpdatedAt(result.body)
  };
}

async function pushProfileDeleteNow(profile) {
  const normalized = normalizeProfileForPayload(profile);
  if (!normalized) {
    return { ok: false, reason: 'invalid_profile_payload' };
  }
  const payload = {
    localId: normalized.localId,
    remoteId: normalized.remoteId || '',
    teamId: normalized.teamId || '',
    modifiedAt: normalized.modifiedAt || new Date().toISOString(),
    profile: normalized
  };
  const result = await pushActionToCloud('profile_delete', payload);
  if (result.ok) markCloudBootstrapped(true);
  return result;
}

async function pushQueueToCloud(limit = 100) {
  const queue = db.listProfileSyncQueue(limit);

  if (!queue.length) {
    return { ok: true, pushed: 0, skipped: false };
  }
  if (!isLoggedIn()) {
    return { ok: false, pushed: 0, skipped: true, reason: 'not_logged_in' };
  }
  if (!getProfilesPushUrl()) {
    return { ok: false, pushed: 0, skipped: true, reason: 'push_url_not_configured' };
  }

  let pushed = 0;
  let failed = 0;
  for (const entry of queue) {
    const payload = parseJsonSafe(entry.payload || '{}');
    const result = await pushActionToCloud(entry.action, payload);
    if (!result.ok) {
      failed += 1;
      db.markProfileSyncFailed(entry.id, result.reason || 'push_failed');
      continue;
    }
    if (entry.action === 'profile_upsert') {
      applyRemoteMetadata(payload?.profile?.localId || payload?.localId, payload, result.body || {});
    }
    try {
      db.markProfileSyncDone(entry.id);
      pushed += 1;
    } catch (err) {
      failed += 1;
      db.markProfileSyncFailed(entry.id, err.message || 'push_exception');
    }
  }

  return { ok: failed === 0, pushed, failed };
}

async function pullProfilesFromCloud() {
  const pullUrl = getProfilesPullUrl();
  if (!isLoggedIn()) {
    return { ok: false, pulled: 0, skipped: true, reason: 'not_logged_in' };
  }
  if (!pullUrl) {
    return { ok: false, pulled: 0, skipped: true, reason: 'pull_url_not_configured' };
  }

  const result = await fetchWithAuthRetry(pullUrl, {
    source: ANTY_SOURCE,
    appVersion: app.getVersion(),
    device: getDeviceInfo(),
    cursor: getSyncCursor()
  });
  if (!result.ok) {
    return { ok: false, pulled: 0, reason: result.body?.error || result.reason || `pull_failed_${result.status}` };
  }

  const items = extractProfilesList(result.body);
  let pulled = 0;
  for (const item of items) {
    const cloud = normalizeCloudProfile(item);
    if (!cloud.remoteId) continue;
    const existing = db.getProfileByRemoteId(cloud.remoteId);

    if (cloud.deleted) {
      if (existing) {
        db.deleteProfile(existing.id);
        pulled += 1;
      }
      continue;
    }

    if (existing) {
      db.updateProfile(existing.id, cloud.data);
      pulled += 1;
      continue;
    }

    const created = db.createProfile({
      name: cloud.data.name,
      start_page: cloud.data.start_page,
      notes: cloud.data.notes,
      tags: cloud.data.tags
    });
    db.updateProfile(created.id, cloud.data);
    pulled += 1;
  }

  const cursor = extractCursor(result.body);
  if (cursor) setSyncCursor(cursor);
  else if (items.length > 0) setSyncCursor(new Date().toISOString());

  return { ok: true, pulled, cursor: getSyncCursor() };
}

async function runFullSync(options = {}) {
  if (syncInProgress) {
    return { ok: false, skipped: true, reason: 'sync_in_progress', lastSyncResult };
  }
  syncInProgress = true;
  try {
    const push = await pushQueueToCloud(options.limit || 100);
    const pull = await pullProfilesFromCloud();
    const pushAfterPull = await pushQueueToCloud(options.limit || 100);
    const result = {
      ok: Boolean(push.ok && pull.ok && pushAfterPull.ok),
      push,
      pull,
      pushAfterPull,
      at: new Date().toISOString()
    };
    if (result.ok) {
      markCloudBootstrapped(true);
    } else if (isCloudProfilesRequired()) {
      markCloudBootstrapped(false);
    }
    lastSyncResult = result;
    return result;
  } finally {
    syncInProgress = false;
  }
}

async function ensureCloudReady(options = {}) {
  const required = isCloudProfilesRequired();
  if (!required) {
    return { ok: true, required: false, skipped: true, reason: 'cloud_mode_optional' };
  }
  if (!isLoggedIn()) {
    return { ok: false, required: true, reason: 'not_logged_in' };
  }
  if (!getProfilesPushUrl()) {
    return { ok: false, required: true, reason: 'profiles_endpoints_not_configured' };
  }

  if (options.forceBootstrap) {
    const result = await runFullSync({ limit: options.limit || 100 });
    if (!result.ok) {
      return {
        ok: false,
        required: true,
        reason: result?.pull?.reason || result?.push?.reason || result?.pushAfterPull?.reason || result?.reason || 'cloud_sync_failed',
        result
      };
    }
    return { ok: true, required: true, result };
  }

  return { ok: true, required: true, skipped: true, reason: 'cloud_push_ready' };
}

function scheduleSync(delayMs = 1200) {
  if (syncScheduled) clearTimeout(syncScheduled);
  syncScheduled = setTimeout(() => {
    syncScheduled = null;
    void runFullSync();
  }, Math.max(100, Number(delayMs) || 1200));
}

function getSyncStatus() {
  return {
    inProgress: syncInProgress,
    cloudRequired: isCloudProfilesRequired(),
    cloudBootstrapped: isCloudBootstrapped(),
    pushUrlConfigured: Boolean(getProfilesPushUrl()),
    pullUrlConfigured: Boolean(getProfilesPullUrl()),
    cursor: getSyncCursor(),
    queueSize: db.listProfileSyncQueue(500).length,
    lastSyncResult
  };
}

module.exports = {
  isCloudProfilesRequired,
  ensureCloudReady,
  onLocalProfileUpsert,
  onLocalProfileDelete,
  pushProfileUpsertNow,
  pushProfileDeleteNow,
  runFullSync,
  scheduleSync,
  getSyncStatus
};
