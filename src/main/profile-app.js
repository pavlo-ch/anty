// Chrome профілю під назвою профілю в Dock і в меню (macOS).
//
// Dock і перемикач програм беруть назву з Info.plist програми, тож стоковий Chrome
// усюди підписаний «Google Chrome». Для кожного профілю тут складається власна
// копія Chrome.app з іншою назвою й bundle id:
//   • Frameworks і Resources — клони APFS (cp -c): місця не займають, копіюються
//     за частку секунди. Симлінки не годяться: пісочниця GPU-процесу Chrome не
//     відкриває фреймворк через шлях поза своїм бандлом, і Chrome падає.
//   • Змінений Info.plist ламає підпис Google, і macOS вбиває процес (SIGKILL),
//     тож бандл підписується ad-hoc. Камеру це не зачіпає: TCC питає Anty
//     (responsible process), а не Chrome; Keychain теж — Playwright дає
//     --use-mock-keychain.
// Копія перебудовується, коли змінюється назва або версія Chrome. Будь-яка
// помилка — запуск звичайного Chrome, як раніше.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_NAME = 24;

function shortName(name) {
  const clean = String(name || '').replace(/[\/:\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || 'Anty profile';
  return clean.length > MAX_NAME ? clean.slice(0, MAX_NAME - 1).trimEnd() + '…' : clean;
}

function chromeBundleOf(executablePath) {
  // …/Google Chrome.app/Contents/MacOS/Google Chrome → …/Google Chrome.app
  const contents = path.dirname(path.dirname(executablePath));
  return path.basename(contents) === 'Contents' ? path.dirname(contents) : null;
}

function readVersion(bundle) {
  try {
    return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
}

/**
 * Шлях до виконуваного файлу Chrome під назвою профілю, або null — тоді
 * запускається звичайний Chrome.
 */
function profileAppExecutable({ executablePath, profileId, profileName, dataDir }) {
  if (process.platform !== 'darwin' || !executablePath || !dataDir) return null;
  try {
    const source = chromeBundleOf(executablePath);
    if (!source) return null;
    const exeName = path.basename(executablePath);
    const name = shortName(profileName);
    const version = readVersion(source);
    const root = path.join(dataDir, 'profile-apps', `profile_${profileId}`);
    const marker = path.join(root, '.built');
    const stamp = JSON.stringify({ name, version, source });

    const existing = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    if (existing === stamp) {
      const bundle = path.join(root, `${name}.app`);
      const exe = path.join(bundle, 'Contents', 'MacOS', exeName);
      if (fs.existsSync(exe)) return exe;
    }

    fs.rmSync(root, { recursive: true, force: true });
    const bundle = path.join(root, `${name}.app`);
    const contents = path.join(bundle, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    const from = path.join(source, 'Contents');
    execFileSync('cp', ['-c', path.join(from, 'MacOS', exeName), path.join(contents, 'MacOS', exeName)]);
    execFileSync('cp', ['-cR', path.join(from, 'Frameworks'), path.join(contents, 'Frameworks')]);
    execFileSync('cp', ['-cR', path.join(from, 'Resources'), path.join(contents, 'Resources')]);
    for (const file of ['Info.plist', 'PkgInfo']) {
      if (fs.existsSync(path.join(from, file))) fs.copyFileSync(path.join(from, file), path.join(contents, file));
    }
    const plist = path.join(contents, 'Info.plist');
    execFileSync('plutil', ['-replace', 'CFBundleName', '-string', name, plist]);
    execFileSync('plutil', ['-replace', 'CFBundleDisplayName', '-string', name, plist]);
    execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', `com.anty.profile.p${profileId}`, plist]);
    // Без ключа Keystone (оновлювача Google) копія не намагається оновлювати себе.
    try { execFileSync('plutil', ['-remove', 'KSProductID', plist]); } catch (_) {}
    try { execFileSync('xattr', ['-cr', bundle]); } catch (_) {}
    execFileSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'ignore' });

    fs.writeFileSync(marker, stamp);
    return path.join(contents, 'MacOS', exeName);
  } catch (err) {
    console.warn(`[ProfileApp] profile ${profileId}: falling back to stock Chrome — ${err.message}`);
    return null;
  }
}

/** Прибирає копію Chrome видаленого профілю. */
function removeProfileApp(dataDir, profileId) {
  try { fs.rmSync(path.join(dataDir, 'profile-apps', `profile_${profileId}`), { recursive: true, force: true }); } catch (_) {}
}

module.exports = { profileAppExecutable, removeProfileApp, shortName };
