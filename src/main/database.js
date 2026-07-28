const Database = require('better-sqlite3');
const fs = require('fs');
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

  // When running inside Electron — use app.getPath('userData')
  try {
    const { app } = require('electron');
    return app.getPath('userData');
  } catch { /* not Electron */ }

  // When running as standalone API server — auto-detect where Electron wrote the DB
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.APPDATA || '', 'anty-browser'),
        path.join(process.env.APPDATA || '', 'Anty Browser'),
      ]
    : process.platform === 'darwin'
    ? [
        path.join(home, 'Library', 'Application Support', 'anty-browser'),
        path.join(home, 'Library', 'Application Support', 'Anty Browser'),
      ]
    : [
        path.join(home, '.config', 'anty-browser'),
        path.join(home, '.config', 'Anty Browser'),
      ];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'anty_browser.db'))) return dir;
  }

  // Fallback — use first candidate (will be created on init)
  return candidates[0] || path.join(home, '.anty');
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
      storage_state TEXT DEFAULT '',
      last_open_tabs TEXT DEFAULT '[]',
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
  ensureColumn('profiles', 'running_on', "TEXT DEFAULT ''");
  ensureColumn('profiles', 'storage_state', "TEXT DEFAULT ''");
  ensureColumn('profiles', 'last_open_tabs', "TEXT DEFAULT '[]'");
  // Separate from modified_at: the profile list needs "when was this last OPENED",
  // and modified_at moves on every content edit and every platform sync pull, so
  // freshly-synced profiles that nobody ever launched showed up as "just now".
  ensureColumn('profiles', 'last_launched_at', "TEXT DEFAULT ''");
  // When adding `warmup_completed` to an existing DB, mark all PRE-EXISTING
  // profiles as already warmed-up (skip=1). Only brand-new profiles created
  // AFTER this point will trigger the warmup dialog on first launch.
  const warmupColumnIsNew = !hasColumn('profiles', 'warmup_completed');
  ensureColumn('profiles', 'warmup_completed', 'INTEGER DEFAULT 0');
  ensureColumn('profiles', 'warmup_config', "TEXT DEFAULT ''");
  if (warmupColumnIsNew) {
    db.prepare('UPDATE profiles SET warmup_completed = 1').run();
  }
  ensureColumn('account_state', 'team_name', "TEXT DEFAULT ''");
  ensureColumn('account_state', 'team_id', "TEXT DEFAULT ''");

  // Tenancy boundary. Every profile row and every sync-queue entry is stamped with
  // the scope of the session that created it, and all profile reads are filtered by
  // the currently active scope — see resolveActiveScope(). Without this, one SQLite
  // file per machine plus a logout that clears only tokens meant a user from team B
  // logged in after team A saw, and could launch, team A's profiles and their live
  // Chrome sessions.
  ensureColumn('profiles', 'owner_scope', "TEXT DEFAULT ''");
  ensureColumn('profile_sync_queue', 'owner_scope', "TEXT DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_profiles_scope ON profiles(owner_scope);');

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

  // Claim pre-scope rows for the session that is ALREADY signed in.
  //
  // Doing this only at login is not enough: an existing user upgrading the app is
  // restored from stored tokens and never passes through saveLoggedInState, so
  // without this every one of their profiles would sit at owner_scope '' and the
  // filtered list would come up empty on first launch of the new version. Verified
  // against a rebuilt pre-upgrade database — 3 profiles in, 0 shown, before this ran.
  //
  // Uses the stored team id, which is empty on a first upgrade; adoption then falls
  // back to claiming for the signed-in session, which is correct here because that
  // session is by definition the one that populated this machine's store.
  //
  // Gated on a resolvable scope, NOT on the is_logged_in flag. profile-sync's own
  // isLoggedIn() only checks that a token exists, so a pull can start while the flag
  // is still 0 — observed live: adoption was skipped, the now-scoped
  // getProfileByRemoteId matched none of the 29 existing rows, and the pull recreated
  // 28 of them as duplicates. Any account identity in the row is enough to claim.
  try {
    const account = db.prepare('SELECT team_id FROM account_state WHERE id = 1').get();
    const scope = resolveActiveScope();
    if (scope) {
      adoptLegacyProfilesIntoScope(scope, account?.team_id || '');
    }
  } catch (err) {
    console.error('[DB] Startup scope adoption failed:', err.message);
  }

  // On startup, reset profiles that were "running" on THIS device (crashed last session).
  // Do NOT reset profiles running on other team members' devices.
  const thisHost = os.hostname();
  db.prepare("UPDATE profiles SET status='ready', running_on='' WHERE status='running' AND (running_on='' OR running_on=?)").run(thisHost);

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

// ---- TENANCY SCOPE ----

/**
 * Key identifying which tenant the local store currently belongs to.
 *
 * The platform's team id is preferred because it is unique: a name-derived key lets
 * a different team with the same display name land on the same scope and see the
 * profiles, which is a real attack on a shared machine, not just an edge case.
 * team_name is only the fallback for before an id is known — the login payload is
 * verified to carry a name but not necessarily an id. promoteScopeToTeamId() moves
 * the store onto the id key as soon as a pull reveals one, so the weaker key is
 * temporary rather than permanent.
 *
 * A user with no team falls back to their own account id, which is the right
 * boundary for a solo user — never the empty string, or two teamless accounts
 * would share a scope.
 *
 * Returns '' only when nobody is logged in, which no profile read path should hit
 * (IPC gates on login first).
 */
function resolveActiveScope() {
  let row;
  try {
    row = getDb().prepare('SELECT team_id, team_name, platform_user_id FROM account_state WHERE id = 1').get();
  } catch (_) {
    return '';
  }
  if (!row) return '';
  const teamId = String(row.team_id || '').trim();
  if (teamId) return `team:${teamId}`;
  const teamName = String(row.team_name || '').trim().toLowerCase();
  if (teamName) return `teamname:${teamName}`;
  const userId = String(row.platform_user_id || '').trim();
  if (userId) return `user:${userId}`;
  return '';
}

/**
 * Upgrade a name-derived scope to the platform's team id once one is known.
 *
 * The id is read off the profiles a pull just returned for this session's token,
 * which is what makes the move safe: the platform served those rows to this session,
 * so the local store demonstrably belongs to that team. Doing it here rather than
 * waiting on the login payload means the collision-prone name key is short-lived.
 *
 * No-op once account_state already carries an id, so it never fights a later login.
 */
function promoteScopeToTeamId(teamId) {
  const id = String(teamId || '').trim();
  if (!id) return { promoted: false, reason: 'no_team_id' };

  const row = getDb().prepare('SELECT team_id FROM account_state WHERE id = 1').get();
  if (String(row?.team_id || '').trim()) return { promoted: false, reason: 'already_set' };

  const previousScope = resolveActiveScope();
  getDb().prepare('UPDATE account_state SET team_id = ? WHERE id = 1').run(id);
  const newScope = resolveActiveScope();
  if (!previousScope || previousScope === newScope) return { promoted: false, reason: 'scope_unchanged' };

  const res = getDb().prepare('UPDATE profiles SET owner_scope = ? WHERE owner_scope = ?').run(newScope, previousScope);
  getDb().prepare('UPDATE profile_sync_queue SET owner_scope = ? WHERE owner_scope = ?').run(newScope, previousScope);
  setSetting(SCOPE_LAST_KEY, newScope);
  setSetting(SCOPE_LAST_TEAM_ID, id);
  console.log(`[DB] Scope upgraded to team id: moved ${res.changes} profile(s) from ${previousScope} to ${newScope}`);
  return { promoted: true, moved: res.changes };
}

const SCOPE_INIT_SETTING_KEY = 'profiles_scope_initialized';
const SCOPE_LAST_KEY = 'profiles_active_scope';
const SCOPE_LAST_TEAM_ID = 'profiles_active_team_id';

/**
 * Follow a team rename.
 *
 * Because the scope key is derived from the team name, renaming a team on the
 * platform would otherwise orphan every local profile under the old key. If the
 * session's platform team id is unchanged but the derived scope moved, the rows are
 * re-stamped. Requires the platform to send a team id at login; without one there is
 * nothing to prove the two names are the same team, so the rows are left alone
 * rather than handed to a possibly-different tenant.
 */
function reconcileScopeRename(scope, teamId) {
  const previousScope = String(getSetting(SCOPE_LAST_KEY) || '');
  const previousTeamId = String(getSetting(SCOPE_LAST_TEAM_ID) || '');
  const currentTeamId = String(teamId || '').trim();

  if (scope && previousScope && previousScope !== scope && currentTeamId && currentTeamId === previousTeamId) {
    const res = getDb().prepare('UPDATE profiles SET owner_scope = ? WHERE owner_scope = ?').run(scope, previousScope);
    getDb().prepare('UPDATE profile_sync_queue SET owner_scope = ? WHERE owner_scope = ?').run(scope, previousScope);
    if (res.changes > 0) {
      console.log(`[DB] Team renamed — moved ${res.changes} profile(s) from ${previousScope} to ${scope}`);
    }
  }
  if (scope) {
    setSetting(SCOPE_LAST_KEY, scope);
    if (currentTeamId) setSetting(SCOPE_LAST_TEAM_ID, currentTeamId);
  }
}

/**
 * One-time adoption of rows that predate the owner_scope column.
 *
 * Those rows carry '' and would otherwise be invisible to every scope — hidden data,
 * not deleted data, but still a regression for an existing install.
 *
 * Ownership is taken from the rows themselves where possible: every profile pulled
 * from the platform carries the owning team's id, so a store whose rows all share
 * one team id is unambiguously that team's, no matter who happens to log in first.
 * Adoption is refused when the session's team id contradicts the rows — that is a
 * different tenant logging in first on a shared machine, exactly the case this whole
 * boundary exists for. When the session carries no team id there is nothing to check
 * against, so the first session claims them and the team it went to is logged.
 */
function adoptLegacyProfilesIntoScope(scope, sessionTeamId) {
  if (!scope) return { adopted: 0, skipped: 'no_scope' };
  if (String(getSetting(SCOPE_INIT_SETTING_KEY) || '') === '1') {
    return { adopted: 0, skipped: 'already_initialized' };
  }

  const legacyTeams = getDb()
    .prepare("SELECT DISTINCT team_id FROM profiles WHERE owner_scope = '' AND team_id <> ''")
    .all()
    .map((r) => String(r.team_id));
  const sessionTeam = String(sessionTeamId || '').trim();

  if (sessionTeam && legacyTeams.length > 0 && !legacyTeams.includes(sessionTeam)) {
    console.warn(
      `[DB] Refusing to adopt ${legacyTeams.length} pre-scope team(s) into ${scope}: ` +
      'these profiles belong to a different team. They stay hidden until that team signs in.'
    );
    return { adopted: 0, skipped: 'team_mismatch' };
  }

  const res = getDb().prepare("UPDATE profiles SET owner_scope = ? WHERE owner_scope = ''").run(scope);
  getDb().prepare("UPDATE profile_sync_queue SET owner_scope = ? WHERE owner_scope = ''").run(scope);
  setSetting(SCOPE_INIT_SETTING_KEY, '1');
  if (res.changes > 0) {
    const provenance = sessionTeam ? 'team id confirmed' : 'no team id at login — first session claimed them';
    console.log(`[DB] Adopted ${res.changes} pre-scope profile(s) into ${scope} (${provenance})`);
  }
  return { adopted: res.changes };
}

// ---- PROFILES ----

/**
 * Profiles visible to the active tenant.
 *
 * Filtering lives here rather than at the ~30 getProfile/listProfiles call sites so
 * that launcher, sync, IPC and the REST API are all covered by construction — no
 * caller can forget the predicate.
 */
function listProfiles() {
  const scope = resolveActiveScope();
  const rows = getDb().prepare(`
    SELECT p.*, f.name as folder_name, g.name as group_name, pr.name as proxy_name, pr.type as proxy_type, pr.host as proxy_host
    FROM profiles p
    LEFT JOIN folders f ON p.folder_id = f.id
    LEFT JOIN groups g ON p.group_id = g.id
    LEFT JOIN proxies pr ON p.proxy_id = pr.id
    WHERE p.owner_scope = ?
    ORDER BY p.modified_at DESC
  `).all(scope);
  return attachTagsToProfiles(rows);
}

/**
 * Scoped by default. Out-of-scope ids return null exactly like non-existent ones,
 * so an id guessed or enumerated by another tenant is indistinguishable from a
 * deleted profile — and every caller that launches, edits or deletes by id
 * (ipc-handlers, launcher, the REST API) inherits the check for free.
 *
 * Pass { anyScope: true } only for maintenance paths that legitimately span
 * tenants; nothing in the request path should need it.
 */
function getProfile(id, options = {}) {
  const scope = resolveActiveScope();
  const scoped = !options.anyScope;
  const row = getDb().prepare(`
    SELECT p.*, f.name as folder_name, g.name as group_name, pr.name as proxy_name, pr.type as proxy_type, pr.host as proxy_host, pr.port as proxy_port, pr.username as proxy_username, pr.password as proxy_password
    FROM profiles p
    LEFT JOIN folders f ON p.folder_id = f.id
    LEFT JOIN groups g ON p.group_id = g.id
    LEFT JOIN proxies pr ON p.proxy_id = pr.id
    WHERE p.id = ? ${scoped ? 'AND p.owner_scope = ?' : ''}
  `).get(...(scoped ? [id, scope] : [id]));
  if (!row) return null;
  return attachTagsToProfiles([row])[0] || row;
}

function createProfile(data = {}) {
  const { generateFingerprint, generateFingerprintFromUA } = require('./fingerprint');
  const { getAccountState } = require('./auth');
  const generateDefaultFingerprint = () => (
    data.user_agent ? generateFingerprintFromUA(data.user_agent) : generateFingerprint()
  );
  const fingerprint = (() => {
    if (!data.fingerprint) return generateDefaultFingerprint();
    if (typeof data.fingerprint === 'string') {
      try {
        const parsed = JSON.parse(data.fingerprint);
        return parsed && typeof parsed === 'object' ? parsed : generateDefaultFingerprint();
      } catch (_) {
        return generateDefaultFingerprint();
      }
    }
    return typeof data.fingerprint === 'object' ? data.fingerprint : generateDefaultFingerprint();
  })();
  const userAgent = data.user_agent || fingerprint.userAgent || '';
  if (userAgent) fingerprint.userAgent = userAgent;

  let createdBy = data.created_by || '';
  if (!createdBy) {
    try {
      const acc = getAccountState();
      createdBy = acc.displayName || acc.email || '';
    } catch {}
  }

  const result = getDb().prepare(`
    INSERT INTO profiles (name, folder_id, group_id, proxy_id, user_agent, fingerprint, cookies, start_page, warmup_url, notes, created_by, storage_state, owner_scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name || 'New Profile',
    data.folder_id || null,
    data.group_id || null,
    data.proxy_id || null,
    userAgent,
    JSON.stringify(fingerprint),
    data.cookies ? (typeof data.cookies === 'string' ? data.cookies : JSON.stringify(data.cookies)) : '[]',
    data.start_page || 'https://whoer.net',
    data.warmup_url || '',
    data.notes || '',
    createdBy,
    data.storage_state ? (typeof data.storage_state === 'string' ? data.storage_state : JSON.stringify(data.storage_state)) : '',
    // Stamped from the session doing the creating, never from caller-supplied data —
    // the REST API passes request bodies straight through to profile writes, so an
    // attacker-controlled scope would defeat the whole boundary.
    resolveActiveScope()
  );

  if (data.tags !== undefined) {
    setProfileTags(result.lastInsertRowid, data.tags);
  }

  return getProfile(result.lastInsertRowid);
}

const JSON_PROFILE_FIELDS = new Set(['fingerprint', 'cookies', 'storage_state', 'last_open_tabs']);
const CONTENT_MODIFIED_FIELDS = new Set([
  'name',
  'folder_id',
  'group_id',
  'proxy_id',
  'user_agent',
  'fingerprint',
  'notes',
  'start_page',
  'warmup_url',
  'created_by',
  'warmup_config'
]);

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
}

function normalizeDbFieldValue(field, value, fkFields) {
  if (fkFields.has(field)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }
  if (JSON_PROFILE_FIELDS.has(field) && value !== null && typeof value === 'object') {
    return stableStringify(value);
  }
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
}

function fieldValuesEqual(field, currentValue, nextValue, fkFields) {
  if (fkFields.has(field)) {
    const currentNumeric = Number(currentValue);
    const normalizedCurrent = Number.isFinite(currentNumeric) && currentNumeric > 0 ? currentNumeric : null;
    return normalizedCurrent === nextValue;
  }
  if (JSON_PROFILE_FIELDS.has(field)) {
    return stableStringify(parseJsonValue(currentValue || '')) === stableStringify(parseJsonValue(nextValue || ''));
  }
  return String(currentValue ?? '') === String(nextValue ?? '');
}

function normalizeTagsForCompare(input) {
  return normalizeTagNames(input)
    .map((name) => name.toLowerCase())
    .sort();
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function markProfileChangeState(profile, changed) {
  if (profile && typeof profile === 'object') {
    Object.defineProperty(profile, '__changed', {
      value: Boolean(changed),
      enumerable: false,
      configurable: true
    });
  }
  return profile;
}

function updateProfile(id, data) {
  const updateData = data || {};
  // Scoped read, so an out-of-scope id is a silent no-op rather than a write. The
  // REST API forwards request bodies straight into here, and `team_id` is an
  // allowed field, so an unscoped update would let a caller retag another tenant's
  // profile and have it pushed to the platform.
  const scope = resolveActiveScope();
  const current = getDb().prepare('SELECT * FROM profiles WHERE id = ? AND owner_scope = ?').get(id, scope);
  if (!current) return null;
  const sets = [];
  const values = [];
  const hasTagsUpdate = Object.prototype.hasOwnProperty.call(updateData, 'tags');
  const fkFields = new Set(['folder_id', 'group_id', 'proxy_id']);
  const changedFields = [];
  
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
    'storage_state',
    'last_open_tabs',
    'notes',
    'start_page',
    'warmup_url',
    'status',
    'created_by',
    'running_on',
    'warmup_completed',
    'warmup_config'
  ];
  
  for (const field of allowedFields) {
    if (updateData[field] !== undefined) {
      const value = normalizeDbFieldValue(field, updateData[field], fkFields);
      if (!fieldValuesEqual(field, current[field], value, fkFields)) {
        sets.push(`${field} = ?`);
        values.push(value);
        changedFields.push(field);
      }
    }
  }

  let tagsChanged = false;
  if (hasTagsUpdate) {
    const currentTags = getProfileTags(id).map((tag) => tag.name);
    tagsChanged = !arraysEqual(normalizeTagsForCompare(currentTags), normalizeTagsForCompare(updateData.tags));
  }
  
  if (sets.length > 0) {
    if (changedFields.some((field) => CONTENT_MODIFIED_FIELDS.has(field))) {
      sets.push("modified_at = datetime('now')");
    }
    values.push(id);
    getDb().prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
  
  if (tagsChanged) {
    setProfileTags(id, updateData.tags);
    if (!changedFields.some((field) => CONTENT_MODIFIED_FIELDS.has(field))) {
      getDb().prepare("UPDATE profiles SET modified_at = datetime('now') WHERE id = ?").run(id);
    }
  }

  return markProfileChangeState(getProfile(id), sets.length > 0 || tagsChanged);
}

/**
 * Stamp the profile as launched right now.
 *
 * Deliberately NOT routed through updateProfile: launching is not a content edit,
 * so it must not touch modified_at and must not enqueue a platform sync. Uses
 * datetime('now') so the stored format matches every other timestamp column
 * (UTC, 'YYYY-MM-DD HH:MM:SS') that the renderer's formatTime() parses.
 */
function markProfileLaunched(id) {
  getDb().prepare("UPDATE profiles SET last_launched_at = datetime('now') WHERE id = ?").run(id);
}

function deleteProfile(id) {
  const scope = resolveActiveScope();
  return getDb().prepare('DELETE FROM profiles WHERE id = ? AND owner_scope = ?').run(id, scope);
}

/**
 * Scoped like getProfile. A remote_id is chosen by the platform, so without the
 * predicate a pull running under tenant B could match — and then overwrite —
 * tenant A's row if the two ever saw the same remote id.
 */
function getProfileByRemoteId(remoteId) {
  if (!remoteId) return null;
  const scope = resolveActiveScope();
  const row = getDb().prepare(`
    SELECT p.*, f.name as folder_name, g.name as group_name, pr.name as proxy_name, pr.type as proxy_type, pr.host as proxy_host, pr.port as proxy_port, pr.username as proxy_username, pr.password as proxy_password
    FROM profiles p
    LEFT JOIN folders f ON p.folder_id = f.id
    LEFT JOIN groups g ON p.group_id = g.id
    LEFT JOIN proxies pr ON p.proxy_id = pr.id
    WHERE p.remote_id = ? AND p.owner_scope = ?
  `).get(String(remoteId), scope);
  if (!row) return null;
  return attachTagsToProfiles([row])[0] || row;
}

function countProfilesUsingProxy(proxyId) {
  const numeric = Number(proxyId);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  const row = getDb().prepare('SELECT COUNT(*) AS count FROM profiles WHERE proxy_id = ?').get(numeric);
  return Number(row?.count) || 0;
}

// ---- CLOUD SYNC QUEUE ----
function enqueueProfileSync(action, payload = {}) {
  const result = getDb().prepare(`
    INSERT INTO profile_sync_queue (action, payload, status, retry_count, last_error, created_at, updated_at, owner_scope)
    VALUES (?, ?, 'pending', 0, '', datetime('now'), datetime('now'), ?)
  `).run(String(action || ''), JSON.stringify(payload || {}), resolveActiveScope());
  return getDb().prepare('SELECT * FROM profile_sync_queue WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Only the active tenant's pending work.
 *
 * runFullSync pushes the queue BEFORE pulling, using whatever token is currently
 * stored. Unscoped, that meant unfinished edits belonging to the previous tenant
 * were uploaded to the platform under the next tenant's identity on their first
 * sync after login.
 */
function listProfileSyncQueue(limit = 50) {
  const normalized = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 50;
  const scope = resolveActiveScope();
  return getDb().prepare(`
    SELECT *
    FROM profile_sync_queue
    WHERE status IN ('pending', 'failed') AND owner_scope = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(scope, normalized);
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

// Find a proxy by its connection details, or create a new one.
// Used during cloud pull to avoid duplicating proxy records.
function findOrCreateProxy(data) {
  const host = String(data.host || '').trim();
  const port = Number(data.port) || 0;
  const username = String(data.username || '');
  const type = String(data.type || 'http');
  const password = String(data.password || '');

  if (!host) return null;

  const existing = getDb().prepare(
    'SELECT * FROM proxies WHERE host = ? AND port = ? AND username = ? AND type = ? LIMIT 1'
  ).get(host, port, username, type);

  if (existing) {
    // Keep password up to date if it changed
    if (existing.password !== password) {
      return updateProxy(existing.id, { password });
    }
    return existing;
  }

  return createProxy({ name: host, type, host, port, username, password, ip_change_link: '' });
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
  markProfileLaunched,
  resolveActiveScope, adoptLegacyProfilesIntoScope, reconcileScopeRename, promoteScopeToTeamId,
  listTags, getProfileTags, setProfileTags,
  listProxies, createProxy, updateProxy, deleteProxy, findOrCreateProxy, countProfilesUsingProxy,
  listFolders, createFolder,
  listGroups, createGroup,
  getSetting, setSetting,
  enqueueProfileSync, listProfileSyncQueue, markProfileSyncDone, markProfileSyncFailed
};
