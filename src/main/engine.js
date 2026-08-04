/**
 * Feature-flagged support for driving a patched, engine-level anti-detect Chromium
 * instead of the user's stock Chrome. Supports Fortress (github.com/tiliondev/fortress,
 * free BSD-3, native Win/Linux) and CloakBrowser (native macOS arm64).
 *
 * WHY, and what it does and does not buy (all measured — docs/patched-chromium-plan.md):
 *
 *  - GOOGLE SIGN-IN: solved. Stock Chrome + CDP is always bounced to /signin/rejected
 *    ("browser may not be secure"). With a patched engine the same CDP-driven browser
 *    reaches the password gate normally. This is the reason the feature exists.
 *
 *  - CLOUDFLARE (blackhatworld): NOT solved, and not solvable this way. Same IP, same
 *    hour: plain Chrome without CDP clears it, while a patched engine — headed, with
 *    engine-level spoofing, and a real human clicking the checkbox — is still blocked.
 *    Cloudflare detects the CDP attachment itself, which no fingerprint patch hides.
 *    Cloudflare-gated sites therefore stay on the no-CDP window (launcher's
 *    openProfileForManualLogin), regardless of which engine is selected here.
 *
 * STATUS: OFF by default and fully inert until BOTH are set:
 *   ANTY_ENGINE=fortress|cloak     — selects the engine
 *   ANTY_ENGINE_PATH=/path/to/bin  — the engine binary (ANTY_FORTRESS_PATH still works)
 * With the flag off, launches behave exactly as before.
 */
const fs = require('fs');
const { resolveChromeExecutable } = require('./chrome-binary');
const { parseUA } = require('./fingerprint');

const SUPPORTED = new Set(['fortress', 'cloak']);

/**
 * Which engine to drive.
 *
 * ANTY_ENGINE wins when set — including `ANTY_ENGINE=chrome`, which is the documented
 * way to turn the engine back off without uninstalling it.
 *
 * Otherwise: if a managed Fortress install is present, use it. Installing is an
 * explicit click in Settings, so having installed it IS the opt-in; making the user
 * also set an env var would mean the button appears to do nothing.
 */
function getActiveEngine() {
  const e = String(process.env.ANTY_ENGINE || '').trim().toLowerCase();
  if (e === 'chrome') return 'chrome';
  if (SUPPORTED.has(e)) return e;
  try {
    if (require('./engine-binary').resolveInstalledEngine()) return 'fortress';
  } catch (_) { /* fall through to stock Chrome */ }
  return 'chrome';
}

function resolveEngineBinary(engine) {
  // Explicit path wins — that is the developer/testing escape hatch.
  const p = String(process.env.ANTY_ENGINE_PATH || process.env.ANTY_FORTRESS_PATH || '').trim();
  if (p && fs.existsSync(p)) return p;
  // Otherwise use the copy anty manages itself, which is how it works for real users
  // (downloaded + checksum-verified on demand — see engine-binary.js).
  if (engine === 'fortress') {
    try { return require('./engine-binary').resolveInstalledEngine(); } catch (_) { return null; }
  }
  return null;
}

/**
 * The executable to launch for a profile, honouring the engine flag. Falls back to
 * stock Chrome (with a warning) when an engine is selected but its binary is missing,
 * so a half-configured flag can never brick launches.
 */
function resolveEngineExecutable() {
  const engine = getActiveEngine();
  if (engine !== 'chrome') {
    const bin = resolveEngineBinary(engine);
    if (bin) return { engine, executablePath: bin };
    console.warn(`[Engine] ANTY_ENGINE=${engine} selected but no engine binary is installed — using stock Chrome`);
  }
  return { engine: 'chrome', executablePath: resolveChromeExecutable() };
}

/**
 * Whether anty should still inject its JS fingerprint (buildInjectionScript).
 * A patched engine spoofs in C++, so JS injection is both redundant and harmful
 * (it would re-introduce the detectable prototype-override layer this whole move is
 * meant to retire) — skip it for any engine other than stock Chrome.
 */
function engineUsesJsInjection(engine) {
  return engine === 'chrome';
}

/**
 * Per-profile switches for the selected engine.
 *
 * Fortress takes an explicit persona (--uxr-*, mapped from anty's fingerprint).
 * CloakBrowser generates a coherent persona from a single seed instead, so it gets
 * anty's stable per-profile canvas seed — which keeps the identity fixed across
 * launches exactly as anty's own fingerprint does.
 */
function buildEngineFlags(engine, fingerprint) {
  if (engine === 'fortress') return buildFortressFlags(fingerprint);
  if (engine === 'cloak') {
    const seed = fingerprint?.canvas?.noiseSeed;
    return seed ? [`--fingerprint=${seed}`] : [];
  }
  return [];
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
  buildEngineFlags,
};
