/**
 * FB Connect — пункт «Connect Facebook to BlackAffiliate» у списку профілів Anty.
 *
 * Anty токена Facebook не бачить. Він бере в платформи одноразове посилання на офіційне
 * вікно згоди Meta (Facebook Login for Business), відкриває його в запущеному профілі — там
 * уже cookies цього Facebook — і далі лише питає статус. Токен отримує, шифрує й прив'язує до
 * команди профілю платформа. Контракт: docs/FB_CONNECT.md.
 *
 * Кнопка живе в інтерфейсі Anty, а не на сторінках Facebook: у вкладки нічого не
 * вбудовується.
 */
const EXPIRING_MS = 7 * 24 * 60 * 60 * 1000;

function defaultDeps() {
  const profileSync = require('./profile-sync');
  const { getProfile } = require('./database');
  return {
    remoteId: (profileId) => String(getProfile(profileId)?.remote_id || '').trim(),
    ticketUrl: () => profileSync.getFbConnectTicketUrl(),
    statusUrl: () => profileSync.getFbStatusUrl(),
    post: (url, payload) => profileSync.platformPost(url, payload),
  };
}

const UNSYNCED = { kind: 'unsynced', text: "This profile isn't synced to the platform yet — sync profiles first." };

/** Відповідь платформи (або збій запиту) → стан для інтерфейсу. */
function toState(result, now = Date.now()) {
  if (!result || !result.ok) {
    const status = Number(result?.status || 0);
    const code = result?.body?.error || result?.reason || '';
    if (result?.reason === 'not_logged_in' || status === 401) {
      return { kind: 'error', text: 'Sign in to BlackAffiliate in Anty first.' };
    }
    if (code === 'fb_not_configured' || status === 503) {
      return { kind: 'error', text: 'Facebook connection is not set up on the platform yet.' };
    }
    if (status === 403) return { kind: 'error', text: "This profile isn't in your team on the platform." };
    if (status === 404) return UNSYNCED;
    if (result?.reason === 'url_not_configured') {
      return { kind: 'error', text: 'Platform address is not configured in Anty.' };
    }
    return { kind: 'error', text: `Platform didn't answer${status ? ` (${status})` : ''}. Try again.` };
  }
  const b = result.body || {};
  const base = {
    fbUserName: b.fbUserName || null,
    adAccounts: Number(b.adAccounts || 0),
    expiresAt: b.expiresAt || null,
  };
  // Платформа віддає connected:false і для expired/revoked — статус поруч.
  if (!b.connected) {
    if (b.status === 'expired' || b.status === 'revoked') return { ...base, kind: 'expired' };
    return { ...base, kind: 'none' };
  }
  const left = base.expiresAt ? Date.parse(base.expiresAt) - now : Infinity;
  if (left <= 0) return { ...base, kind: 'expired' };
  if (left < EXPIRING_MS) return { ...base, kind: 'expiring' };
  return { ...base, kind: 'connected' };
}

async function getStatus(profileId, deps = defaultDeps()) {
  const remoteId = deps.remoteId(profileId);
  if (!remoteId) return UNSYNCED;
  return toState(await deps.post(deps.statusUrl(), { profileId: remoteId }));
}

/**
 * Бере посилання на вікно згоди й відкриває його в профілі через openUrl(profileId, url).
 * Профіль має бути вже запущений — це робить інтерфейс перед викликом.
 */
async function connect(profileId, openUrl, deps = defaultDeps()) {
  const remoteId = deps.remoteId(profileId);
  if (!remoteId) return { success: false, state: UNSYNCED };
  const result = await deps.post(deps.ticketUrl(), { profileId: remoteId });
  const url = result?.ok ? String(result.body?.url || '') : '';
  if (!/^https:\/\//.test(url)) {
    const state = result?.ok ? { kind: 'error', text: 'Platform returned no link. Try again.' } : toState(result);
    return { success: false, state };
  }
  const opened = await openUrl(profileId, url);
  if (!opened?.success) {
    return { success: false, state: { kind: 'error', text: `Couldn't open the Facebook window: ${opened?.error || 'unknown error'}` } };
  }
  return { success: true, state: { kind: 'waiting', text: 'Confirm access in the Facebook window…' } };
}

module.exports = { connect, getStatus, toState };
