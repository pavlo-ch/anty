// Warmup engine — simulates organic browsing on a fresh profile to build
// a realistic cookie history (NID, CONSENT, session cookies, _ga, etc).
// This dramatically lowers bot-detection scores on Google/Cloudflare/etc
// because a fresh profile with ZERO browsing history is itself a strong bot signal.

/**
 * Curated whitelist of warmup sites.
 *
 * Selection criteria:
 *  - Stable (no 5xx / random downtime)
 *  - No login required to read content
 *  - Sets realistic first-party cookies
 *  - Diverse traffic profile (news, shopping, tech, entertainment, travel, ref)
 *  - Low risk of CAPTCHA on fresh IPs
 *
 * Excluded from the raw pool (on purpose):
 *  - google.com/* — fresh IPs get CAPTCHA here; we want warmup BEFORE touching Google
 *  - cloudflare.com — CF does its own challenge
 *  - openai.com — login required
 *  - rt.com — geo-blocked in many regions
 *  - blogspot.com / wordpress.com — multi-tenant roots 404 without subdomain
 *  - phoronix.com / lwn.net / tuxmachines.org / digitalcitizen.help — too niche
 *  - regional news (20minutos.es, eluniversal.com.mx, thelocal.com) —
 *    suspicious if timezone doesn't match
 *
 * `recommended: true` means it's ticked by default in the UI.
 */
const WARMUP_SITES = [
  // ── NEWS (broad reach, rich cookies, neutral) ─────────────────────────────
  { url: 'https://en.wikipedia.org/wiki/Special:Random', category: 'reference',   recommended: true,  label: 'Wikipedia' },
  { url: 'https://www.bbc.com',                           category: 'news',        recommended: true,  label: 'BBC' },
  { url: 'https://www.cnn.com',                           category: 'news',        recommended: true,  label: 'CNN' },
  { url: 'https://www.theguardian.com',                   category: 'news',        recommended: false, label: 'The Guardian' },
  { url: 'https://www.reuters.com',                       category: 'news',        recommended: false, label: 'Reuters' },
  { url: 'https://www.washingtonpost.com',                category: 'news',        recommended: false, label: 'Washington Post' },
  { url: 'https://www.forbes.com',                        category: 'business',    recommended: false, label: 'Forbes' },
  { url: 'https://www.usatoday.com',                      category: 'news',        recommended: false, label: 'USA Today' },
  { url: 'https://www.npr.org',                           category: 'news',        recommended: false, label: 'NPR' },
  { url: 'https://news.yahoo.com',                        category: 'news',        recommended: true,  label: 'Yahoo News' },

  // ── SHOPPING (session cookies, long-lived identifiers) ────────────────────
  { url: 'https://www.amazon.com',                        category: 'shopping',    recommended: true,  label: 'Amazon' },
  { url: 'https://www.ebay.com',                          category: 'shopping',    recommended: false, label: 'eBay' },
  { url: 'https://www.etsy.com',                          category: 'shopping',    recommended: false, label: 'Etsy' },

  // ── ENTERTAINMENT / MEDIA ─────────────────────────────────────────────────
  { url: 'https://www.imdb.com',                          category: 'entertainment', recommended: true,  label: 'IMDb' },
  { url: 'https://www.rottentomatoes.com',                category: 'entertainment', recommended: false, label: 'Rotten Tomatoes' },
  { url: 'https://www.metacritic.com',                    category: 'entertainment', recommended: false, label: 'Metacritic' },
  { url: 'https://www.rollingstone.com',                  category: 'entertainment', recommended: false, label: 'Rolling Stone' },

  // ── TECH (clean, less ad-heavy) ───────────────────────────────────────────
  { url: 'https://www.apple.com',                         category: 'tech',        recommended: true,  label: 'Apple' },
  { url: 'https://www.microsoft.com',                     category: 'tech',        recommended: false, label: 'Microsoft' },
  { url: 'https://stackoverflow.com',                     category: 'tech',        recommended: false, label: 'Stack Overflow' },
  { url: 'https://www.techcrunch.com',                    category: 'tech',        recommended: false, label: 'TechCrunch' },
  { url: 'https://www.theverge.com',                      category: 'tech',        recommended: false, label: 'The Verge' },
  { url: 'https://www.wired.com',                         category: 'tech',        recommended: false, label: 'Wired' },
  { url: 'https://www.cnet.com',                          category: 'tech',        recommended: false, label: 'CNET' },
  { url: 'https://www.engadget.com',                      category: 'tech',        recommended: false, label: 'Engadget' },

  // ── UTILITY / REFERENCE (low-risk, normal behavior) ───────────────────────
  { url: 'https://weather.com',                           category: 'utility',     recommended: true,  label: 'Weather.com' },
  { url: 'https://www.webmd.com',                         category: 'utility',     recommended: false, label: 'WebMD' },

  // ── TRAVEL ────────────────────────────────────────────────────────────────
  { url: 'https://www.booking.com',                       category: 'travel',      recommended: false, label: 'Booking.com' },
  { url: 'https://www.tripadvisor.com',                   category: 'travel',      recommended: false, label: 'TripAdvisor' },

  // ── SPORTS ────────────────────────────────────────────────────────────────
  { url: 'https://www.espn.com',                          category: 'sports',      recommended: false, label: 'ESPN' },
  { url: 'https://www.nba.com',                           category: 'sports',      recommended: false, label: 'NBA' },
];

const DEFAULT_CONFIG = {
  enabled: true,
  sitesCount: 7,         // how many sites to visit (randomly picked from the selected pool)
  secondsPerSite: 20,    // average time per site (randomized ±30% at runtime)
  simulateScroll: true,  // scroll through the page while waiting
  randomizeOrder: true,
  randomizeSites: true,  // pick random sites from pool each time instead of fixed list
  sites: WARMUP_SITES.filter((s) => s.recommended).map((s) => s.url),
};

function getDefaultConfig() {
  return { ...DEFAULT_CONFIG, sites: [...DEFAULT_CONFIG.sites] };
}

function getWarmupSites() {
  return WARMUP_SITES.map((s) => ({ ...s }));
}

function normalizeConfig(raw) {
  const base = getDefaultConfig();
  if (!raw || typeof raw !== 'object') return base;
  return {
    enabled: raw.enabled !== false,
    sitesCount: clamp(parseInt(raw.sitesCount, 10) || base.sitesCount, 1, 30),
    secondsPerSite: clamp(parseInt(raw.secondsPerSite, 10) || base.secondsPerSite, 5, 180),
    simulateScroll: raw.simulateScroll !== false,
    randomizeOrder: raw.randomizeOrder !== false,
    randomizeSites: raw.randomizeSites !== false,
    sites: Array.isArray(raw.sites) && raw.sites.length > 0
      ? raw.sites.filter((u) => typeof u === 'string' && u.startsWith('http'))
      : base.sites,
  };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Run a warmup session in the given browser context.
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {object} config — as returned by normalizeConfig()
 * @param {(progress: {index: number, total: number, url: string, status: string}) => void} [onProgress]
 */
async function runWarmup(context, config, onProgress) {
  const cfg = normalizeConfig(config);

  // If randomizeSites is enabled, pick random sites from the pool instead of fixed list
  let sitesToUse = cfg.sites;
  if (cfg.randomizeSites) {
    const availableSites = WARMUP_SITES.filter(s => s.recommended).map(s => s.url);
    sitesToUse = [];
    const pool = [...availableSites];
    for (let i = 0; i < cfg.sitesCount && pool.length > 0; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      sitesToUse.push(pool[idx]);
      pool.splice(idx, 1); // Remove to avoid duplicates
    }
  }

  const pool = cfg.randomizeOrder ? shuffle(sitesToUse) : sitesToUse;
  const targets = pool.slice(0, cfg.sitesCount);

  console.log(`[Warmup] Starting: ${targets.length} sites, ~${cfg.secondsPerSite}s each`);

  const page = await context.newPage();

  for (let i = 0; i < targets.length; i++) {
    const url = targets[i];
    const progress = { index: i + 1, total: targets.length, url, status: 'navigating' };
    onProgress?.(progress);

    try {
      console.log(`[Warmup] ${i + 1}/${targets.length} → ${url}`);
      await page.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' }).catch((e) => {
        console.log(`[Warmup]   goto failed: ${e.message}`);
      });

      // Randomize time per site ±30% to look organic
      const jitter = 1 + (Math.random() - 0.5) * 0.6;
      const dwellMs = Math.round(cfg.secondsPerSite * 1000 * jitter);

      if (cfg.simulateScroll) {
        await humanScroll(page, dwellMs).catch(() => {});
      } else {
        await page.waitForTimeout(dwellMs).catch(() => {});
      }

      onProgress?.({ ...progress, status: 'done' });
    } catch (e) {
      console.log(`[Warmup]   error on ${url}: ${e.message}`);
      onProgress?.({ ...progress, status: 'error' });
    }
  }

  await page.close().catch(() => {});
  console.log('[Warmup] Complete');
}

/**
 * Simulate a human scrolling: intermittent small scrolls, occasional pauses,
 * sometimes scrolling back up. Fills roughly `totalMs` of dwell time.
 */
async function humanScroll(page, totalMs) {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    const remaining = totalMs - (Date.now() - start);
    if (remaining <= 0) break;

    // Random scroll: 80% down, 15% up, 5% pause
    const r = Math.random();
    if (r < 0.8) {
      const delta = 100 + Math.floor(Math.random() * 400);
      await page.mouse.wheel(0, delta).catch(() => {});
    } else if (r < 0.95) {
      const delta = -(50 + Math.floor(Math.random() * 200));
      await page.mouse.wheel(0, delta).catch(() => {});
    }
    // pause 800–2500 ms
    const pause = Math.min(remaining, 800 + Math.floor(Math.random() * 1700));
    await page.waitForTimeout(pause).catch(() => {});
  }
}

module.exports = {
  WARMUP_SITES,
  DEFAULT_CONFIG,
  getDefaultConfig,
  getWarmupSites,
  normalizeConfig,
  runWarmup,
};
