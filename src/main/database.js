const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

let db;

function hasColumn(tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function ensureColumn(tableName, columnName, definitionSql) {
  if (hasColumn(tableName, columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
}

function getDbPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'anty_browser.db');
}

function initDatabase() {
  const dbPath = getDbPath();
  console.log('[DB] Initializing database at:', dbPath);
  
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'Unassigned',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'Default Group',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '',
      type TEXT DEFAULT 'http',
      host TEXT DEFAULT '',
      port INTEGER DEFAULT 0,
      username TEXT DEFAULT '',
      password TEXT DEFAULT '',
      ip_change_link TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'New Profile',
      folder_id INTEGER DEFAULT NULL,
      group_id INTEGER DEFAULT NULL,
      proxy_id INTEGER DEFAULT NULL,
      remote_id TEXT DEFAULT '',
      team_id TEXT DEFAULT '',
      cloud_updated_at TEXT DEFAULT '',
      status TEXT DEFAULT 'ready',
      user_agent TEXT DEFAULT '',
      fingerprint TEXT DEFAULT '{}',
      cookies TEXT DEFAULT '[]',
      notes TEXT DEFAULT '',
      start_page TEXT DEFAULT 'chrome://new-tab-page',
      created_at TEXT DEFAULT (datetime('now')),
      modified_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL,
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL,
      FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6c63ff'
    );

    CREATE TABLE IF NOT EXISTS profile_tags (
      profile_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (profile_id, tag_id),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS account_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email TEXT DEFAULT '',
      display_name TEXT DEFAULT '',
      platform_user_id TEXT DEFAULT '',
      access_token TEXT DEFAULT '',
      refresh_token TEXT DEFAULT '',
      token_expires_at TEXT DEFAULT '',
      password_encrypted TEXT DEFAULT '',
      remember_me INTEGER DEFAULT 0,
      is_logged_in INTEGER DEFAULT 0,
      last_login_at TEXT DEFAULT '',
      last_logout_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS account_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'info',
      account_email TEXT DEFAULT '',
      account_user_id TEXT DEFAULT '',
      message TEXT DEFAULT '',
      meta TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profile_sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Forward-compatible columns for existing DB files.
  ensureColumn('profiles', 'remote_id', "TEXT DEFAULT ''");
  ensureColumn('profiles', 'team_id', "TEXT DEFAULT ''");
  ensureColumn('profiles', 'cloud_updated_at', "TEXT DEFAULT ''");

  // Seed defaults if empty
  const folderCount = db.prepare('SELECT COUNT(*) as cnt FROM folders').get();
  if (folderCount.cnt === 0) {
    db.prepare('INSERT INTO folders (name) VALUES (?)').run('Unassigned');
  }
  const groupCount = db.prepare('SELECT COUNT(*) as cnt FROM groups').get();
  if (groupCount.cnt === 0) {
    db.prepare('INSERT INTO groups (name) VALUES (?)').run('Default Group');
  }
  db.prepare(`
    INSERT OR IGNORE INTO account_state (id)
    VALUES (1)
  `).run();

  console.log('[DB] Database initialized successfully');
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// ---- PROFILES ----
function listProfiles() {
  return getDb().prepare(`
    SELECT p.*, f.name as folder_name, g.name as group_name, pr.name as proxy_name, pr.type as proxy_type, pr.host as proxy_host
    FROM profiles p
    LEFT JOIN folders f ON p.folder_id = f.id
    LEFT JOIN groups g ON p.group_id = g.id
    LEFT JOIN proxies pr ON p.proxy_id = pr.id
    ORDER BY p.modified_at DESC
  `).all();
}

function getProfile(id) {
  return getDb().prepare(`
    SELECT p.*, f.name as folder_name, g.name as group_name, pr.name as proxy_name, pr.type as proxy_type, pr.host as proxy_host, pr.port as proxy_port, pr.username as proxy_username, pr.password as proxy_password
    FROM profiles p
    LEFT JOIN folders f ON p.folder_id = f.id
    LEFT JOIN groups g ON p.group_id = g.id
    LEFT JOIN proxies pr ON p.proxy_id = pr.id
    WHERE p.id = ?
  `).get(id);
}

function createProfile(data) {
  const { generateFingerprint } = require('./fingerprint');
  const fingerprint = generateFingerprint(data.user_agent);
  
  const result = getDb().prepare(`
    INSERT INTO profiles (name, folder_id, group_id, proxy_id, user_agent, fingerprint, start_page, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name || 'New Profile',
    data.folder_id || null,
    data.group_id || null,
    data.proxy_id || null,
    fingerprint.userAgent,
    JSON.stringify(fingerprint),
    data.start_page || 'chrome://new-tab-page',
    data.notes || ''
  );
  
  return getProfile(result.lastInsertRowid);
}

function updateProfile(id, data) {
  const sets = [];
  const values = [];
  
  const allowedFields = ['name', 'folder_id', 'group_id', 'proxy_id', 'user_agent', 'fingerprint', 'cookies', 'notes', 'start_page', 'status'];
  
  for (const field of allowedFields) {
    if (data[field] !== undefined) {
      sets.push(`${field} = ?`);
      values.push(typeof data[field] === 'object' ? JSON.stringify(data[field]) : data[field]);
    }
  }
  
  if (sets.length === 0) return getProfile(id);
  
  sets.push("modified_at = datetime('now')");
  values.push(id);
  
  getDb().prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getProfile(id);
}

function deleteProfile(id) {
  return getDb().prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

function getProfileByRemoteId(remoteId) {
  if (!remoteId) return null;
  return getDb().prepare(`
    SELECT p.*, f.name as folder_name, g.name as group_name, pr.name as proxy_name, pr.type as proxy_type, pr.host as proxy_host, pr.port as proxy_port, pr.username as proxy_username, pr.password as proxy_password
    FROM profiles p
    LEFT JOIN folders f ON p.folder_id = f.id
    LEFT JOIN groups g ON p.group_id = g.id
    LEFT JOIN proxies pr ON p.proxy_id = pr.id
    WHERE p.remote_id = ?
  `).get(String(remoteId));
}

// ---- CLOUD SYNC QUEUE ----
function enqueueProfileSync(action, payload = {}) {
  const result = getDb().prepare(`
    INSERT INTO profile_sync_queue (action, payload, status, retry_count, last_error, created_at, updated_at)
    VALUES (?, ?, 'pending', 0, '', datetime('now'), datetime('now'))
  `).run(String(action || ''), JSON.stringify(payload || {}));
  return getDb().prepare('SELECT * FROM profile_sync_queue WHERE id = ?').get(result.lastInsertRowid);
}

function listProfileSyncQueue(limit = 50) {
  const normalized = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
  return getDb().prepare(`
    SELECT *
    FROM profile_sync_queue
    WHERE status IN ('pending', 'failed')
    ORDER BY id ASC
    LIMIT ?
  `).all(normalized);
}

function markProfileSyncDone(id) {
  return getDb().prepare(`
    DELETE FROM profile_sync_queue
    WHERE id = ?
  `).run(id);
}

function markProfileSyncFailed(id, errorMessage) {
  return getDb().prepare(`
    UPDATE profile_sync_queue
    SET
      status = 'failed',
      retry_count = retry_count + 1,
      last_error = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(String(errorMessage || ''), id);
}

// ---- PROXIES ----
function listProxies() {
  return getDb().prepare('SELECT * FROM proxies ORDER BY id DESC').all();
}

function createProxy(data) {
  const result = getDb().prepare(`
    INSERT INTO proxies (name, type, host, port, username, password, ip_change_link)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(data.name || '', data.type || 'http', data.host || '', data.port || 0, data.username || '', data.password || '', data.ip_change_link || '');
  return getDb().prepare('SELECT * FROM proxies WHERE id = ?').get(result.lastInsertRowid);
}

function updateProxy(id, data) {
  const sets = [];
  const values = [];
  for (const field of ['name', 'type', 'host', 'port', 'username', 'password', 'ip_change_link']) {
    if (data[field] !== undefined) {
      sets.push(`${field} = ?`);
      values.push(data[field]);
    }
  }
  if (sets.length === 0) return getDb().prepare('SELECT * FROM proxies WHERE id = ?').get(id);
  values.push(id);
  getDb().prepare(`UPDATE proxies SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getDb().prepare('SELECT * FROM proxies WHERE id = ?').get(id);
}

function deleteProxy(id) {
  return getDb().prepare('DELETE FROM proxies WHERE id = ?').run(id);
}

// ---- FOLDERS ----
function listFolders() {
  return getDb().prepare('SELECT * FROM folders ORDER BY id').all();
}

function createFolder(name) {
  const result = getDb().prepare('INSERT INTO folders (name) VALUES (?)').run(name);
  return getDb().prepare('SELECT * FROM folders WHERE id = ?').get(result.lastInsertRowid);
}

// ---- GROUPS ----
function listGroups() {
  return getDb().prepare('SELECT * FROM groups ORDER BY id').all();
}

function createGroup(name) {
  const result = getDb().prepare('INSERT INTO groups (name) VALUES (?)').run(name);
  return getDb().prepare('SELECT * FROM groups WHERE id = ?').get(result.lastInsertRowid);
}

// ---- APP SETTINGS ----
function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : '';
}

function setSetting(key, value) {
  getDb().prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(key, value ?? '');
  return getSetting(key);
}

module.exports = {
  initDatabase, getDb,
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile, getProfileByRemoteId,
  listProxies, createProxy, updateProxy, deleteProxy,
  listFolders, createFolder,
  listGroups, createGroup,
  getSetting, setSetting,
  enqueueProfileSync, listProfileSyncQueue, markProfileSyncDone, markProfileSyncFailed
};
