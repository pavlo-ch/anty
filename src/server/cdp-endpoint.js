const fs = require('node:fs/promises');
const path = require('node:path');

// Chromium chooses a free port; never reuse a stale file from the previous process.
async function readCdpEndpoint(userDataDir) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const [port, socketPath] = (await fs.readFile(file, 'utf8')).trim().split('\n');
      if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535 &&
          /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(socketPath)) {
        return `ws://127.0.0.1:${port}${socketPath}`;
      }
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Chromium did not publish its private CDP endpoint');
}

module.exports = { readCdpEndpoint };
