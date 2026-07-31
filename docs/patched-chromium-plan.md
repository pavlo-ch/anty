# Patched-Chromium direction — feasibility & plan

Goal the user set: browse Cloudflare-gated sites (blackhatworld) and sign in to
Google **with CDP automation AND full fingerprint spoofing active** — i.e. keep
everything anty does today, but stop getting blocked.

## Why the current architecture can't do this (proven this session)

anty drives the user's stock Google Chrome via Playwright/CDP. Measured, live:

- Bare CDP Chrome (zero spoofing) → blocked by blackhatworld's Cloudflare.
- Full anty (all JS spoofing) → blocked identically.
- A valid `cf_clearance` obtained in a no-CDP window → the CDP launch is
  re-challenged anyway (Cloudflare re-runs its check every request).
- Google sign-in → `/signin/rejected` regardless of fingerprint/version/IP.

The trigger is the **CDP attachment itself**, which JS and launch flags cannot hide.
Confirmed by external research: Cloudflare (Feb 2025) exploits a Chrome bug where a
CDP-dispatched mouse click reports iframe-relative `screenX/screenY` (<100) vs a real
click's main-frame coordinates — a CDP tell that stock Chrome + Playwright can't mask.

Plus a hard wall on the dev's Mac: the real binary's TLS/JA4 says macOS, so a
Windows-UA profile is incoherent (JA4=mac, UA=win) and Cloudflare withholds
clearance. Only an **engine-level** TLS spoof fixes that.

## The realistic path: adopt an existing patched Chromium (not build a fork)

Several BSD-3, open-source, **buildable-from-source** stealth Chromium projects
already do engine-level spoofing (C++, no JS layer) INCLUDING coherent JA3/JA4 TLS,
and ship as **drop-in Playwright replacements** — you keep CDP + all automation, just
point `executablePath` at their binary and pass per-profile fingerprint flags.

| Project | Chromium | Platforms | TLS/JA4 | Distribution | Notes |
|---|---|---|---|---|---|
| **Clearcote** (`clearcotelabs/clearcote-browser`) | 149 free / 150 pro | Win x64, Linux x64; **macOS + arm64 on roadmap, not yet** | JS+UA-CH+JA3/JA4+HTTP2 kept in agreement; claims CreepJS 0% | signed+SHA256 prebuilt, SDK auto-download (npm/PyPI), Docker, build-from-source (Linux) | most turnkey; **no Mac yet** |
| **Fortress** (tilion.dev) | n/a | unclear (Win persona default); build-from-source | BoringSSL → native coherent JA3/JA4; ~30 C++ surfaces; "cleared Turnstile" | rebuild from source, one script; `--uxr-*` per-profile flags | most transparent; platform TBD |
| **CloakBrowser** (`CloakHQ/CloakBrowser`) | n/a | check repo | source-level patches, coherent per-launch seed | drop-in Playwright | claims "passes every bot test" |

These map onto anty cleanly because anty already uses Playwright/CDP: the swap is
`chrome-binary.js` → point at the patched binary, and replace `buildInjectionScript`
(JS spoofing) with the engine's per-profile flags. Everything else (tab sync, proxy
bridge, cookies, IPC) is unchanged.

## Blockers / decisions the user must weigh

1. **macOS / Apple Silicon gap.** Clearcote is Win+Linux only (Mac on roadmap). The
   dev machine is Apple Silicon → the turnkey binary can't be tested there yet.
   anty's **Windows users** benefit immediately; Mac needs to wait for Clearcote's Mac
   build or a self-built Fortress-for-Mac (a full Chromium build — hours, complex).
2. **Trust / supply chain.** Today anty drives the user's OWN Chrome. Switching means
   shipping/downloading a third-party Chromium (~150–200 MB) to end users. Mitigate by
   **building from source in anty's CI** (all three are open + reproducible) and
   signing, rather than trusting a prebuilt binary.
3. **Verification before committing.** The "passes Cloudflare / CreepJS" claims must be
   re-tested against anty's ACTUAL targets (blackhatworld, Google login) with CDP
   attached — that's the whole question, and it must be proven, not trusted.
4. **Maintenance.** A patched build lags upstream Chromium. Need an update cadence and
   a fallback if a Chromium bump breaks the patches.

## Deep-dive: Fortress (chosen to investigate; strongest-founded)

`github.com/tiliondev/fortress` — BSD-3-Clause, engine-level (C++) fingerprint
correction, **34 readable patches** + `build/build.sh` that reproduces the binary
from Chromium source. Chromium 149 stable / 151 latest, **monthly upstream rebase**.
Public evidence (screenshots/gifs): CreepJS 0% headless / 0% stealth, Sannysoft 0
failed, Cloudflare Turnstile cleared live, Akamai cleared on aa.com/macys.com/etc.,
JA3/JA4 coherent via real BoringSSL. Playwright: `connect_over_cdp("http://localhost:9222")`.

**Platform matrix (the real blocker for anty, which needs Win + Mac):**

| Engine | Windows x64 | macOS arm64 |
|---|---|---|
| Fortress | native ✅ | **Docker only** (native `.app` "in progress") ❌ |
| Clearcote | native ✅ | roadmap ❌ |
| CloakBrowser (`CloakHQ/chromium-stealth-builds`, now `CloakHQ/cloakbrowser`) | ❌ | native arm64 ✅ |

No single project ships native Windows AND native macOS. Docker is not viable for a
desktop GUI app the user installs on their Mac.

**Fingerprint → Fortress flags maps almost 1:1** (integration is a direct translation,
not a rewrite):

| anty fingerprint field | Fortress flag |
|---|---|
| `userAgent` / platform | `--uxr-ua-platform` `--uxr-ua-os` `--uxr-ua-arch` `--uxr-ua-bitness` `--uxr-ua-brand` `--uxr-ua-version`, `--uxr-platform` |
| `hardware.cpuCores` | `--uxr-hw-concurrency` |
| `hardware.memoryGb` | `--uxr-device-memory` |
| `webgl.vendor` / `renderer` | `--uxr-webgl-vendor` / `--uxr-webgl-renderer` |
| `canvas.noiseSeed` | `--uxr-canvas-seed` |
| `audio.noiseSeed` | `--uxr-audio-seed` |
| `locale.timezone` | `--uxr-timezone` |
| `locale.languages` | `--uxr-languages` |
| `screen.*` | `--uxr-screen-*` |
| `webrtc` | `--uxr-webrtc-policy` |
| TLS/JA4 | automatic (engine-level, coherent — no anty work) |

This retires `buildInjectionScript` entirely and moves spoofing into the engine,
where a page can't catch it — and where JA4 finally matches the UA (fixing the
Windows-profile-on-Mac wall, because the engine presents a coherent Windows TLS stack
regardless of host OS).

**macOS options** (both platforms matter to the user):
- (a) Build Fortress natively for mac arm64 in anty's CI — Chromium builds on mac
  arm64, and Fortress is just 34 patches on top. Best trust + one engine for both
  platforms, but a real Chromium build: hours, ~100 GB, repeated on the monthly rebase.
- (b) Use CloakBrowser's native mac arm64 build for Mac + Fortress for Windows — two
  sources, more maintenance, less consistency, weaker trust (CloakBrowser less
  documented).
- (c) Windows-first now (Fortress ready), wait for Fortress's native mac `.app`.

## Proposed sequence

- **Phase 0 — Evaluate (days, low risk).** On a **Windows** box, drive Clearcote's
  binary via Playwright/CDP against blackhatworld, Google sign-in, CreepJS, iphey.
  This answers empirically: does CDP + engine-spoof actually pass? Do this before any
  integration. (Prefer build-from-source over prebuilt for trust.)
- **Phase 1 — Integrate (if Phase 0 passes).** Swap the driven binary in
  `chrome-binary.js`/`launcher.js`; map anty's profile fingerprint → the engine's
  seed/flags; retire `buildInjectionScript`. Keep Playwright/CDP/sync/proxy as-is.
- **Phase 2 — Distribution + platforms.** Windows first (binary available now). macOS
  blocked on Clearcote's Mac build or a self-built Chromium. Decide bundle vs
  on-demand download; wire signing/checksums; set an update cadence.

## Not doing

- Building a Chromium fork from scratch (weeks; unnecessary given the above).
- Downloading/running any third-party Chromium binary from inside this session
  (untrusted executable + wrong platform) — Phase 0 must run deliberately in a
  controlled Windows env by the team.

## Sources
- https://github.com/clearcotelabs/clearcote-browser
- https://tilion.dev/fortress
- https://github.com/CloakHQ/CloakBrowser
- https://ianlpaterson.com/blog/anti-detect-browser-benchmark-patchright-nodriver-curl-cffi/
- https://webscraper.io/blog/google-patches-100-precise-cloudflare-turnstile-bot-check (Cloudflare CDP screenX/screenY tell)
