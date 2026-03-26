const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

let db;

function hasColumn(tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function ensureColumn(tableName, columnName, definitionSql) {
  if (hasColumn(tableName, columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
}

function getDataDir() {
  if (process.env.ANTY_DATA_DIR) return process.env.ANTY_DATA_DIR;
  try {
    const { app } = require('electron');
    return app.getPath('userData');
  } catch {
    return path.join(os.homedir(), '.anty');
  }
}

function getDbPath() {
  return path.join(getDataDir(), 'anty_browser.db');
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
      start_page TEXT DEFAULT 'https://whoer.net',
      warmup_url TEXT DEFAULT '',
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

  // Indexes for JOIN-heavy queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_profiles_folder   ON profiles(folder_id);
    CREATE INDEX IF NOT EXISTS idx_profiles_group    ON profiles(group_id);
    CREATE INDEX IF NOT EXISTS idx_profiles_proxy    ON profiles(proxy_id);
    CREATE INDEX IF NOT EXISTS idx_profiles_modified ON profiles(modified_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON profile_sync_queue(status);
  `);

  // Forward-compatible columns for existing DB files.
  ensureColumn('profiles', 'remote_id', "TEXT DEFAULT ''");
  ensureColumn('profiles', 'team_id', "TEXT DEFAULT ''");
  ensureColumn('profiles', 'cloud_updated_at', "TEXT DEFAULT ''");
  ensureColumn('profiles', 'created_by', "TEXT DEFAULT ''");
  ensureColumn('profiles', 'warmup_url', "TEXT DEFAULT ''");
  ensureColumn('account_state', 'team_name', "TEXT DEFAULT ''");

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

function profileExists(profileId) {
  const row = getDb().prepare('SELECT id FROM profiles WHERE id = ?').get(profileId);
  return Boolean(row?.id);
}

function normalizeTagNames(input) {
  if (!input) return [];
  const source = Array.isArray(input) ? input : String(input).split(',');
  const normalized = source
    .map((entry) => {
      if (entry && typeof entry === 'object') return String(entry.name || '').trim();
      return String(entry || '').trim();
    })
    .filter(Boolean);
  return Array.from(new Set(normalized.map((name) => name.slice(0, 64))));
}

function ensureTagByName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) return null;
  const existing = getDb().prepare('SELECT * FROM tags WHERE lower(name) = lower(?) LIMIT 1').get(normalized);
  if (existing) return existing;
  const result = getDb().prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(normalized, '#6c63ff');
  return getDb().prepare('SELECT * FROM tags WHERE id = ?').get(result.lastInsertRowid);
}

function listTags() {
  return getDb().prepare(`
    SELECT t.*, COUNT(pt.profile_id) AS profiles_count
    FROM tags t
    LEFT JOIN profile_tags pt ON pt.tag_id = t.id
    GROUP BY t.id
    ORDER BY lower(t.name) ASC
  `).all();
}

function getProfileTags(profileId) {
  return getDb().prepare(`
    SELECT t.id, t.name, t.color
    FROM profile_tags pt
    JOIN tags t ON t.id = pt.tag_id
    WHERE pt.profile_id = ?
    ORDER BY lower(t.name) ASC
  `).all(profileId);
}

function setProfileTags(profileId, tagsInput) {
  if (!profileExists(profileId)) return [];
  const tagNames = normalizeTagNames(tagsInput);
  const tx = getDb().transaction((pid, names) => {
    getDb().prepare('DELETE FROM profile_tags WHERE profile_id = ?').run(pid);
    for (const tagName of names) {
      const tag = ensureTagByName(tagName);
      if (!tag?.id) continue;
      getDb().prepare('INSERT OR IGNORE INTO profile_tags (profile_id, tag_id) VALUES (?, ?)').run(pid, tag.id);
    }
  });
  tx(profileId, tagNames);
  return getProfileTags(profileId);
}

function attachTagsToProfiles(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows || [];
  const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return rows;
  const placeholders = ids.map(() => '?').join(', ');
  const tagsRows = getDb().prepare(`
    SELECT pt.profile_id, t.id, t.name, t.color
    FROM profile_tags pt
    JOIN tags t ON t.id = pt.tag_id
    WHERE pt.profile_id IN (${placeholders})
    ORDER BY lower(t.name) ASC
  `).all(...ids);
  const byProfile = new Map();
  for (const row of tagsRows) {
    if (!byProfile.has(row.profile_id)) byProfile.set(row.profile_id, []);
    byProfile.get(row.profile_id).push({
      id: row.id,
      name: row.name,
      color: row.color
    });
  }
  return rows.map((row) => ({
    ...row,
    tags: byProfile.get(row.id) || []
  }));
}

// ---- PROFILES ----
function listProfiles() {
  const rows = getDb().prepare(`
    SELECT p.*, f.name as folder_name, g.name as group_name, pr.name as proxy_name, pr.type as proxy_type, pr.host as proxy_host
    FROM profiles p
    LEFT JOIN folders f ON p.folder_id = f.id
    LEFT JOIN groups g ON p.group_id = g.id
    LEFT JOIN proxies pr ON p.proxy_id = pr.id
    ORDER BY p.modified_at DESC
  `).all();
  return attachTagsToProfiles(rows);
}

function getProfile(id) {
  const row = getDb().prepare(`
    SELECT p.*, f.name as folder_name, g.name as group_name, pr.name as proxy_name, pr.type as proxy_type, pr.host as proxy_host, pr.port as proxy_port, pr.username as proxy_username, pr.password as proxy_password
    FROM profiles p
    LEFT JOIN folders f ON p.folder_id = f.id
    LEFT JOIN groups g ON p.group_id = g.id
    LEFT JOIN proxies pr ON p.proxy_id = pr.id
    WHERE p.id = ?
  `).get(id);
  if (!row) return null;
  return attachTagsToProfiles([row])[0] || row;
}

function createProfile(data) {
  const { generateFingerprint } = require('./fingerprint');
  const { getAccountState } = require('./auth');
  const fingerprint = generateFingerprint(data.user_agent);

  let createdBy = data.created_by || '';
  if (!createdBy) {
    try {
      const acc = getAccountState();
      createdBy = acc.displayName || acc.email || '';
    } catch {}
  }

  const result = getDb().prepare(`
    INSERT INTO profiles (name, folder_id, group_id, proxy_id, user_agent, fingerprint, start_page, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name || 'New Profile',
    data.folder_id || null,
    data.group_id || null,
    data.proxy_id || null,
    fingerprint.userAgent,
    JSON.stringify(fingerprint),
    data.start_page || 'https://whoer.net',
    data.notes || '',
    createdBy
  );

  if (data.tags !== undefined) {
    setProfileTags(result.lastInsertRowid, data.tags);
  }

  return getProfile(result.lastInsertRowid);
}

function updateProfile(id, data) {
  const updateData = data || {};
  if (!profileExists(id)) return null;
  const sets = [];
  const values = [];
  const hasTagsUpdate = Object.prototype.hasOwnProperty.call(updateData, 'tags');
  const fkFields = new Set(['folder_id', 'group_id', 'proxy_id']);
  
  const allowedFields = [
    'name',
    'folder_id',
    'group_id',
    'proxy_id',
    'remote_id',
    'team_id',
    'cloud_updated_at',
    'user_agent',
    'fingerprint',
    'cookies',
    'notes',
    'start_page',
    'warmup_url',
    'status'
  ];
  
  for (const field of allowedFields) {
    if (updateData[field] !== undefined) {
      sets.push(`${field} = ?`);
      let value = updateData[field];
      if (fkFields.has(field)) {
        const numeric = Number(value);
        value = Number.isFinite(numeric) && numeric > 0 ? numeric : null;
      }
      values.push(value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
    }
  }
  
  if (sets.length > 0) {
    sets.push("modified_at = datetime('now')");
    values.push(id);
    getDb().prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
  
  if (hasTagsUpdate) {
    setProfileTags(id, updateData.tags);
    getDb().prepare("UPDATE profiles SET modified_at = datetime('now') WHERE id = ?").run(id);
  }

  if (sets.length === 0 && !hasTagsUpdate) return getProfile(id);
  return getProfile(id);
}

function deleteProfile(id) {
  return getDb().prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

function getProfileByRemoteId(remoteId) {
  if (!remoteId) return null;
  const row = getDb().prepare(`
    SELECT p.*, f.name as folder_name, g.name as group_name, pr.name as proxy_name, pr.type as proxy_type, pr.host as proxy_host, pr.port as proxy_port, pr.username as proxy_username, pr.password as proxy_password
    FROM profiles p
    LEFT JOIN folders f ON p.folder_id = f.id
    LEFT JOIN groups g ON p.group_id = g.id
    LEFT JOIN proxies pr ON p.proxy_id = pr.id
    WHERE p.remote_id = ?
  `).get(String(remoteId));
  if (!row) return null;
  return attachTagsToProfiles([row])[0] || row;
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
  listTags, getProfileTags, setProfileTags,
  listProxies, createProxy, updateProxy, deleteProxy,
  listFolders, createFolder,
  listGroups, createGroup,
  getSetting, setSetting,
  enqueueProfileSync, listProfileSyncQueue, markProfileSyncDone, markProfileSyncFailed
};
