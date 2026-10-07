#!/bin/sh
set -eu
umask 077
mkdir -p "$ANTY_DATA_DIR"
node scripts/unlock-linux-profiles.cjs
if [ "${ANTY_SERVER_HEADLESS:-false}" = false ]; then
  display_number="${DISPLAY#:}"
  display_number="${display_number%%.*}"
  case "$display_number" in ''|*[!0-9]*) echo 'Invalid X display' >&2; exit 1;; esac
  # A container restart retains /tmp but replaces its process namespace.
  # Old X lock files must not prevent the new display from starting.
  rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}"
  Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp &
  display_pid=$!
  attempts=0
  until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
    kill -0 "$display_pid" 2>/dev/null || { echo 'Xvfb exited' >&2; exit 1; }
    attempts=$((attempts + 1))
    [ "$attempts" -lt 50 ] || { echo 'Xvfb did not become ready' >&2; exit 1; }
    sleep 0.1
  done
fi
exec node src/server/api.js
