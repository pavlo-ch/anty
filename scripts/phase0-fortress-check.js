/**
 * Phase 0 — validate a patched stealth Chromium against the sites that block anty
 * today, WITH CDP attached (the whole question). See docs/patched-chromium-plan.md.
 *
 * Works with either engine — pick by where you can run a native binary:
 *
 *   Fortress (Windows/Linux, free BSD-3):
 *     set ANTY_FORTRESS_PATH=C:\path\to\tilion.exe
 *     node scripts/phase0-fortress-check.js
 *
 *   CloakBrowser (native macOS arm64 — run this on the Mac):
 *     PHASE0_ENGINE=cloak PHASE0_BINARY=/path/to/cloak-chromium \
 *       node scripts/phase0-fortress-check.js
 *
 * It drives the binary exactly the way anty would — headed, over CDP, NO JS injection.
 * For Fortress it pushes the persona down as --uxr-* flags; CloakBrowser spoofs at the
 * engine level on its own (a stable seed is passed via --fingerprint).
 *
 * Optional: REBROWSER=0 to launch without rebrowser's addBinding patch, to see whether
 * the engine's stealth alone is enough (anty defaults to addBinding).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// Match anty's stack unless told otherwise. Fortress patches CDP leaks in the engine,
// so it's worth comparing with and without this.
if (process.env.REBROWSER !== '0') {
  process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE || 'addBinding';
}

const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright-core'));
const { generateFingerprint } = require(path.join(ROOT, 'src', 'main', 'fingerprint'));
const { buildFortressFlags } = require(path.join(ROOT, 'src', 'main', 'engine'));

const ENGINE = String(process.env.PHASE0_ENGINE || 'fortress').trim().toLowerCase();
const BINARY = String(process.env.PHASE0_BINARY || process.env.ANTY_FORTRESS_PATH || '').trim();
const OUT = path.join(ROOT, 'phase0-out');

const CHALLENGE_RE = /verify you are human|just a moment|checking your browser|performing security verification|attention required|unusual traffic|couldn.?t sign you in|browser or app may not be secure/i;

function ensureOut() {
  try { fs.mkdirSync(OUT, { recursive: true }); } catch (_) {}
}

async function shot(page, name) {
  const p = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

async function run() {
  if (!BINARY || !fs.existsSync(BINARY)) {
    console.error('No binary. Set ANTY_FORTRESS_PATH (Fortress) or PHASE0_BINARY (+ PHASE0_ENGINE=cloak).');
    process.exit(2);
  }
  ensureOut();

  // Persona. For Fortress force a Windows persona (its native builds are Win/Linux)
  // and push it down as --uxr flags. For CloakBrowser on a Mac, let the engine present
  // its own coherent (mac-native) persona; just pin a stable seed so the identity is
  // reproducible across launches, mirroring how anty keeps a fixed per-profile seed.
  const engineFlags = [];
  let personaNote;
  if (ENGINE === 'fortress') {
    let fp;
    do { fp = generateFingerprint(); } while (!/Windows/.test(fp.userAgent));
    engineFlags.push(...buildFortressFlags(fp));
    personaNote = fp.userAgent;
  } else {
    const seed = String(generateFingerprint().canvas?.noiseSeed || '0.42');
    engineFlags.push(`--fingerprint=${seed}`);
    personaNote = `CloakBrowser auto persona, seed=${seed}`;
  }

  console.log('engine:', ENGINE);
  console.log('binary:', BINARY);
  console.log('rebrowser addBinding:', process.env.REBROWSER === '0' ? 'OFF' : 'ON');
  console.log('persona:', personaNote);
  console.log('engine flags:', engineFlags.length);
  engineFlags.forEach((f) => console.log('   ', f));
  console.log('');

  const userDataDir = path.join(os.tmpdir(), `phase0-${Date.now()}`);
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: BINARY,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-infobars', '--no-first-run', '--no-default-browser-check',
      '--disable-quic', '--disable-features=AsyncDns,UseDnsHttpsSvcbAlpn',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--accept-lang=en-US,en;q=0.9', '--lang=en-US', '--window-size=1280,860',
      ...engineFlags,
    ],
    viewport: null,
    // NO addInitScript / userAgent override — the engine owns the persona.
  });

  const results = [];
  const page = ctx.pages()[0] || await ctx.newPage();

  // --- 1. CreepJS: fingerprint coherence / stealth ---
  try {
    await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(15000);
    const txt = (await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ');
    const trust = (txt.match(/([\d.]+)\s*%\s*trust/i) || [])[1];
    const lies = (txt.match(/(\d+)\s*lies/i) || [])[1];
    results.push({ target: 'CreepJS', signal: `trust=${trust ?? '?'}% lies=${lies ?? '?'}`, verdict: 'INSPECT SCREENSHOT', file: await shot(page, '1-creepjs') });
  } catch (e) { results.push({ target: 'CreepJS', signal: 'error: ' + e.message.split('\n')[0], verdict: 'ERROR' }); }

  // --- 2. blackhatworld: Cloudflare ---
  try {
    await page.goto('https://www.blackhatworld.com', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(15000);
    const title = await page.title().catch(() => '');
    const body = (await page.evaluate(() => document.body?.innerText || '').catch(() => ''));
    const blocked = CHALLENGE_RE.test(title) || CHALLENGE_RE.test(body);
    const home = /BlackHatWorld|Latest posts|Forums/i.test(body) || /Home \| BlackHatWorld/i.test(title);
    results.push({ target: 'blackhatworld', signal: `title="${title.slice(0, 40)}"`, verdict: blocked ? 'BLOCKED' : home ? 'PASS' : 'UNCLEAR', file: await shot(page, '2-blackhatworld') });
  } catch (e) { results.push({ target: 'blackhatworld', signal: 'error: ' + e.message.split('\n')[0], verdict: 'ERROR' }); }

  // --- 3. Google sign-in: does it reach the password step? ---
  try {
    await page.goto('https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn&hl=en', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(4000);
    const box = await page.waitForSelector('input#identifierId, input[name="identifier"], input[type="email"], input[type="text"]', { timeout: 15000 }).catch(() => null);
    if (box) {
      await box.fill(process.env.GTEST_EMAIL || 'antyprobe.nouser.9271@gmail.com');
      await page.click('#identifierNext button, #identifierNext, button:has-text("Next")').catch(async () => { await page.keyboard.press('Enter'); });
      await page.waitForTimeout(8000);
    }
    const url = page.url();
    const body = (await page.evaluate(() => document.body?.innerText || '').catch(() => ''));
    const hasPw = await page.$('input[type="password"]');
    const blocked = /rejected/i.test(url) || CHALLENGE_RE.test(body);
    const reachedPw = Boolean(hasPw) || /Enter your password|Wrong password|Couldn.?t find your Google Account/i.test(body);
    results.push({ target: 'Google sign-in', signal: `url=${/rejected/.test(url) ? 'REJECTED' : 'ok'} pw=${Boolean(hasPw)}`, verdict: blocked ? 'BLOCKED' : reachedPw ? 'PASS (reached identifier/password gate)' : 'UNCLEAR', file: await shot(page, '3-google') });
  } catch (e) { results.push({ target: 'Google sign-in', signal: 'error: ' + e.message.split('\n')[0], verdict: 'ERROR' }); }

  console.log('\n=== PHASE 0 RESULT ===');
  for (const r of results) {
    console.log(`${String(r.verdict).padEnd(38)} ${r.target.padEnd(16)} ${r.signal}`);
    if (r.file) console.log(`   screenshot: ${r.file}`);
  }
  console.log(`\nScreenshots in: ${OUT}`);
  console.log('Verdict guide: blackhatworld/Google must say PASS (not BLOCKED) — that is the whole point.');
  console.log('Compare a run with REBROWSER=0 to decide if addBinding is still needed.');

  // Cloudflare shows an INTERACTIVE checkbox that this script does not click. anty is
  // a human-driven browser, so the realistic test is a manual click: with PHASE0_HOLD=1
  // the browser stays open on the last page so you can click "Verify you are human"
  // and watch whether the forum actually loads.
  if (process.env.PHASE0_HOLD) {
    try { await page.goto('https://www.blackhatworld.com', { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (_) {}
    console.log('\nPHASE0_HOLD set — browser kept open on blackhatworld.');
    console.log('Click the "Verify you are human" checkbox by hand and see if the forum loads.');
    console.log('Ctrl+C here when done (the temp profile is left for you to inspect).');
    await new Promise(() => {}); // hold until Ctrl+C
  }

  await ctx.close().catch(() => {});
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
