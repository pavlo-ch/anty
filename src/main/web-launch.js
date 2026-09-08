// Website hand-off. The installed process owns local Chrome; the manager window
// stays hidden unless login or another user action is required.
function parseLaunchUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'anty:' || url.hostname !== 'launch') return null;
    const id = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || url.searchParams.get('id');
    return /^[a-zA-Z0-9_-]{1,128}$/.test(id || '') ? id : null;
  } catch { return null; }
}

function createWebLaunchController({ auth, db, launcher, profileSync, isStaleRunningLock, getWindow, showError }) {
  const queue = [];
  const pending = new Set();
  let ready = false;
  let draining = false;
  async function launch(remoteId) {
    if (!auth.isLoggedIn()) throw new Error('Sign in to Anty Browser with the same account as the website, then click Launch on the website again.');
    // The website can only launch a cloud-synced profile, and the desktop keeps
    // that profile locally. Use it immediately instead of blocking every click
    // on a full cloud pull. A pull is needed only on the first launch of a profile
    // this installation has not seen yet.
    let profile = db.getProfileByRemoteId(remoteId);
    if (!profile) {
      let sync;
      for (let attempt = 0; attempt < 20; attempt++) {
        sync = await profileSync.runFullSync({ fullPull: true });
        if (sync.reason !== 'sync_in_progress') break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!sync?.pull?.ok) throw new Error('Could not sync profiles. Check your connection and account in Anty Browser, then try again.');
      profile = db.getProfileByRemoteId(remoteId);
    }
    if (!profile) throw new Error('This profile is not available in the signed-in account. Sign in to the same account as the website.');
    if (!launcher.getRunningProfiles().includes(profile.id)) {
      if (profile.status === 'running' && !isStaleRunningLock(profile)) {
        throw new Error('This profile is running on another device. Close it there before launching here.');
      }
      const result = await launcher.launchProfile(profile.id, getWindow());
      if (!result.success) throw new Error(result.error || 'Could not launch the profile.');
    }
    // Also acknowledge a repeat launch of an already running profile.
    const updated = db.markProfileLaunched(profile.id);
    if (updated) profileSync.onLocalProfileUpsert(updated);
    profileSync.scheduleSync(100);
  }
  async function drain() {
    if (!ready || draining) return;
    draining = true;
    try {
      while (queue.length) {
        const id = queue.shift();
        try { await launch(id); }
        catch (error) { showError(error.message || 'Could not launch the profile.'); }
        finally { pending.delete(id); }
      }
    } finally { draining = false; }
  }
  return {
    enqueue(url) {
      const id = parseLaunchUrl(url);
      if (!id) return false;
      if (!pending.has(id)) { pending.add(id); queue.push(id); }
      void drain();
      return true;
    },
    hasPending: () => pending.size > 0,
    start() { ready = true; return drain(); },
  };
}
module.exports = { parseLaunchUrl, createWebLaunchController };
