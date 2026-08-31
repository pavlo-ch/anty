# Cloud session — Phase 1

One profile, running headful on a virtual display inside a container, streamed
to a browser tab over noVNC.

**This phase exists to answer one question:** does a containerised session
survive detection that a desktop session survives? Nothing else should be built
on top until it does.

## Why it is shaped this way

Two decisions are load-bearing, both forced by `src/main/engine.js`:

**The stream captures the X display, not the page.** The obvious way to stream a
remote browser is a CDP screencast (`Page.startScreencast`). We cannot use it —
our own measurements say Cloudflare detects the CDP attachment itself, and no
fingerprint patch hides it. `x11vnc` reads framebuffer pixels instead, so Chrome
never knows it is being watched and the no-CDP paths keep working in here.

**It does not reuse `src/server/api.js`.** That server launches profiles outside
Electron already, but for automation: `headless: true`, `--enable-automation`,
and a CDP connection. Any one of those is a detection signal. A cloud session
has to be indistinguishable from a desktop one, so `cloud/session.js` takes the
GUI launch path instead.

It reaches that path without touching `launcher.js`. `launchProfile()` chooses
its mode from the second argument — `null`, or an object with `__serverMode`,
means the headless path; anything else truthy means the GUI path — and otherwise
only uses it to push status events. So a stand-in object with `isDestroyed()`
and `webContents.send()` gets the real GUI launch, unchanged.

## Build

```bash
docker build -f cloud/Dockerfile -t anty-cloud .
```

Build from the repo root, not from `cloud/` — the image copies `src/`.

Google publishes `google-chrome-stable` for both amd64 and arm64, so this builds
natively on an Apple Silicon machine as well as on an x86 server. Useful for
getting it running — but **run the detection comparison on the same architecture
as production**. CPU and GPU strings are fingerprint inputs, so an arm64 result
does not transfer to an amd64 host.

## Run

The profile must already exist in the mounted data directory, and it **must have
a proxy attached**. A proxy-less session would egress from the server itself,
exposing the datacenter IP to the target site and correlating every user on that
host; `session.js` refuses to launch one.

```bash
docker run --rm -it \
  -v anty-data:/data \
  -p 6080:6080 \
  --shm-size=1g \
  --security-opt seccomp=unconfined \
  anty-cloud <profileId|remoteId>
```

Then open `http://localhost:6080/vnc.html`.

Neither flag is optional, and both are worth understanding rather than copying:

**`--shm-size=1g`** — Chrome's default 64 MB of `/dev/shm` in a container causes
renderer crashes that read as random page failures.

**`--security-opt seccomp=unconfined`** — the GUI launch path strips
`--no-sandbox` on purpose (the flag is itself a detection signal), so Chrome uses
its namespace sandbox, which needs unprivileged user namespaces. Docker's default
seccomp profile blocks the `clone` call that requires. Without this you get
Chrome failing to start, which looks like a launcher bug and is not one.

`unconfined` is fine for a Phase 1 test on a machine you control and is **not**
acceptable in production — replace it with Chrome's own seccomp profile before
this runs anywhere real:

```bash
curl -O https://raw.githubusercontent.com/GoogleChrome/chrome-launcher/main/docs/chrome.json
docker run ... --security-opt seccomp=$(pwd)/chrome.json anty-cloud <id>
```

Do not "fix" a sandbox failure by adding `--no-sandbox`. It would start, and it
would fail detection — which is the one thing this phase is measuring.

## What to check, in order

Run each of these in the container **and** in a desktop session of the same
profile, and compare. A pass is "the container looks like the desktop", not "the
page loaded".

1. **Exit IP and geo** — `https://whoer.net`. Must show the proxy's IP and
   country. If it shows the server, the proxy did not apply and nothing else
   below is meaningful.
2. **Cloudflare** — any Cloudflare-gated site. This is the one the whole
   architecture is bent around.
3. **Google sign-in** — must not bounce to `/signin/rejected`.
4. **Fingerprint surface** — `https://creepjs.com`. Compare against desktop
   rather than chasing a score: fonts, GPU/WebGL renderer, and audio devices are
   where a Linux container most plausibly diverges.

## Known gaps

These are deliberate for Phase 1, not oversights.

- **No orchestration.** One container, one profile, started by hand. Session
  lifecycle, timeouts and reaping are Phase 3.
- **noVNC is unauthenticated.** VNC is bound to loopback and only noVNC is
  exposed, but anyone who reaches port 6080 reaches the session. The platform
  must terminate TLS and authenticate in front of it before this is exposed
  anywhere. Do not publish this port.
- **Fixed screen size.** `SCREEN_WIDTH`/`SCREEN_HEIGHT` default to 1920x1080 and
  are not read from the profile's fingerprint, so a profile claiming a different
  screen will contradict its own display. Worth fixing before the CreepJS
  comparison is taken as final.
- **The profile directory is not synced anywhere.** It lives in the mounted
  volume. Persisting cookies across sessions properly is Phase 3.
- **The Fortress engine is not in the image.** Only stock Chrome. If cloud
  sessions need engine-level spoofing, a Linux build of it has to be added and
  the detection checks re-run.
