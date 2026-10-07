#!/bin/sh
set -eu
umask 077
mkdir -p "$ANTY_DATA_DIR"
# Kernel lock survives exec and is released on crash. A second runtime must not
# touch profile files or the display while this store is in use.
exec flock -n -F "$ANTY_DATA_DIR/.runtime.lock" /usr/local/bin/anty-session-start
