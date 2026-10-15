# Linux browser runtime for Outbound-Sales

Anty's server runs Chromium in Xvfb. It keeps each profile under
`/data/profiles/profile_<local-id>` and keeps the SQLite database in the same
persistent volume. Outbound resolves profiles by their cloud ID and attaches to
the existing persistent context over CDP. The Mac and its local database are no
longer involved in this mode.

The Docker entrypoint holds an exclusive kernel lock on this dedicated volume.
A second runtime using it exits before touching profile files. After a container
crash, only Chromium's stale singleton symlinks are removed; an actual process
using the same profile prevents recovery. The Compose hostname stays stable
across recreation, so local running flags can be recovered after a crash.

The API and CDP listen on container loopback. Compose publishes no ports. The
worker shares Anty's network namespace; do not expose port 3032 or Chrome CDP
through a public reverse proxy. Docker provides isolation; Chromium runs with
the existing root/no-sandbox policy inside the container. No privileged mode,
host network or Docker socket mount is needed.

## Install

Keep the `anty` and `Outbound-Sales` checkouts beside one another. The Outbound
checkout must include `agent/lib/anty-api.mjs` and `agent/Dockerfile`.

Create a private `.env` in the Anty checkout, excluded from git:

```dotenv
OUTBOUND_AGENT_DIR=../Outbound-Sales/agent
WARMUP_PORTAL=https://your-outbound-server.example
WARMUP_AGENT_TOKEN=use-the-same-private-token-as-the-portal
```

Set file permissions to 600. `WARMUP_AGENT_TOKEN` must already be configured on
the portal. It is never a LinkedIn password. If Docker Hub refuses the base image,
set `NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim`.

Start only the runtime first:

```sh
docker compose -f compose.linux.yml up -d --build anty
docker compose -f compose.linux.yml exec anty node -e "fetch('http://127.0.0.1:3032/health').then(r=>r.json()).then(console.log)"
```

## Import existing profiles

Close the source profile in Anty and Cloud Runner before copying it. A `ready`
badge alone is insufficient: a live Cloud Runner process may still use it. The
server worker must have exclusive use of its selected profiles. This deployment
does not coordinate the separate Cloud Runner's browser locks or continuously
sync imported copies back to the desktop platform.

Export only the approved profiles using the normal platform export or an
authorized admin export. The importer accepts:

```json
{
  "teamId": "your-team-id",
  "profiles": [{
    "remoteId": "cloud-profile-id",
    "teamId": "your-team-id",
    "name": "LinkedIn profile",
    "status": "ready",
    "runningOn": "",
    "fingerprint": { "userAgent": "the-existing-profile-UA" },
    "cookies": [],
    "storageState": { "cookies": [], "origins": [] },
    "proxy": { "type": "http", "host": "proxy-host", "port": 8080,
      "username": "proxy-user", "password": "proxy-password" },
    "startPage": "about:blank"
  }]
}
```

The file contains sessions and proxy passwords. Keep it outside the checkout
with permissions 600. With the runtime stopped, import through stdin:

```sh
docker compose -f compose.linux.yml stop anty
docker compose -f compose.linux.yml run --rm -T anty node scripts/import-linux-profiles.cjs < /private/path/profiles.json
docker compose -f compose.linux.yml up -d anty
```

Import is additive and transactional. Existing cloud IDs are skipped. Different
teams, duplicate IDs, running profiles and missing proxies are refused. A SQLite
backup is created before import. Cookies/localStorage are bootstrap data: later
launches use the on-disk Chrome profile instead of overwriting it with a stale
cloud snapshot. Imported cookies may have expired; a successful import is not
proof of a signed-in LinkedIn session.

## Check and start the worker

Build the worker without starting its scheduler. The following diagnostic opens
one selected profile, checks the proxy and login markers, then closes it. It
does not send connections, likes or messages, or open the messenger:

```sh
docker compose -f compose.linux.yml --profile worker build agent
docker compose -f compose.linux.yml --profile worker run --rm agent node check-anty.mjs --profile cloud-profile-id --linkedin
```

If login/checkpoint appears, leave that account's automation stopped and resolve
it manually. Optional manual access: create a VNC password with `x11vnc
-storepasswd /data/vnc.pass` inside the container, run x11vnc against `:99` with
`-rfbauth /data/vnc.pass -forever`, and connect through an SSH tunnel to the
container's private IP and VNC port. Do not publish the VNC port. Stop the worker
before a manual visit and close the profile afterwards.

Once the profile, portal token and recipient folders are configured:

```sh
docker compose -f compose.linux.yml --profile worker up -d agent
docker compose -f compose.linux.yml logs -f --tail 50 agent
```

The server still owns leases, schedule, warning pause, daily plans, the 60-per-seven-day
request cap and daily inbox sync. This browser migration changes none of those
rules. `run-account` closes the browser through Anty's API, allowing Anty to save
state before releasing the context. Owner tokens prevent cleanup from stopping
a profile started by another client.

When recreating `anty`, stop the worker first and recreate it afterwards: the
worker shares the runtime's network namespace. Keep both persistent volumes.
Never run `docker compose down -v` on the production store.

## Verification and recovery

Use a separate container and **empty test volume**, never production data:

```sh
docker exec your-test-container node scripts/test-linux-runtime.cjs
docker restart your-test-container
docker exec your-test-container node scripts/check-linux-restart.cjs
node --test scripts/test-web-launch.cjs
```

The fixture checks cookies, localStorage, IndexedDB, proxy routing, concurrent
launch exclusion and stop ownership. The restart check verifies the same state
after a container restart. With `ANTY_TEST_AGENT_ROOT` pointing at the installed
agent, the first fixture also checks Outbound's actual CDP adapter.

Before upgrades, stop the worker, then Anty, and back up the entire data volume,
including Chrome directories. Retain the previous image. Roll back by stopping
both services, restoring the backup to the stopped volume if needed, and starting
the previous image. A fixture pass does not prove live recipient selection or
CRM inbox writes; those need a supervised account run through the portal.
