/**
 * ADV columns — кнопка в Ads Manager, що одним кліком ставить пресет колонок ADV.
 *
 * Вбудовано в Anty, а не розширенням: будь-яке розширення з бібліотеки змушує лаунчер
 * відкривати порт налагодження, а саме його закривав 1.2.12. Тут скрипт сторінки
 * (page-scripts/adv-columns.js) приходить через CDP-сесію, яку Playwright і так тримає
 * з браузером по pipe, — жодного TCP-порту.
 *
 * Скрипт виконується в окремому ізольованому світі, як контент-скрипт: сторінка не
 * бачить його змінних і не може їх підмінити. Він сам виходить на всіх сайтах, крім
 * adsmanager.facebook.com / business.facebook.com/adsmanager.
 */
const fs = require('fs');
const path = require('path');
const { version } = require('../../package.json');

const WORLD_NAME = 'anty-adv-columns';

let source = null;
function pageSource() {
  if (source === null) {
    const body = fs.readFileSync(path.join(__dirname, 'page-scripts', 'adv-columns.js'), 'utf8');
    source = `const __ANTY_VERSION = ${JSON.stringify(version)};\n${body}`;
  }
  return source;
}

/**
 * Ставить скрипт у кожну вкладку контексту — наявні й нові. Нічого не кидає: збій тут
 * не має зупиняти запуск профілю, у гіршому разі просто не буде кнопки.
 * Повертає функцію зупинки, як installAccessChallengeMonitor.
 */
function installAdvColumns(context) {
  const sessions = new Map();
  let stopped = false;

  const attach = async (page) => {
    if (stopped || !page || page.isClosed() || sessions.has(page)) return;
    sessions.set(page, null);
    try {
      const session = await context.newCDPSession(page);
      if (stopped || page.isClosed()) {
        session.detach().catch(() => {});
        return;
      }
      sessions.set(page, session);
      // Без Page.enable на цій сесії Chrome не застосовує скрипт до нових документів
      // (перевірено 23.09.2026: без нього — жодної навігації, з ним — кожна). Сторінці
      // Page.enable не видно; слід автоматизації лишає Runtime.enable, його тут немає.
      await session.send('Page.enable');
      // runImmediately — щоб вкладка, відкрита ще до підключення, теж отримала кнопку.
      await session.send('Page.addScriptToEvaluateOnNewDocument', {
        source: pageSource(),
        worldName: WORLD_NAME,
        runImmediately: true,
      });
      page.once('close', () => sessions.delete(page));
    } catch (err) {
      sessions.delete(page);
      if (!page.isClosed()) console.error('[ADV columns] Could not attach to a tab:', err.message);
    }
  };

  try {
    context.pages().forEach((page) => { void attach(page); });
    context.on('page', attach);
  } catch (err) {
    console.error('[ADV columns] Not installed:', err.message);
  }

  return () => {
    stopped = true;
    try { context.off('page', attach); } catch (_) {}
    for (const session of sessions.values()) session?.detach().catch(() => {});
    sessions.clear();
  };
}

module.exports = { installAdvColumns };
