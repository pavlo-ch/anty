const { app, safeStorage } = require('electron');
const db = require('./database');

const DEFAULT_PLATFORM_AUTH_URL = '';
const DEFAULT_PLATFORM_LOG_URL = '';

function getPlatformAuthUrl() {
  return (db.getSetting('platform_auth_url') || process.env.ANTY_PLATFORM_AUTH_URL || DEFAULT_PLATFORM_AUTH_URL || '').trim();
}

function getPlatformLogUrl() {
  return (db.getSetting('platform_log_url') || process.env.ANTY_PLATFORM_LOG_URL || DEFAULT_PLATFORM_LOG_URL || '').trim();
}

function encryptSecret(secret) {
  if (!secret) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(secret).toString('base64');
    }
  } catch (_) {}
  return Buffer.from(secret, 'utf8').toString('base64');
}

function decryptSecret(value) {
  if (!value) return '';
  try {
    const asBuffer = Buffer.from(value, 'base64');
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(asBuffer);
    }
    return asBuffer.toString('utf8');
  } catch (_) {
    return '';
  }
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
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: 'anty-browser',
        version: app.getVersion(),
        event: eventType,
        status: status || 'info',
        message: message || '',
        meta,
        ts: new Date().toISOString()
      })
    });
  } catch (err) {
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
  if (payload && typeof payload === 'object') {
    return payload.message || payload.error || payload.detail || `Login failed (${status})`;
  }
  return `Login failed (${status})`;
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
  const logUrl = getPlatformLogUrl();
  return {
    authUrl,
    logUrl,
    authUrlConfigured: Boolean(authUrl),
    logUrlConfigured: Boolean(logUrl)
  };
}

function setPlatformConfig(config = {}) {
  if (config.authUrl !== undefined) {
    db.setSetting('platform_auth_url', String(config.authUrl || '').trim());
  }
  if (config.logUrl !== undefined) {
    db.setSetting('platform_log_url', String(config.logUrl || '').trim());
  }

  insertAccountEvent('platform_config_updated', 'info', 'Platform config updated', {
    hasAuthUrl: Boolean(getPlatformAuthUrl()),
    hasLogUrl: Boolean(getPlatformLogUrl())
  });
  void sendPlatformLog('platform_config_updated', 'info', 'Platform config updated');

  return getPlatformConfig();
}

async function login(payload = {}) {
  const email = String(payload.email || '').trim();
  const password = String(payload.password || '');
  const rememberMe = payload.rememberMe !== false;
  const authUrl = getPlatformAuthUrl();

  if (!authUrl) {
    const msg = 'Platform auth URL is not configured';
    insertAccountEvent('login_failed', 'error', msg);
    throw new Error(msg);
  }
  if (!email || !password) {
    const msg = 'Email and password are required';
    insertAccountEvent('login_failed', 'error', msg);
    throw new Error(msg);
  }

  insertAccountEvent('login_attempt', 'info', 'Login started', { email });
  void sendPlatformLog('login_attempt', 'info', 'Login started', { email });

  const response = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      source: 'anty-browser',
      appVersion: app.getVersion()
    })
  });

  let body = {};
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = { raw: text };
    }
  }

  if (!response.ok) {
    const errorMessage = parseErrorMessage(response.status, body);
    insertAccountEvent('login_failed', 'error', errorMessage, { email, status: response.status });
    void sendPlatformLog('login_failed', 'error', errorMessage, { email, status: response.status });
    throw new Error(errorMessage);
  }

  const normalized = normalizeLoginPayload(body, email);
  if (!normalized.accessToken) {
    const msg = 'Login response has no access token';
    insertAccountEvent('login_failed', 'error', msg, { email });
    throw new Error(msg);
  }

  updateState({
    email: normalized.email || email,
    display_name: normalized.displayName,
    platform_user_id: normalized.userId,
    access_token: normalized.accessToken,
    refresh_token: normalized.refreshToken,
    token_expires_at: normalized.tokenExpiresAt,
    password_encrypted: rememberMe ? encryptSecret(password) : '',
    remember_me: rememberMe ? 1 : 0,
    is_logged_in: 1,
    last_login_at: new Date().toISOString()
  });

  const state = getAccountState();
  insertAccountEvent('login_success', 'info', 'Login successful', {
    email: state.email,
    userId: state.platformUserId
  });
  void sendPlatformLog('login_success', 'info', 'Login successful', {
    email: state.email,
    userId: state.platformUserId
  });

  return state;
}

async function logout(payload = {}) {
  const clearSaved = Boolean(payload.clearSaved);
  const prev = getStateRow() || {};
  const keepSaved = Number(prev.remember_me || 0) === 1 && !clearSaved;

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
    clearSaved
  });
  void sendPlatformLog('logout', 'info', 'Logged out', {
    email: prev.email || '',
    clearSaved
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
