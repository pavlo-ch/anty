// Назва профілю для вікна Chrome.
//
// Була спроба (1.2.21–1.2.22) запускати кожен профіль із власної копії
// Chrome.app, названої за профілем, щоб у Dock було видно акаунт. Від неї
// відмовились (власник, 12.11.2026): копію з переписаним Info.plist треба
// підписувати заново, і macOS ~18 с перевіряє кожну таку копію («Перевірка
// «Clara Sterling»…») — на першому запуску кожного профілю й після кожного
// оновлення Chrome. Без перепідпису macOS її вбиває, спільна копія для всіх
// профілів зависає, а перейменувати чужий запущений процес не дозволено.
// Тепер профіль запускається зі стокового Chrome; назва лишається в заголовку
// вікна (--window-name), а старі копії прибираються.
const fs = require('fs');
const path = require('path');

const MAX_NAME = 24;

function shortName(name) {
  const clean = String(name || '').replace(/[\/:\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || 'Anty profile';
  return clean.length > MAX_NAME ? clean.slice(0, MAX_NAME - 1).trimEnd() + '…' : clean;
}

let cleaned = false;
/** Прибирає копії Chrome, що лишились від 1.2.21–1.2.22. Раз за запуск Anty. */
function removeLegacyProfileApps(dataDir) {
  if (cleaned || !dataDir) return;
  cleaned = true;
  fs.rm(path.join(dataDir, 'profile-apps'), { recursive: true, force: true }, () => {});
}

module.exports = { shortName, removeLegacyProfileApps };
