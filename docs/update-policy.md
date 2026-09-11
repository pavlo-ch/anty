# Optional vs mandatory updates

By default every release is **optional**: the app notices it, lights up
**Update Now** in Settings, and otherwise stays out of the way. Nothing pops up at
launch and nothing downloads on its own.

A release becomes **mandatory** only when you say so.

## Making a release mandatory

Edit `build/update-policy.json` on `main` and set the version you want to force:

```json
{ "mandatoryMinVersion": "1.3.0" }
```

Commit and push. That is the whole step — no rebuild, no new release.

Anyone running a version **older than** `mandatoryMinVersion` gets a window they
cannot dismiss (the "Later" button is removed) until they install the update.
Anyone already on that version or newer is left alone.

Leave the file at `0.0.0` and every release stays optional.

## Why it lives in the repo, not in the release

The app reads the file straight from `main`:

```
https://raw.githubusercontent.com/pavlo-ch/anty/main/build/update-policy.json
```

So the answer is not frozen into a build. If a release ships and a problem only
turns out to be serious afterwards, you can still force it — change one line and
push. Shipping the flag inside the release would mean the decision had to be made
before you knew you needed it.

Takes effect within a few minutes (the raw host caches briefly; the app adds a
changing query to cut that short).

## If the file cannot be read

Missing, unreachable, malformed, or empty — the update is treated as **optional**.
A failed fetch must never lock someone out of the app they already have, so the
permissive case is both the fallback and the default.

## Pointing it somewhere else

Set the `update_policy_url` setting or the `ANTY_UPDATE_POLICY_URL` environment
variable to override the URL.

## One-time note

The switch lives in the app, so it applies from the first build that contains it.
Anyone still on an older build keeps the old behaviour for that one update.
