const { app, safeStorage, shell } = require('electron');
const db = require('./database');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_PLATFORM_AUTH_URL = '';
const DEFAULT_PLATFORM_LOG_URL = '';
const ENCRYPTED_PREFIX = 'enc:v1:';
const ANTY_SOURCE = 'anty-browser';
let staticPlatformConfigCache = null;

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
        authStartUrl: String(parsed?.authStartUrl || '').trim(),
        authPollUrl: String(parsed?.authPollUrl || '').trim(),
        refreshUrl: String(parsed?.refreshUrl || '').trim(),
        logoutUrl: String(parsed?.logoutUrl || '').trim(),
        profilesPushUrl: String(parsed?.profilesPushUrl || '').trim(),
        profilesPullUrl: String(parsed?.profilesPullUrl || '').trim(),
        logUrl: String(parsed?.logUrl || '').trim()
      };
      return staticPlatformConfigCache;
    } catch (_) {
      // Ignore invalid config file and continue fallback chain.
    }
  }

  staticPlatformConfigCache = { authUrl: '', authStartUrl: '', authPollUrl: '', refreshUrl: '', logoutUrl: '', profilesPushUrl: '', profilesPullUrl: '', logUrl: '' };
  return staticPlatformConfigCache;
}

function getPlatformAuthUrl() {
  const staticConfig = loadStaticPlatformConfig();
  return (db.getSetting('platform_auth_url') || process.env.ANTY_PLATFORM_AUTH_URL || staticConfig.authUrl || DEFAULT_PLATFORM_AUTH_URL || '').trim();
}

function getPlatformLogUrl() {
  const staticConfig = loadStaticPlatformConfig();
  return (db.getSetting('platform_log_url') || process.env.ANTY_PLATFORM_LOG_URL || staticConfig.logUrl || DEFAULT_PLATFORM_LOG_URL || '').trim();
}

function getPlatformAuthStartUrl() {
  const staticConfig = loadStaticPlatformConfig();
  const configured = (
    db.getSetting('platform_auth_start_url')
    || process.env.ANTY_PLATFORM_AUTH_START_URL
    || staticConfig.authStartUrl
  ).trim();
  if (configured) return configured;
  return deriveSiblingUrl(getPlatformAuthUrl(), 'auth/start');
}

function getPlatformAuthPollUrl() {
  const staticConfig = loadStaticPlatformConfig();
  const configured = (
    db.getSetting('platform_auth_poll_url')
    || process.env.ANTY_PLATFORM_AUTH_POLL_URL
    || staticConfig.authPollUrl
  ).trim();
  if (configured) return configured;
  return deriveSiblingUrl(getPlatformAuthUrl(), 'auth/poll');
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

function getPlatformRefreshUrl() {
  const staticConfig = loadStaticPlatformConfig();
  const configured = (
    db.getSetting('platform_refresh_url')
    || process.env.ANTY_PLATFORM_REFRESH_URL
    || staticConfig.refreshUrl
  ).trim();
  if (configured) return configured;
  return deriveSiblingUrl(getPlatformAuthUrl(), 'refresh');
}

function getPlatformLogoutUrl() {
  const staticConfig = loadStaticPlatformConfig();
  const configured = (
    db.getSetting('platform_logout_url')
    || process.env.ANTY_PLATFORM_LOGOUT_URL
    || staticConfig.logoutUrl
  ).trim();
  if (configured) return configured;
  return deriveSiblingUrl(getPlatformAuthUrl(), 'logout');
}

function getPlatformProfilesPushUrl() {
  const staticConfig = loadStaticPlatformConfig();
  const configured = (
    db.getSetting('platform_profiles_push_url')
    || process.env.ANTY_PLATFORM_PROFILES_PUSH_URL
    || staticConfig.profilesPushUrl
  ).trim();
  if (configured) return configured;
  return deriveSiblingUrl(getPlatformAuthUrl(), 'profiles/push');
}

function getPlatformProfilesPullUrl() {
  const staticConfig = loadStaticPlatformConfig();
  const configured = (
    db.getSetting('platform_profiles_pull_url')
    || process.env.ANTY_PLATFORM_PROFILES_PULL_URL
    || staticConfig.profilesPullUrl
  ).trim();
  if (configured) return configured;
  return deriveSiblingUrl(getPlatformAuthUrl(), 'profiles/pull');
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

function encryptSecret(secret) {
  if (!secret) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `${ENCRYPTED_PREFIX}${safeStorage.encryptString(secret).toString('base64')}`;
    }
  } catch (_) {}
  return `${ENCRYPTED_PREFIX}${Buffer.from(secret, 'utf8').toString('base64')}`;
}

function decryptSecret(value) {
  if (!value) return '';
  if (value.startsWith(ENCRYPTED_PREFIX)) {
    const encoded = value.slice(ENCRYPTED_PREFIX.length);
    try {
      const asBuffer = Buffer.from(encoded, 'base64');
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(asBuffer);
      }
      return asBuffer.toString('utf8');
    } catch (_) {
      return '';
    }
  }

  // Legacy fallback for old versions that stored base64 directly.
  try {
    const looksLikeBase64 = /^[A-Za-z0-9+/=]+$/.test(value) && value.length % 4 === 0;
    if (looksLikeBase64) {
      const asBuffer = Buffer.from(value, 'base64');
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(asBuffer);
      }
      return asBuffer.toString('utf8');
    }
  } catch (_) {
    // Fall through to plaintext fallback.
  }

  return value;
}

function getStateRow() {
  return db.getDb().prepare('SELECT * FROM account_state WHERE id = 1').get();
}

function updateState(fields) {
  const sets = [];
  const values = [];
  const allowedFields = [
    'email',
    'display_name',
    'platform_user_id',
    'access_token',
    'refresh_token',
    'token_expires_at',
    'password_encrypted',
    'remember_me',
    'is_logged_in',
    'last_login_at',
    'last_logout_at'
  ];

  for (const field of allowedFields) {
    if (fields[field] !== undefined) {
      sets.push(`${field} = ?`);
      values.push(fields[field]);
    }
  }

  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  db.getDb().prepare(`UPDATE account_state SET ${sets.join(', ')} WHERE id = 1`).run(...values);
}

function insertAccountEvent(eventType, status, message, meta = {}) {
  const row = getStateRow() || {};
  db.getDb().prepare(`
    INSERT INTO account_events (event_type, status, account_email, account_user_id, message, meta)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    eventType,
    status || 'info',
    row.email || '',
    row.platform_user_id || '',
    message || '',
    JSON.stringify(meta || {})
  );
}

async function sendPlatformLog(eventType, status, message, meta = {}) {
  const url = getPlatformLogUrl();
  if (!url) return;

  try {
    const row = getStateRow() || {};
    const { accessToken, refreshToken } = getDecryptedTokensFromRow(row);
    const device = getDeviceInfo();

    const sendOnce = async (token) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: ANTY_SOURCE,
          appVersion: app.getVersion(),
          level: status || 'info',
          category: 'auth',
          event: eventType,
          message: message || '',
          context: meta || {},
          device
        })
      });
      const body = parseJsonSafe(await response.text());
      return { ok: response.ok, status: response.status, body };
    };

    let result = await sendOnce(accessToken);
    if (!result.ok && result.status === 401 && refreshToken) {
      const refreshed = await refreshSessionWithToken(refreshToken, 'platform_logs_on_401');
      if (refreshed.ok) {
        result = await sendOnce(refreshed.accessToken);
      }
    }

    if (!result.ok && eventType !== 'platform_log_failed') {
      insertAccountEvent('platform_log_failed', 'warn', `Platform logs API failed (${result.status})`, {
        originEvent: eventType,
        status: result.status,
        error: result.body?.error || null
      });
    }
  } catch (err) {
    if (eventType === 'platform_log_failed') return;
    insertAccountEvent('platform_log_failed', 'warn', err.message, { originEvent: eventType });
  }
}

function normalizeLoginPayload(payload, fallbackEmail) {
  const root = payload && typeof payload === 'object' ? payload : {};
  const nested = root.data && typeof root.data === 'object' ? root.data : {};
  const user = root.user || nested.user || root.account || nested.account || {};

  const accessToken = root.access_token || root.accessToken || root.token || nested.access_token || nested.accessToken || nested.token || '';
  const refreshToken = root.refresh_token || root.refreshToken || nested.refresh_token || nested.refreshToken || '';
  const tokenExpiresAt = root.expires_at || root.expiresAt || nested.expires_at || nested.expiresAt || '';

  const email = user.email || nested.email || root.email || fallbackEmail || '';
  const displayName = user.name || user.full_name || user.fullName || user.username || nested.name || nested.full_name || '';
  const userId = user.id || user.user_id || user.userId || nested.user_id || nested.userId || nested.id || '';

  return {
    email: String(email || ''),
    displayName: String(displayName || ''),
    userId: String(userId || ''),
    accessToken: String(accessToken || ''),
    refreshToken: String(refreshToken || ''),
    tokenExpiresAt: String(tokenExpiresAt || '')
  };
}

function parseErrorMessage(status, payload) {
  const payloadMessage = payload && typeof payload === 'object'
    ? (payload.message || payload.error || payload.detail || '')
    : '';
  const withDetails = (base) => (payloadMessage ? `${base} ${payloadMessage}` : base);

  if (status === 401) {
    return withDetails('401: потрібен повторний вхід.');
  }
  if (status === 403) {
    return withDetails('403: нема доступу до Anty Browser або перевищено ліміт девайсів.');
  }
  if (status === 423) {
    return withDetails('423: акаунт заблокований або неактивний.');
  }
  return payloadMessage || `Login failed (${status})`;
}

function parseJsonSafe(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDecryptedTokensFromRow(row) {
  return {
    accessToken: decryptSecret(row?.access_token || ''),
    refreshToken: decryptSecret(row?.refresh_token || '')
  };
}

function saveSessionTokens({ accessToken, refreshToken, expiresAt }) {
  updateState({
    access_token: encryptSecret(accessToken || ''),
    refresh_token: encryptSecret(refreshToken || ''),
    token_expires_at: expiresAt || ''
  });
}

async function refreshSessionWithToken(refreshToken, context = 'refresh') {
  const refreshUrl = getPlatformRefreshUrl();
  if (!refreshUrl) {
    return { ok: false, reason: 'refresh_url_not_configured' };
  }
  if (!refreshToken) {
    return { ok: false, reason: 'missing_refresh_token' };
  }

  const device = getDeviceInfo();
  const response = await fetch(refreshUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: refreshToken,
      source: ANTY_SOURCE,
      appVersion: app.getVersion(),
      device
    })
  });

  const body = parseJsonSafe(await response.text());
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason: body?.error || `refresh_failed_${response.status}`,
      message: parseErrorMessage(response.status, body)
    };
  }

  const normalized = normalizeLoginPayload(body, '');
  if (!normalized.accessToken) {
    return { ok: false, reason: 'missing_access_token_after_refresh' };
  }

  saveSessionTokens({
    accessToken: normalized.accessToken,
    refreshToken: normalized.refreshToken || refreshToken,
    expiresAt: normalized.tokenExpiresAt
  });

  insertAccountEvent('token_refresh_success', 'info', `Token refresh successful (${context})`, {
    context
  });

  return {
    ok: true,
    accessToken: normalized.accessToken,
    refreshToken: normalized.refreshToken || refreshToken,
    expiresAt: normalized.tokenExpiresAt
  };
}

function getAccountState() {
  const row = getStateRow() || {};
  const rememberMe = Number(row.remember_me || 0) === 1;
  const savedPassword = rememberMe ? decryptSecret(row.password_encrypted || '') : '';
  const isLoggedIn = Number(row.is_logged_in || 0) === 1;

  return {
    isLoggedIn,
    email: row.email || '',
    displayName: row.display_name || '',
    platformUserId: row.platform_user_id || '',
    rememberMe,
    hasSavedPassword: Boolean(savedPassword),
    savedPassword,
    lastLoginAt: row.last_login_at || '',
    lastLogoutAt: row.last_logout_at || ''
  };
}

function isLoggedIn() {
  return Boolean(getAccountState().isLoggedIn);
}

function listAccountEvents(limit = 50) {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
  return db.getDb().prepare(`
    SELECT id, event_type, status, account_email, account_user_id, message, meta, created_at
    FROM account_events
    ORDER BY id DESC
    LIMIT ?
  `).all(normalizedLimit);
}

function getPlatformConfig() {
  const authUrl = getPlatformAuthUrl();
  const authStartUrl = getPlatformAuthStartUrl();
  const authPollUrl = getPlatformAuthPollUrl();
  const profilesPushUrl = getPlatformProfilesPushUrl();
  const profilesPullUrl = getPlatformProfilesPullUrl();
  const logUrl = getPlatformLogUrl();
  return {
    authUrl,
    authStartUrl,
    authPollUrl,
    profilesPushUrl,
    profilesPullUrl,
    logUrl,
    authUrlConfigured: Boolean(authUrl),
    authStartUrlConfigured: Boolean(authStartUrl),
    authPollUrlConfigured: Boolean(authPollUrl),
    profilesPushUrlConfigured: Boolean(profilesPushUrl),
    profilesPullUrlConfigured: Boolean(profilesPullUrl),
    logUrlConfigured: Boolean(logUrl)
  };
}

function setPlatformConfig(config = {}) {
  if (config.authUrl !== undefined) {
    db.setSetting('platform_auth_url', String(config.authUrl || '').trim());
  }
  if (config.authStartUrl !== undefined) {
    db.setSetting('platform_auth_start_url', String(config.authStartUrl || '').trim());
  }
  if (config.authPollUrl !== undefined) {
    db.setSetting('platform_auth_poll_url', String(config.authPollUrl || '').trim());
  }
  if (config.logUrl !== undefined) {
    db.setSetting('platform_log_url', String(config.logUrl || '').trim());
  }
  if (config.profilesPushUrl !== undefined) {
    db.setSetting('platform_profiles_push_url', String(config.profilesPushUrl || '').trim());
  }
  if (config.profilesPullUrl !== undefined) {
    db.setSetting('platform_profiles_pull_url', String(config.profilesPullUrl || '').trim());
  }

  insertAccountEvent('platform_config_updated', 'info', 'Platform config updated', {
    hasAuthUrl: Boolean(getPlatformAuthUrl()),
    hasLogUrl: Boolean(getPlatformLogUrl())
  });
  void sendPlatformLog('platform_config_updated', 'info', 'Platform config updated');

  return getPlatformConfig();
}

function saveLoggedInState(normalized, options = {}) {
  const email = String(options.email || normalized.email || '').trim();
  const password = String(options.password || '');
  const rememberMe = options.rememberMe !== false;
  updateState({
    email: normalized.email || email,
    display_name: normalized.displayName,
    platform_user_id: normalized.userId,
    access_token: encryptSecret(normalized.accessToken),
    refresh_token: encryptSecret(normalized.refreshToken),
    token_expires_at: normalized.tokenExpiresAt,
    password_encrypted: rememberMe && password ? encryptSecret(password) : '',
    remember_me: rememberMe ? 1 : 0,
    is_logged_in: 1,
    last_login_at: new Date().toISOString()
  });

  const state = getAccountState();
  return state;
}

async function loginWithCredentials(payload = {}) {
  const email = String(payload.email || '').trim();
  const password = String(payload.password || '');
  const rememberMe = payload.rememberMe !== false;
  const authUrl = getPlatformAuthUrl();

  if (!authUrl) {
    const msg = 'Platform auth URL is not configured (set config/platform.json -> authUrl)';
    insertAccountEvent('login_failed', 'error', msg);
    throw new Error(msg);
  }
  if (!email || !password) {
    const msg = 'Email and password are required';
    insertAccountEvent('login_failed', 'error', msg);
    throw new Error(msg);
  }

  insertAccountEvent('login_attempt', 'info', 'Login started', { email, mode: 'credentials' });
  void sendPlatformLog('login_attempt', 'info', 'Login started', { email, mode: 'credentials' });
  const device = getDeviceInfo();

  const response = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      source: ANTY_SOURCE,
      appVersion: app.getVersion(),
      device
    })
  });

  const body = parseJsonSafe(await response.text());
  if (!response.ok) {
    const errorMessage = parseErrorMessage(response.status, body);
    insertAccountEvent('login_failed', 'error', errorMessage, { email, status: response.status, mode: 'credentials' });
    void sendPlatformLog('login_failed', 'error', errorMessage, { email, status: response.status, mode: 'credentials' });
    throw new Error(errorMessage);
  }

  const normalized = normalizeLoginPayload(body, email);
  if (!normalized.accessToken) {
    const msg = 'Login response has no access token';
    insertAccountEvent('login_failed', 'error', msg, { email, mode: 'credentials' });
    throw new Error(msg);
  }

  const state = saveLoggedInState(normalized, { email, password, rememberMe });
  insertAccountEvent('login_success', 'info', 'Login successful', {
    email: state.email,
    userId: state.platformUserId,
    mode: 'credentials'
  });
  void sendPlatformLog('login_success', 'info', 'Login successful', {
    email: state.email,
    userId: state.platformUserId,
    mode: 'credentials'
  });

  return state;
}

async function loginWithPlatformWeb(payload = {}) {
  const startUrl = getPlatformAuthStartUrl();
  const fallbackPollUrl = getPlatformAuthPollUrl();
  const device = getDeviceInfo();
  const rememberMe = payload.rememberMe !== false;
  const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : 180000;
  const pollIntervalMs = Number(payload.pollIntervalMs) > 0 ? Number(payload.pollIntervalMs) : 2000;

  if (!startUrl) {
    const msg = 'Platform auth start URL is not configured (set config/platform.json -> authStartUrl)';
    insertAccountEvent('login_failed', 'error', msg, { mode: 'web' });
    throw new Error(msg);
  }

  insertAccountEvent('login_attempt', 'info', 'Login started', { mode: 'web' });
  void sendPlatformLog('login_attempt', 'info', 'Login started', { mode: 'web' });

  const startResponse = await fetch(startUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: ANTY_SOURCE,
      appVersion: app.getVersion(),
      device
    })
  });
  const startBody = parseJsonSafe(await startResponse.text());
  if (!startResponse.ok) {
    const errorMessage = parseErrorMessage(startResponse.status, startBody);
    insertAccountEvent('login_failed', 'error', errorMessage, { mode: 'web', stage: 'start', status: startResponse.status });
    void sendPlatformLog('login_failed', 'error', errorMessage, { mode: 'web', stage: 'start', status: startResponse.status });
    throw new Error(errorMessage);
  }

  const immediateLogin = normalizeLoginPayload(startBody, '');
  if (immediateLogin.accessToken) {
    const state = saveLoggedInState(immediateLogin, { rememberMe });
    insertAccountEvent('login_success', 'info', 'Login successful', {
      email: state.email,
      userId: state.platformUserId,
      mode: 'web',
      stage: 'start'
    });
    void sendPlatformLog('login_success', 'info', 'Login successful', {
      email: state.email,
      userId: state.platformUserId,
      mode: 'web',
      stage: 'start'
    });
    return state;
  }

  const nested = startBody.data && typeof startBody.data === 'object' ? startBody.data : {};
  const authUrl = String(startBody.authUrl || startBody.url || nested.authUrl || nested.url || '').trim();
  const requestId = String(startBody.requestId || startBody.request_id || nested.requestId || nested.request_id || '').trim();
  const pollToken = String(startBody.pollToken || startBody.poll_token || nested.pollToken || nested.poll_token || '').trim();
  const responsePollUrl = String(startBody.pollUrl || startBody.poll_url || nested.pollUrl || nested.poll_url || '').trim();
  const pollUrl = responsePollUrl || fallbackPollUrl;

  if (!authUrl) {
    const msg = 'Platform auth/start response has no authUrl';
    insertAccountEvent('login_failed', 'error', msg, { mode: 'web', stage: 'start' });
    throw new Error(msg);
  }
  if (!pollUrl) {
    const msg = 'Platform auth poll URL is not configured (set config/platform.json -> authPollUrl)';
    insertAccountEvent('login_failed', 'error', msg, { mode: 'web', stage: 'start' });
    throw new Error(msg);
  }
  if (!requestId && !pollToken) {
    const msg = 'Platform auth/start response has no requestId or pollToken';
    insertAccountEvent('login_failed', 'error', msg, { mode: 'web', stage: 'start' });
    throw new Error(msg);
  }

  await shell.openExternal(authUrl);
  insertAccountEvent('login_browser_opened', 'info', 'Platform login page opened', { mode: 'web' });
  void sendPlatformLog('login_browser_opened', 'info', 'Platform login page opened', { mode: 'web' });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(pollIntervalMs);
    const pollResponse = await fetch(pollUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        pollToken,
        source: ANTY_SOURCE,
        appVersion: app.getVersion(),
        device
      })
    });

    const pollBody = parseJsonSafe(await pollResponse.text());
    const pollStatus = String(pollBody?.status || pollBody?.state || pollBody?.data?.status || '').toLowerCase();
    if (pollResponse.status === 202 || pollStatus === 'pending' || pollStatus === 'waiting') {
      continue;
    }
    if (!pollResponse.ok) {
      const errorMessage = parseErrorMessage(pollResponse.status, pollBody);
      insertAccountEvent('login_failed', 'error', errorMessage, { mode: 'web', stage: 'poll', status: pollResponse.status });
      void sendPlatformLog('login_failed', 'error', errorMessage, { mode: 'web', stage: 'poll', status: pollResponse.status });
      throw new Error(errorMessage);
    }

    const normalized = normalizeLoginPayload(pollBody, '');
    if (!normalized.accessToken) {
      if (pollStatus === 'pending' || pollStatus === 'waiting') continue;
      const msg = 'Platform auth/poll response has no access token';
      insertAccountEvent('login_failed', 'error', msg, { mode: 'web', stage: 'poll' });
      throw new Error(msg);
    }

    const state = saveLoggedInState(normalized, { rememberMe });
    insertAccountEvent('login_success', 'info', 'Login successful', {
      email: state.email,
      userId: state.platformUserId,
      mode: 'web'
    });
    void sendPlatformLog('login_success', 'info', 'Login successful', {
      email: state.email,
      userId: state.platformUserId,
      mode: 'web'
    });
    return state;
  }

  const timeoutMessage = 'Login timeout. Finish login on platform and try again.';
  insertAccountEvent('login_failed', 'error', timeoutMessage, { mode: 'web', stage: 'poll_timeout' });
  void sendPlatformLog('login_failed', 'error', timeoutMessage, { mode: 'web', stage: 'poll_timeout' });
  throw new Error(timeoutMessage);
}

async function login(payload = {}) {
  const mode = String(payload.mode || '').toLowerCase();
  const email = String(payload.email || '').trim();
  const password = String(payload.password || '');
  if (mode === 'web' || (!email && !password)) {
    return loginWithPlatformWeb(payload);
  }

  // Legacy fallback (only if explicitly passed credentials)
  return loginWithCredentials(payload);
}

async function logout(payload = {}) {
  const clearSaved = Boolean(payload.clearSaved);
  const prev = getStateRow() || {};
  const keepSaved = Number(prev.remember_me || 0) === 1 && !clearSaved;
  const logoutUrl = getPlatformLogoutUrl();
  const device = getDeviceInfo();
  let remoteLogoutDone = false;

  async function callRemoteLogout(accessToken) {
    if (!logoutUrl || !accessToken) {
      return { ok: false, reason: 'missing_logout_url_or_access_token' };
    }

    const response = await fetch(logoutUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        source: ANTY_SOURCE,
        appVersion: app.getVersion(),
        device
      })
    });

    const body = parseJsonSafe(await response.text());
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: body?.error || `logout_failed_${response.status}`,
        message: parseErrorMessage(response.status, body)
      };
    }

    return { ok: true };
  }

  try {
    const { accessToken, refreshToken } = getDecryptedTokensFromRow(prev);
    let remoteResult = await callRemoteLogout(accessToken);

    if (!remoteResult.ok && remoteResult.status === 401) {
      insertAccountEvent('token_refresh_attempt', 'warn', 'Access token expired, trying refresh before logout', {
        stage: 'logout',
        status: 401
      });
      const refreshResult = await refreshSessionWithToken(refreshToken, 'logout_on_401');
      if (refreshResult.ok) {
        remoteResult = await callRemoteLogout(refreshResult.accessToken);
      } else {
        insertAccountEvent('token_refresh_failed', 'warn', refreshResult.message || 'Refresh failed before logout', {
          stage: 'logout',
          reason: refreshResult.reason,
          status: refreshResult.status || null
        });
      }
    }

    if (!remoteResult.ok) {
      insertAccountEvent('logout_remote_failed', 'warn', remoteResult.message || 'Failed to revoke device session on platform', {
        reason: remoteResult.reason,
        status: remoteResult.status || null
      });
    } else {
      remoteLogoutDone = true;
    }
  } catch (err) {
    insertAccountEvent('logout_remote_failed', 'warn', err.message || 'Failed to revoke device session on platform');
  }

  updateState({
    is_logged_in: 0,
    access_token: '',
    refresh_token: '',
    token_expires_at: '',
    last_logout_at: new Date().toISOString(),
    email: keepSaved ? prev.email || '' : '',
    password_encrypted: keepSaved ? prev.password_encrypted || '' : '',
    remember_me: keepSaved ? 1 : 0
  });

  insertAccountEvent('logout', 'info', 'Logged out', {
    email: prev.email || '',
    clearSaved,
    remoteLogoutDone
  });
  void sendPlatformLog('logout', 'info', 'Logged out', {
    email: prev.email || '',
    clearSaved,
    remoteLogoutDone
  });

  return getAccountState();
}

module.exports = {
  login,
  logout,
  isLoggedIn,
  getAccountState,
  listAccountEvents,
  getPlatformConfig,
  setPlatformConfig
};
