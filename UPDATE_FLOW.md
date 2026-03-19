# Update Flow (Automatic GitHub Releases + Notarization)

## What is automated now

- GitHub Actions workflow: `.github/workflows/release-mac.yml`
- Trigger: push tag `v*` (example: `v1.0.4`)
- Pipeline does automatically:
  - builds DMG
  - signs app with Apple certificate
  - notarizes app with Apple
  - publishes release assets to GitHub

## Required GitHub Secrets

Set in `Repo -> Settings -> Secrets and variables -> Actions`:

- `APPLE_CERTIFICATE_P12_BASE64` (base64 of Developer ID Application `.p12`)
- `APPLE_CERTIFICATE_PASSWORD` (password of `.p12`)
- `APPLE_ID` (Apple ID email)
- `APPLE_APP_SPECIFIC_PASSWORD` (app-specific password for Apple ID)
- `APPLE_TEAM_ID` (Apple Developer Team ID)

## One-command release flow

1. Update version in `package.json` (example `1.0.4`)
2. Commit and push:
   - `git add .`
   - `git commit -m "release: v1.0.4"`
   - `git push`
3. Create and push tag:
   - `git tag v1.0.4`
   - `git push origin v1.0.4`
4. Wait for workflow `Release macOS` to finish.

Release will include:
- `Anty-Browser.dmg`
- `Anty-Browser.dmg.blockmap`
- `latest-mac.yml`

## Auto-update URL (stable)

Use this URL in app/web:

- `https://github.com/pavlo-ch/anty/releases/latest/download`

App fetches:
- `latest-mac.yml` from that URL
- DMG from URL inside that file

## Platform Login Config (No UI)

Set platform login endpoint in:

- `config/platform.json -> authUrl`
- `config/platform.json -> refreshUrl`
- `config/platform.json -> logoutUrl`
- optional logs endpoint in `config/platform.json -> logUrl`

This file is included in build artifacts and used by Anty login flow.

## Runtime update flow in app

1. App starts and checks `latest-mac.yml`
2. If remote version is newer:
3. App is blocked by a full-screen mandatory update modal
4. DMG download opens automatically
5. User installs update and restarts app

## Logging

- Local file:
  - `~/Library/Application Support/Anty Browser/logs/updater.log`
- Optional platform API:
  - set `ANTY_PLATFORM_LOG_URL`
