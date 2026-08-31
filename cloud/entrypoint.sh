#!/usr/bin/env bash
#
# Brings up the virtual display and the stream, then hands over to the session.
#
# The stream captures the X display rather than the page. That is the whole
# point: a CDP screencast would mean attaching CDP, which per src/main/engine.js
# is exactly what Cloudflare detects. x11vnc reads framebuffer pixels, so Chrome
# has no idea anyone is watching, and the no-CDP paths keep working in here.
set -euo pipefail

PROFILE_REF="${1:-${PROFILE_REF:-}}"
if [[ -z "$PROFILE_REF" ]]; then
  echo "usage: docker run ... <profileId|remoteId>   (or set PROFILE_REF)" >&2
  exit 2
fi

cleanup() {
  # Kill the pipe from the outside in so the session can flush its profile dir.
  [[ -n "${WEBSOCKIFY_PID:-}" ]] && kill "$WEBSOCKIFY_PID" 2>/dev/null || true
  [[ -n "${X11VNC_PID:-}" ]]     && kill "$X11VNC_PID" 2>/dev/null || true
  [[ -n "${XVFB_PID:-}" ]]       && kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "[entrypoint] Xvfb on ${DISPLAY} at ${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" -nolisten tcp &
XVFB_PID=$!

# Wait for the display rather than sleeping a fixed amount: Chrome started
# against a half-open display fails in ways that look like fingerprint bugs.
for _ in $(seq 1 50); do
  if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
if ! xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
  echo "[entrypoint] Xvfb did not come up on ${DISPLAY}" >&2
  exit 1
fi

# Loopback only. Exposing VNC itself would be a second, unauthenticated way into
# the session; the platform terminates TLS and authenticates in front of noVNC.
echo "[entrypoint] x11vnc on 127.0.0.1:5900"
x11vnc -display "${DISPLAY}" -localhost -rfbport 5900 \
       -forever -shared -nopw -quiet -noxdamage &
X11VNC_PID=$!

echo "[entrypoint] noVNC on 0.0.0.0:${NOVNC_PORT}"
websockify --web=/usr/share/novnc "0.0.0.0:${NOVNC_PORT}" 127.0.0.1:5900 &
WEBSOCKIFY_PID=$!

# The session owns the container's lifetime: when the browser closes, we exit.
exec node /app/cloud/session.js "$PROFILE_REF"
