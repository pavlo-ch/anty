const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function notarizeMacApp(context) {
  if (process.platform !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleAppSpecificPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const appleTeamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleAppSpecificPassword || !appleTeamId) {
    console.log('[notarize] Skipped: missing APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  if (!fs.existsSync(appPath)) {
    throw new Error(`[notarize] App not found at path: ${appPath}`);
  }

  const zipPath = path.join(context.appOutDir, `${appName}-notarize.zip`);

  console.log(`[notarize] Zipping app: ${appPath}`);
  execFileSync(
    'ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath],
    { stdio: 'inherit' }
  );

  console.log('[notarize] Submitting to Apple notary service...');
  execFileSync(
    'xcrun',
    [
      'notarytool',
      'submit',
      zipPath,
      '--apple-id',
      appleId,
      '--password',
      appleAppSpecificPassword,
      '--team-id',
      appleTeamId,
      '--wait'
    ],
    { stdio: 'inherit' }
  );

  console.log('[notarize] Stapling ticket to .app...');
  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });

  try {
    fs.unlinkSync(zipPath);
  } catch (_) {
    // Ignore cleanup errors.
  }

  console.log('[notarize] Done.');
};
