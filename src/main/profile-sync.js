const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const db = require('./database');

const ENCRYPTED_PREFIX = 'enc:v1:';
const ANTY_SOURCE = 'anty-browser';
const DEFAULT_PUSH_SEGMENT = 'profiles/push';
const DEFAULT_PULL_SEGMENT = 'profiles/pull';
const CURSOR_SETTING_KEY = 'profiles_sync_cursor';

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
        profilesPushUrl: String(parsed?.profilesPushUrl || '').trim(),
        profilesPullUrl: String(parsed?.profilesPullUrl || '').trim()
      };
      return staticPlatformConfigCache;
    } catch (_) {
      // Ignore invalid config and continue fallback chain.
    }
  }

  staticPlatformConfigCache = { authUrl: '', profilesPushUrl: '', profilesPullUrl: '' };
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

async function pushQueueToCloud(limit = 100) {
  const token = getAccessToken();
  const pushUrl = getProfilesPushUrl();
  const queue = db.listProfileSyncQueue(limit);

  if (!queue.length) {
    return { ok: true, pushed: 0, skipped: false };
  }
  if (!isLoggedIn() || !token) {
    return { ok: false, pushed: 0, skipped: true, reason: 'not_logged_in' };
  }
  if (!pushUrl) {
    return { ok: false, pushed: 0, skipped: true, reason: 'push_url_not_configured' };
  }

  let pushed = 0;
  let failed = 0;
  for (const entry of queue) {
    const payload = parseJsonSafe(entry.payload || '{}');
    try {
      const response = await fetch(pushUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          source: ANTY_SOURCE,
          appVersion: app.getVersion(),
          device: getDeviceInfo(),
          action: entry.action,
          payload
        })
      });

      const body = parseJsonSafe(await response.text());
      if (!response.ok) {
        failed += 1;
        db.markProfileSyncFailed(entry.id, body?.error || `push_failed_${response.status}`);
        continue;
      }

      if (entry.action === 'profile_upsert') {
        const localId = Number(payload?.profile?.localId || payload?.localId || 0);
        const remoteId = extractRemoteId(body);
        if (localId && remoteId) {
          db.updateProfile(localId, {
            remote_id: remoteId,
            team_id: extractTeamId(body) || payload?.profile?.teamId || '',
            cloud_updated_at: extractCloudUpdatedAt(body) || new Date().toISOString()
          });
        }
      }

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
  const token = getAccessToken();
  const pullUrl = getProfilesPullUrl();
  if (!isLoggedIn() || !token) {
    return { ok: false, pulled: 0, skipped: true, reason: 'not_logged_in' };
  }
  if (!pullUrl) {
    return { ok: false, pulled: 0, skipped: true, reason: 'pull_url_not_configured' };
  }

  try {
    const response = await fetch(pullUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source: ANTY_SOURCE,
        appVersion: app.getVersion(),
        device: getDeviceInfo(),
        cursor: getSyncCursor()
      })
    });

    const body = parseJsonSafe(await response.text());
    if (!response.ok) {
      return { ok: false, pulled: 0, reason: body?.error || `pull_failed_${response.status}` };
    }

    const items = extractProfilesList(body);
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
        notes: cloud.data.notes
      });
      db.updateProfile(created.id, cloud.data);
      pulled += 1;
    }

    const cursor = extractCursor(body);
    if (cursor) setSyncCursor(cursor);
    else if (items.length > 0) setSyncCursor(new Date().toISOString());

    return { ok: true, pulled, cursor: getSyncCursor() };
  } catch (err) {
    return { ok: false, pulled: 0, reason: err.message || 'pull_exception' };
  }
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
    lastSyncResult = result;
    return result;
  } finally {
    syncInProgress = false;
  }
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
    pushUrlConfigured: Boolean(getProfilesPushUrl()),
    pullUrlConfigured: Boolean(getProfilesPullUrl()),
    cursor: getSyncCursor(),
    queueSize: db.listProfileSyncQueue(500).length,
    lastSyncResult
  };
}

module.exports = {
  onLocalProfileUpsert,
  onLocalProfileDelete,
  runFullSync,
  scheduleSync,
  getSyncStatus
};
