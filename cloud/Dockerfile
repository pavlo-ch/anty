# Anty cloud session — one browser profile, headful, on a virtual display.
#
# The image deliberately runs real Google Chrome rather than Chromium: the
# fingerprint work in src/main/fingerprint.js aligns the spoofed persona to an
# installed Chrome build, and chrome-binary.js looks for /usr/bin/google-chrome.
#
# Everything here is a fingerprint surface. Fonts especially: a bare container
# ships almost none, and "this browser can render three typefaces" is a loud
# tell. The font packages below are not decoration.
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# ── Chrome, the virtual display, and the streaming pipe ──────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      google-chrome-stable \
      xvfb x11vnc novnc websockify \
      # x11-utils supplies xdpyinfo, which entrypoint.sh waits on rather than
      # racing Chrome against a half-open display.
      x11-utils \
      # Chrome's own runtime deps that the slim base omits.
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 \
      # Fingerprint surface — a realistic font set, including CJK and emoji.
      fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      # better-sqlite3 is compiled from source for plain Node here, not Electron.
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so edits to the app do not invalidate the install layer.
COPY package.json package-lock.json ./
# --ignore-scripts skips electron's postinstall download, which this image has
# no use for; better-sqlite3 is then built explicitly against Node's own ABI.
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild better-sqlite3 --build-from-source

COPY src ./src
COPY cloud ./cloud

# Chrome refuses to run as root without --no-sandbox, and the launcher only adds
# that flag when it detects uid 0. Running unprivileged keeps the sandbox on,
# which is both safer and one less difference from a desktop session.
RUN useradd --create-home --shell /bin/bash anty \
 && mkdir -p /data \
 && chown -R anty:anty /app /data
USER anty

# Where profiles and the SQLite database live; mount a volume here to keep
# cookies and storage across sessions.
ENV ANTY_DATA_DIR=/data \
    DISPLAY=:99 \
    SCREEN_WIDTH=1920 \
    SCREEN_HEIGHT=1080 \
    SCREEN_DEPTH=24 \
    NOVNC_PORT=6080

EXPOSE 6080

ENTRYPOINT ["/app/cloud/entrypoint.sh"]
