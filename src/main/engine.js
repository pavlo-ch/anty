/**
 * Feature-flagged support for driving a patched, engine-level anti-detect Chromium
 * (Fortress — github.com/tiliondev/fortress) instead of the user's stock Chrome.
 *
 * WHY: stock Chrome + Playwright cannot hide the CDP attachment, so Cloudflare and
 * Google block it no matter the JS fingerprint (proven live — see
 * docs/patched-chromium-plan.md). Fortress corrects the fingerprint in Chromium's C++
 * — including a coherent JA3/JA4 TLS stack — so a page can't catch it and the JA4
 * finally matches the spoofed UA (which also fixes a Windows profile on a macOS host).
 *
 * STATUS: OFF by default and fully inert until BOTH are set:
 *   ANTY_ENGINE=fortress           — selects the engine
 *   ANTY_FORTRESS_PATH=/path/bin   — points at the Fortress Chromium binary
 * With the flag off, none of this runs and launches behave exactly as before. The
 * exact --uxr-* flag spellings below still need confirming against Fortress during
 * the Phase 0 evaluation before this is switched on for anyone.
 */
const fs = require('fs');
const { resolveChromeExecutable } = require('./chrome-binary');
const { parseUA } = require('./fingerprint');

function getActiveEngine() {
  return String(process.env.ANTY_ENGINE || '').trim().toLowerCase() === 'fortress' ? 'fortress' : 'chrome';
}

function resolveFortressExecutable() {
  const p = String(process.env.ANTY_FORTRESS_PATH || '').trim();
  return p && fs.existsSync(p) ? p : null;
}

/**
 * The executable to launch for a profile, honouring the engine flag. Falls back to
 * stock Chrome (with a warning) when Fortress is selected but its binary is missing,
 * so a half-configured flag can never brick launches.
 */
function resolveEngineExecutable() {
  if (getActiveEngine() === 'fortress') {
    const fortress = resolveFortressExecutable();
    if (fortress) return { engine: 'fortress', executablePath: fortress };
    console.warn('[Engine] ANTY_ENGINE=fortress but ANTY_FORTRESS_PATH is unset or missing — using stock Chrome');
  }
  return { engine: 'chrome', executablePath: resolveChromeExecutable() };
}

/**
 * Whether anty should still inject its JS fingerprint (buildInjectionScript).
 * Fortress spoofs at the engine level, so JS injection is both redundant and harmful
 * (it would re-introduce the detectable prototype-override layer this whole move is
 * meant to retire) — skip it under Fortress.
 */
function engineUsesJsInjection(engine) {
  return engine !== 'fortress';
}

const UA_PLATFORM = { Win: 'Windows', Mac: 'macOS', Linux: 'Linux', Android: 'Android', iOS: 'iOS' };
const NAV_PLATFORM = { Win: 'Win32', Mac: 'MacIntel', Linux: 'Linux x86_64' };

/**
 * Translate anty's per-profile fingerprint into Fortress --uxr-* switches. TLS/JA4 is
 * corrected by the engine automatically and so is deliberately absent here.
 *
 * Every value comes from the profile's own fingerprint, so the persona the engine
 * presents is the same one anty already assigns — just enforced in C++ instead of JS.
 *
 * Only the persona-defining surfaces are set here; OS platform-version, the browser
 * version, the exact Client-Hints and the TLS/JA4 shape are deliberately left to
 * Fortress's coherence engine, which derives them consistently from `ua-platform`.
 * Over-specifying those risks the very incoherence this move is meant to remove.
 * Flag names below are Fortress's documented `--uxr-*` set; the last confirmation is
 * a Phase 0 run against the real binary. (Notably NO `--uxr-ua-version` — the browser
 * version is fixed by which Fortress build ships, not a flag.)
 */
function buildFortressFlags(fingerprint) {
  const fp = fingerprint || {};
  const parsed = parseUA(fp.userAgent || '') || {};
  const osShort = parsed.osShort || 'Win';
  const isArm = UA_PLATFORM[osShort] === 'macOS' ? /arm/i.test(fp.platform || '') : false;

  const flags = [];
  const add = (name, value) => {
    if (value !== undefined && value !== null && value !== '') flags.push(`--uxr-${name}=${value}`);
  };

  // Identity — high-level persona; Fortress derives coherent CH/version/TLS from it.
  add('ua-platform', UA_PLATFORM[osShort]);       // Sec-CH-UA-Platform: Windows/macOS/Linux
  add('ua-arch', isArm ? 'arm' : 'x86');
  add('ua-bitness', '64');
  add('ua-brand', parsed.browser === 'Edge' ? 'Microsoft Edge' : 'Google Chrome');
  add('platform', NAV_PLATFORM[osShort]);          // navigator.platform: Win32/MacIntel/…

  // Hardware
  add('hw-concurrency', fp.hardware?.cpuCores);
  add('device-memory', fp.hardware?.memoryGb);

  // GPU
  add('webgl-vendor', fp.webgl?.vendor);
  add('webgl-renderer', fp.webgl?.renderer);

  // Deterministic per-profile noise seeds (reuse anty's existing seeds so the persona
  // is stable across launches, exactly as today)
  add('canvas-seed', fp.canvas?.noiseSeed);
  add('audio-seed', fp.audio?.noiseSeed);

  // Locale / screen / webrtc
  add('timezone', fp.locale?.timezone);
  add('languages', Array.isArray(fp.locale?.languages) ? fp.locale.languages.join(',') : fp.locale?.language);
  add('screen-width', fp.screen?.width);
  add('screen-height', fp.screen?.height);
  add('webrtc-policy', 'disable_non_proxied_udp');  // underscores — Fortress's documented form

  return flags;
}

module.exports = {
  getActiveEngine,
  resolveEngineExecutable,
  engineUsesJsInjection,
  buildFortressFlags,
};
