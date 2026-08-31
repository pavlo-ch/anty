#!/usr/bin/env node
/**
 * One cloud browser session.
 *
 * Runs a profile the same way the desktop GUI does — headful, through the
 * profile's own proxy — except the display is an Xvfb screen instead of a real
 * one, so the pixels can be streamed to a browser tab.
 *
 * WHY NOT THE EXISTING HEADLESS SERVER MODE
 * src/server/api.js already launches profiles outside Electron, but it is built
 * for automation, not for browsing: it asks for `headless: true`, passes
 * `--enable-automation`, and drives the browser over CDP. Each of those is a
 * detection signal on its own, and per src/main/engine.js the CDP attachment is
 * specifically what Cloudflare catches — no fingerprint patch hides it. A cloud
 * session has to look exactly like a desktop one, so it takes the GUI path.
 *
 * HOW IT REUSES THE GUI PATH UNCHANGED
 * launchProfile() picks its mode from the second argument: null, or an object
 * carrying `__serverMode`, selects the headless automation path; anything else
 * truthy takes the GUI path. Beyond that it only ever uses the argument to push
 * status events at a renderer. So a small stand-in object — no `__serverMode`,
 * with the two methods the launcher calls — gets the real GUI launch with no
 * changes to launcher.js at all.
 */

// Must be set before requiring anything that might reach for electron.
process.env.ANTY_SERVER_MODE = '1';

const {
  initDatabase,
  getProfile,
  getProfileByRemoteId,
} = require('../src/main/database');
const launcher = require('../src/main/launcher');

/**
 * Stands in for Electron's BrowserWindow.
 *
 * Deliberately does NOT set __serverMode: that flag would send launchProfile
 * down the headless automation path this session exists to avoid.
 */
function createStatusSink() {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => {
        // Phase 2 forwards these to the platform; for now they are the session log.
        console.log(`[session] ${channel} ${JSON.stringify(payload || {})}`);
      },
    },
  };
}

/** A profile is addressed by local row id, or by the platform's remote id. */
function resolveProfile(ref) {
  if (/^\d+$/.test(ref)) {
    const byLocalId = getProfile(Number(ref));
    if (byLocalId) return byLocalId;
  }
  return getProfileByRemoteId(ref);
}

/**
 * A session with no proxy would egress from the datacenter, exposing our IP to
 * the target site and correlating every user who lands on the same host. That
 * is worse than not launching, so it is refused rather than warned about.
 */
function assertHasProxy(profile) {
  if (profile.proxy_host) return;
  throw new Error(
    `Profile ${profile.id} ("${profile.name}") has no proxy. A cloud session would ` +
    'egress from the server itself — attach a proxy before launching it here.'
  );
}

async function main() {
  const ref = String(process.argv[2] || '').trim();
  if (!ref) {
    console.error('Usage: node cloud/session.js <profileId|remoteId>');
    process.exit(2);
  }

  if (!process.env.DISPLAY) {
    console.error('DISPLAY is unset — start Xvfb first (see cloud/entrypoint.sh).');
    process.exit(2);
  }

  initDatabase();

  const profile = resolveProfile(ref);
  if (!profile) {
    console.error(`No profile matches "${ref}".`);
    process.exit(1);
  }
  assertHasProxy(profile);

  console.log(
    `[session] launching profile ${profile.id} ("${profile.name}") on ${process.env.DISPLAY} ` +
    `via ${profile.proxy_type || 'http'}://${profile.proxy_host}:${profile.proxy_port || ''}`
  );

  const result = await launcher.launchProfile(profile.id, createStatusSink());
  if (!result || !result.success) {
    console.error(`[session] launch failed: ${(result && result.error) || 'unknown error'}`);
    process.exit(1);
  }

  console.log('[session] browser is up — streaming whatever is on the X display');

  // Stop the profile cleanly when the container is asked to shut down, so the
  // Chrome profile directory is flushed rather than killed mid-write.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[session] ${signal} — stopping profile ${profile.id}`);
    try {
      await launcher.stopProfile(profile.id);
    } catch (error) {
      console.error(`[session] stop failed: ${error.message}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Hold the container open for as long as the browser lives. When the user
  // closes the last window the launcher drops it from the running set, and the
  // session — and so the container — is done.
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (shuttingDown) return;
      if (!launcher.getRunningProfiles().includes(profile.id)) {
        clearInterval(poll);
        resolve();
      }
    }, 2000);
  });

  console.log('[session] browser closed — exiting');
  process.exit(0);
}

main().catch((error) => {
  console.error(`[session] ${error.message}`);
  process.exit(1);
});
