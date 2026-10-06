/**
 * USD — кнопка-тумблер на Facebook: показати суми в доларах, коли на сторінці інша валюта.
 *
 * Вбудовано в Anty, як ADV columns (див. adv-columns.js), а не розширенням: розширення з
 * бібліотеки змушує лаунчер відкривати порт налагодження. Скрипт сторінки
 * (page-scripts/usd-toggle.js) приходить через CDP-сесію, яку Playwright і так тримає по
 * pipe, і працює в окремому ізольованому світі. Курс кладеться в скрипт тут, бо сама
 * сторінка Facebook сходити по нього не може (див. fx-rates.js).
 */
const fs = require('fs');
const path = require('path');
const { getRates } = require('./fx-rates');

const WORLD_NAME = 'anty-usd-toggle';

let body = null;
function pageSource(rates) {
  if (body === null) body = fs.readFileSync(path.join(__dirname, 'page-scripts', 'usd-toggle.js'), 'utf8');
  return `const __ANTY_FX = ${JSON.stringify(rates ? { date: rates.date, rates: rates.rates } : null)};\n${body}`;
}

/**
 * Ставить скрипт у кожну вкладку контексту — наявні й нові. Не чекає на курс і нічого не
 * кидає: збій тут не має зупиняти запуск профілю, у гіршому разі просто не буде кнопки.
 * Повертає функцію зупинки, як installAdvColumns.
 */
function installUsdToggle(context) {
  const sessions = new Map();
  let stopped = false;
  const source = getRates().then(pageSource).catch(() => pageSource(null));

  const attach = async (page) => {
    if (stopped || !page || page.isClosed() || sessions.has(page)) return;
    sessions.set(page, null);
    try {
      const [session, script] = await Promise.all([context.newCDPSession(page), source]);
      if (stopped || page.isClosed()) {
        session.detach().catch(() => {});
        return;
      }
      sessions.set(page, session);
      // Без Page.enable Chrome не застосовує скрипт до нових документів (див. adv-columns.js).
      await session.send('Page.enable');
      await session.send('Page.addScriptToEvaluateOnNewDocument', {
        source: script,
        worldName: WORLD_NAME,
        runImmediately: true,
      });
      page.once('close', () => sessions.delete(page));
    } catch (err) {
      sessions.delete(page);
      if (!page.isClosed()) console.error('[USD] Could not attach to a tab:', err.message);
    }
  };

  try {
    context.pages().forEach((page) => { void attach(page); });
    context.on('page', attach);
  } catch (err) {
    console.error('[USD] Not installed:', err.message);
  }

  return () => {
    stopped = true;
    try { context.off('page', attach); } catch (_) {}
    for (const session of sessions.values()) session?.detach().catch(() => {});
    sessions.clear();
  };
}

module.exports = { installUsdToggle };
