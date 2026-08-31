# Handoff prompt — get the cloud session container working

Paste everything below into an AI coding agent that has a working container
runtime. It is written to be self-contained.

---

## Your task

Get `cloud/` in this repo to build and run, then answer one question with
evidence: **does a browser profile running inside this container survive bot
detection as well as the same profile running on the desktop app?**

That question is the whole point. A container that builds and shows a web page
is not success. Success is a side-by-side comparison against a desktop session.

## What this project is

Anty Browser is an anti-detect browser for affiliate media buying. Users keep
"profiles" — each with its own fingerprint (user agent, screen, timezone, fonts,
locale) and its own proxy — and run ad accounts in them. The product's entire
value is that a profile looks like a real, distinct person to sites like
Facebook, Google and Cloudflare.

It ships today as an Electron desktop app (`src/main/`). There is also a web
build of the same UI hosted on the platform, which can manage profiles but
cannot launch them — a web page cannot start a Chrome process. The work in
`cloud/` is the first phase of fixing that by running the browser on a server
and streaming it to the user's tab.

## What already exists in `cloud/`

Four files, none of which have ever been built or run:

- `Dockerfile` — Debian + Google Chrome + Xvfb + x11vnc + noVNC + Node
- `entrypoint.sh` — starts the virtual display and the stream, then the session
- `session.js` — launches one profile on that display and holds the container open
- `README.md` — build/run instructions and the detection checklist

## Two decisions you must not undo

Both are forced by findings already documented in `src/main/engine.js`, which
came from live measurement against real sites. Read that file before changing
anything in `cloud/`.

**1. The stream captures the X display, not the page.**

The obvious way to stream a remote browser is a CDP screencast
(`Page.startScreencast`). It is unusable here. Cloudflare detects the CDP
attachment itself — not the fingerprint, not the IP, the attachment — and no
fingerprint patch hides it. Google sign-in behaves the same way, bouncing
CDP-driven browsers to `/signin/rejected`.

So the container runs `x11vnc`, which reads framebuffer pixels from Xvfb. Chrome
has no idea anyone is watching. If you find yourself reaching for CDP to make
streaming easier, you are undoing the reason this design exists.

**2. Chrome keeps its sandbox; `--no-sandbox` is never the fix.**

The desktop GUI launch path deliberately strips `--no-sandbox` (see
`ignoreDefaultArgs` in `launcher.js`) because the flag is itself a detection
signal. In a container this means Chrome uses its namespace sandbox, which needs
unprivileged user namespaces that Docker's default seccomp profile blocks.

**Chrome failing to start in the container is the expected first failure.** It
looks like a launcher bug. It is not. Fix it with seccomp
(`--security-opt seccomp=unconfined` for a local test, Chrome's own `chrome.json`
profile for anything real). If you "fix" it by adding `--no-sandbox`, the
container will start and will fail the detection test — which is the one thing
this phase measures.

## How it reuses the desktop launcher

`launcher.js` is on `playwright-core` and touches Electron in exactly one place
(`app.getPath('userData')`, which already honours the `ANTY_DATA_DIR` env var).
So the real launch code runs unmodified outside Electron.

`launchProfile(profileId, mainWindow)` picks its mode from the second argument:

- `null`, or an object with `__serverMode: true` → headless automation path
- anything else truthy → GUI path: headful, no `--enable-automation`, no CDP driving

Beyond that it only uses the argument to push status events. So `session.js`
passes a small stand-in with `isDestroyed()` and `webContents.send()` and
deliberately **no** `__serverMode`, and gets the real GUI launch with zero
changes to `launcher.js`. Keep it that way — forking the launch logic would mean
the detection result no longer says anything about the real product.

**Do not reuse `src/server/api.js`.** It already launches profiles outside
Electron, but it is built for automation: `headless: true`,
`--enable-automation`, and a CDP connection. Every one of those is a detection
signal.

## What is verified and what is not

Verified (statically, without a runtime):

- All apt package names exist in Debian bookworm
- `/usr/share/novnc/vnc.html` exists, so the noVNC path and URL are right
- `node:20-bookworm-slim` exists; `google-chrome-stable` is published for both
  amd64 and arm64
- `launcher.js` and `database.js` load outside Electron with `ANTY_SERVER_MODE=1`
- The mode-selection branch sends the stand-in object down the GUI path
- Shell, JS and Dockerfile syntax

**Not verified — nobody had a container runtime.** The image has never been
built. Assume the Dockerfile needs fixing. Specifically unknown:

- whether `npm ci --omit=dev --ignore-scripts` + `npm rebuild better-sqlite3
  --build-from-source` produces a working native module
- whether Chrome starts as the non-root `anty` user under seccomp
- whether the proxy actually applies to traffic
- whether Xvfb, x11vnc and websockify come up in the right order
- whether the session survives being streamed

## Steps

1. Build: `docker build -f cloud/Dockerfile -t anty-cloud .` (from the repo root).
   Fix what breaks. Report what you changed and why.
2. You need a profile in the mounted data volume **with a proxy attached**.
   `session.js` refuses a proxy-less profile on purpose: a cloud session with no
   proxy egresses from the server, exposing the datacenter IP to the target site
   and correlating every user on that host. Do not remove that check.
3. Run it (flags and reasons are in `cloud/README.md`), open
   `http://localhost:6080/vnc.html`, confirm you can see and drive the browser.
4. Run the comparison below.

## The comparison that decides go/no-go

Run each check **in the container and in a desktop session of the same profile**,
and report both results side by side. "The page loaded" is not a result.

1. **Exit IP and geo** — `https://whoer.net`. Must show the proxy's IP and
   country. If it shows the server, the proxy did not apply and nothing else
   below means anything.
2. **Cloudflare** — any Cloudflare-gated site. This is what the architecture is
   bent around.
3. **Google sign-in** — must not bounce to `/signin/rejected`.
4. **Fingerprint surface** — `https://creepjs.com`. Compare against desktop
   rather than chasing a score. Fonts, WebGL/GPU renderer and audio devices are
   where a Linux container most plausibly diverges from a desktop machine.

Run the comparison on the **same CPU architecture as production**. CPU and GPU
strings are fingerprint inputs, so a clean arm64 result says nothing about an
amd64 host.

## Deliberate gaps — do not "fix" these

They belong to later phases. Adding them now buys nothing until the detection
question is answered.

- No orchestration: one container, one profile, started by hand.
- noVNC is unauthenticated. VNC is loopback-only and only noVNC is exposed, but
  anyone reaching port 6080 reaches the session. Do not publish that port; the
  platform will terminate TLS and authenticate in front of it.
- Screen size is fixed at 1920x1080 and not read from the profile's fingerprint,
  so a profile claiming another size contradicts its own display. Worth fixing
  before treating the CreepJS result as final — but flag it, don't redesign.
- The profile directory is not synced anywhere; it lives in the mounted volume.
- The patched "Fortress" engine is not in the image, only stock Chrome.

## What to report back

- What you changed to make the build work, and why
- The four checks, container vs desktop, side by side
- Your verdict: does a containerised session hold up as well as a desktop one?
- If it does not: which signal gave it away, and is that fixable in the container
  or fatal to the approach?

Be accurate about what you actually ran versus what you assume. If you could not
run something, say so plainly rather than reporting it as passing.
