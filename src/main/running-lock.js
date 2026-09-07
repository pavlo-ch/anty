// The 'running' lock on a profile (status + running_on) is what shows a teammate the
// "In use" badge and blocks a second launch. It is only meaningful while another
// machine is ACTIVELY using the profile. Everything else is a stale lock: a crash, a
// force-quit, the app being killed, a renamed host, or a client that set the lock
// without stamping a launch time. Every reader of the lock — launch guard, cloud pull,
// the profile list the UI renders — must judge it with the same rule, otherwise the
// launch button and the badge disagree (launch allowed, badge still says "In use").
const os = require('os');

const STALE_RUNNING_LOCK_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * A 'running' lock is stale — and may be ignored or taken over — when no machine is
 * credibly using the profile: no owner, our own host (we know what runs here), no launch
 * timestamp behind it, or a timestamp older than 12 hours.
 */
function isStaleRunningLock(profile) {
  if (!profile) return true;
  const owner = String(profile.running_on || '').trim();
  if (!owner) return true;
  if (owner === os.hostname()) return true;
  if (!profile.last_launched_at) return true;
  const launched = Date.parse(profile.last_launched_at);
  if (Number.isFinite(launched) && (Date.now() - launched) > STALE_RUNNING_LOCK_AFTER_MS) return true;
  return false;
}

/**
 * The profile as the UI should see it: a stale lock reads as 'ready' with no owner.
 * Pure — returns a copy, never writes the row. Profiles running on this very machine
 * are reported by the launcher itself and are left alone.
 */
function withoutStaleRunningLock(profile, { runningLocally = false } = {}) {
  if (!profile || profile.status !== 'running' || runningLocally) return profile;
  if (!isStaleRunningLock(profile)) return profile;
  return { ...profile, status: 'ready', running_on: '' };
}

module.exports = { STALE_RUNNING_LOCK_AFTER_MS, isStaleRunningLock, withoutStaleRunningLock };
