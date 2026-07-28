/**
 * Locate the installed Google Chrome binary and read its real version.
 *
 * Why this exists: the TLS (JA3/JA4) and HTTP/2 (Akamai) fingerprints are produced
 * by the Chrome binary itself and cannot be altered from JS or launch flags —
 * measured directly: a bare launch and a fully-configured anty launch of the same
 * binary yield an identical JA4. So if the spoofed UA claims a different Chrome
 * version than the binary, every request carries a self-contradicting pair
 * (JA4 of Chrome X + UA of Chrome Y), which is exactly what Cloudflare and Google
 * challenge on. The spoofed version must therefore be pinned to the real binary,
 * and re-pinned whenever Chrome auto-updates.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const isWin = process.platform === 'win32';

function windowsChromePaths() {
  const pf64 = process.env['ProgramW6432'] || process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  return [
    `${pf64}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
    local ? `${local}\\Google\\Chrome\\Application\\chrome.exe` : '',
    `${pf64}\\Chromium\\Application\\chrome.exe`,
    `${pf86}\\Chromium\\Application\\chrome.exe`,
  ].filter(Boolean);
}

const CHROME_PATHS = isWin
  ? windowsChromePaths()
  : [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
    ];

/** Absolute path of the Chrome/Chromium binary, or null if none is installed. */
function resolveChromeExecutable() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function candidatePaths() {
  return CHROME_PATHS.slice();
}

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)\.(\d+)/;

/**
 * Windows chrome.exe writes nothing to stdout for --version, so read the version
 * from the versioned sibling directory Chrome keeps next to the executable
 * (…\Application\150.0.7871.187\). Highest version wins.
 */
function readWindowsVersion(exePath) {
  try {
    const appDir = path.dirname(exePath);
    const versions = fs
      .readdirSync(appDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && VERSION_RE.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    return versions[0] || null;
  } catch (_) {
    return null;
  }
}

function readPosixVersion(exePath) {
  try {
    const out = execFileSync(exePath, ['--version'], { timeout: 5000, encoding: 'utf8' });
    const m = String(out).match(VERSION_RE);
    return m ? m[0] : null;
  } catch (_) {
    return null;
  }
}

let cached = null;

/**
 * Real version of the installed Chrome, as { full: '150.0.7871.187', major: 150 }.
 * Returns null when Chrome is missing or the version cannot be read — callers must
 * then fall back to the fingerprint's own value rather than guessing.
 *
 * Cached for the process lifetime; a Chrome auto-update mid-session does not change
 * the already-running binary, and the next app start re-reads it.
 */
function getInstalledChromeVersion(executablePath) {
  if (cached !== null) return cached.value;

  const exe = executablePath || resolveChromeExecutable();
  if (!exe) {
    cached = { value: null };
    return null;
  }

  const full = isWin ? readWindowsVersion(exe) : readPosixVersion(exe);
  const m = full ? full.match(VERSION_RE) : null;
  cached = { value: m ? { full, major: parseInt(m[1], 10) } : null };
  if (!cached.value) {
    console.warn(`[ChromeBinary] Could not read Chrome version from ${exe} — falling back to fingerprint value`);
  }
  return cached.value;
}

/** Test seam: drop the memoised version so a fresh read happens. */
function resetVersionCache() {
  cached = null;
}

module.exports = {
  resolveChromeExecutable,
  candidatePaths,
  getInstalledChromeVersion,
  resetVersionCache,
};
