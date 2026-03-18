const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

let db;

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
  `);

  // Seed defaults if empty
  const folderCount = db.prepare('SELECT COUNT(*) as cnt FROM folders').get();
  if (folderCount.cnt === 0) {
    db.prepare('INSERT INTO folders (name) VALUES (?)').run('Unassigned');
  }
  const groupCount = db.prepare('SELECT COUNT(*) as cnt FROM groups').get();
  if (groupCount.cnt === 0) {
    db.prepare('INSERT INTO groups (name) VALUES (?)').run('Default Group');
  }

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

module.exports = {
  initDatabase, getDb,
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  listProxies, createProxy, updateProxy, deleteProxy,
  listFolders, createFolder,
  listGroups, createGroup
};
