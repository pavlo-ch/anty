# Launch local profiles from the web panel

Version 1.2.7 registers `anty://launch/<remoteId>?background=1` on macOS and Windows.
The OS starts or reuses Anty Browser, which syncs the signed-in account and launches
the profile locally. Cold launches keep the manager window hidden. Normal app
launches still show it; login/sync/launch errors reveal it with an explanation.
Repeated pending URLs are deduplicated. Profiles running on another device remain
protected by the existing running-lock rules.

The website waits for the desktop's synced running status and launch timestamp,
and also accepts the browser's focus change when the external application is
handed off. A timeout means unconfirmed, not uninstalled. The browser may ask
permission to open the external application; the user must allow it. Version
1.2.5 does not register this profile-launch protocol and needs an update.

macOS builds are universal (Intel x86_64 and Apple Silicon arm64). The local build
command below produces an ad-hoc-signed test installer, without Apple notarization.
Distribution to other users requires the normal Developer ID signing and Apple
notarization setup. The GitHub release workflow uses the configured signing
secrets when available and otherwise publishes the unsigned fallback.

```sh
node --test scripts/test-web-launch.cjs
CSC_IDENTITY_AUTO_DISCOVERY=false node_modules/.bin/electron-builder --mac dmg --universal --publish never -c.mac.identity=-
```

Tests mock Electron and the launcher: cold startup from Windows argv/macOS URL,
normal visible startup, duplicate launch, account/sync/lock failures and the
acknowledgement path. A real profile/account end-to-end test is still required
before public distribution. No installer is installed automatically by this build.
