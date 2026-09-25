/*
 * ADV columns — один клік відкриває таблицю Ads Manager одразу з колонками ADV. Вбудовано в Anty.
 *
 * Це НЕ модуль Node: файл читається як текст і виконується в кожній вкладці профілю в
 * ізольованому світі (див. src/main/adv-columns.js) — як контент-скрипт розширення, але
 * без розширення і без порту налагодження. Сторінка Facebook не бачить його змінних;
 * спільний з нею лише DOM (кнопка в shadow DOM).
 *
 * Як працює: Ads Manager бере набір колонок з параметра columns= в адресі — ключі через
 * кому, у потрібному порядку. Кнопка перевідкриває поточну таблицю (кампанії, групи
 * оголошень чи оголошення) з columns=<ключі ADV>; дата, фільтри й акаунт з адреси
 * лишаються. Діалог колонок не відкривається, пресет не зберігається й не змінюється.
 *
 * Перевірено на справжньому Ads Manager 25.09.2026 (профіль «Facebook Maria Shevchyk»):
 * на всіх трьох рівнях таблиця відкривається з цими колонками рівно в цьому порядку;
 * business.facebook.com/adsmanager/… переадресовує на adsmanager.facebook.com з тим самим
 * columns=; column_preset= у тій самій адресі перебив би набір, тож його прибираємо.
 *
 * Ключі не залежать від мови інтерфейсу, і після завантаження таблиця звіряється за ними ж:
 * у заголовку колонки є id «reporting_table_column_<ключ>». Тож мова Ads Manager не важлива.
 */
(function () {
  // Скрипт приходить у кожен документ профілю; працює лише у вкладці Ads Manager.
  if (window.top !== window || window.__advColumns) return;
  if (!/^(adsmanager|business)\.facebook\.com$/.test(location.hostname)) return;
  window.__advColumns = true;
  // business.facebook.com — одна сторінка на весь Business Suite, Ads Manager там лише
  // розділ; перехід усередині неї не перезавантажує документ.
  const onAdsManager = () => location.pathname.startsWith('/adsmanager');

  // Набір і порядок — зі скрінів дева (23.09.2026), 1 → 2 → 3. Ключ кожної колонки
  // звірено 25.09.2026: з ним у columns= таблиця показує саме цю колонку (назва праворуч).
  const PRESET = {
    name: 'ADV',
    columns: [
      'name', //                                        Campaign / Ad set / Ad
      // скрін 1
      'delivery', //                                    Delivery
      'recommendations_guidance', //                    Actions
      'budget', //                                      Budget
      'spend', //                                       Amount spent
      'impressions', //                                 Impressions
      'reach', //                                       Reach
      'cpm', //                                         CPM (cost per 1,000 impressions)
      'ctr', //                                         CTR (all)
      'cpc', //                                         CPC (all)
      'clicks', //                                      Clicks (all)
      // скрін 2 обидва рази надіслано дублем скріну 1: у діалозі «26 columns selected»,
      // а видно 20, тож ~6 колонок між «Clicks (all)» і «Results» ще не відомі.
      // скрін 3
      'results', //                                     Results
      'cost_per_result', //                             Cost per result
      'video_avg_time_watched_actions:video_view', //   Video average play time
      'video_p25_watched_actions:video_view', //        Video plays at 25%
      'video_p75_watched_actions:video_view', //        Video plays at 75%
      'video_p50_watched_actions:video_view', //        Video plays at 50%
      'actions:post_engagement', //                     Post engagements
      'actions:post_reaction', //                       Post reactions
      'actions:comment', //                             Post comments
    ],
  };
  const COLUMNS = PRESET.columns.join(',');
  const TABLE_PATH = /^\/adsmanager\/manage\/(campaigns|adsets|ads)\/?$/;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  async function waitFor(fn, timeout, every = 500) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() > end) return null;
      await sleep(every);
    }
  }

  /* ---------------- посилання ---------------- */

  // Та сама таблиця з колонками ADV. Не з таблиці (Audiences, звіти) — таблиця кампаній
  // того ж акаунта. column_preset= прибираємо: інакше він перебиває набір. Одразу на
  // adsmanager.facebook.com: business.facebook.com туди однаково переадресовує. Прапорець
  // звірки (sessionStorage) з business.facebook.com туди не доходить, тож після такого
  // переходу звірка тиха: «ADV is on.» не буде, збій — буде.
  function advUrl() {
    const url = new URL(location.href);
    url.hostname = 'adsmanager.facebook.com';
    if (!TABLE_PATH.test(url.pathname)) {
      const keep = ['act', 'business_id', 'global_scope_id'];
      const params = new URLSearchParams();
      for (const k of keep) if (url.searchParams.has(k)) params.set(k, url.searchParams.get(k));
      url.pathname = '/adsmanager/manage/campaigns';
      url.search = params.toString();
    }
    url.searchParams.delete('column_preset');
    url.searchParams.set('columns', COLUMNS);
    url.hash = '';
    return url.href;
  }

  const hasAdvColumns = () => new URL(location.href).searchParams.get('columns') === COLUMNS;

  /* ---------------- звірка таблиці ---------------- */

  // Ключ колонки з її заголовка. «Results» — окремий компонент зі своїм id
  // (перевірено 25.09.2026); колонка без відомого id просто не рахується.
  function headerKey(header) {
    const el = header.querySelector('[id^="reporting_table_column_"], #ads_manager_table_results_column_label_id');
    if (!el) return null;
    return el.id === 'ads_manager_table_results_column_label_id'
      ? 'results'
      : el.id.slice('reporting_table_column_'.length);
  }

  function tableKeys() {
    return [...document.querySelectorAll('[role="columnheader"]')]
      .filter((h) => isVisible(h) && !(host && host.contains(h)))
      .map(headerKey)
      .filter(Boolean);
  }

  // Таблиця може рендерити лише колонки в межах видимої ширини, тож «не видно» ≠ «немає».
  // Звіряємо порядок відрендерених і що перші колонки набору на місці.
  function checkTable() {
    const keys = tableKeys();
    const positions = PRESET.columns
      .map((key) => ({ key, at: keys.indexOf(key) }))
      .filter((p) => p.at !== -1);
    const outOfOrder = positions.filter((p, i) => i > 0 && p.at < positions[i - 1].at).map((p) => p.key);
    const leading = PRESET.columns.slice(0, 5).filter((k) => !keys.includes(k));
    return { keys, seen: positions.length, outOfOrder, leading };
  }

  class CheckError extends Error {
    constructor(message, detail) {
      super(message);
      this.detail = detail; // що покласти у звіт
    }
  }

  // Таблицю після переходу чекаємо довго: через повільний проксі Ads Manager буває
  // хвилину на «Loading your ad account.».
  async function verify(ui) {
    ui.step('Wait for the table');
    const ready = await waitFor(() => tableKeys().includes('name'), 90000);
    if (!ready) {
      ui.note("The table didn't load within 90 s, so the columns weren't double-checked.");
      return 'warn';
    }
    await sleep(1000); // заголовки домальовуються не всі разом
    ui.step('Check the columns');
    const result = checkTable();
    if (result.outOfOrder.length || result.leading.length) {
      const what = result.leading.length
        ? `missing: ${result.leading.join(', ')}`
        : `out of order: ${result.outOfOrder.join(', ')}`;
      throw new CheckError(`Ads Manager didn't take the ${PRESET.name} column list (${what}).`, result);
    }
    ui.info(`table: ${result.seen} of ${PRESET.columns.length} columns on screen, in order`);
    return 'ok';
  }

  /* ---------------- звіт ---------------- */

  // Без адреси: у ній id акаунта й бізнесу, а для діагностики досить шляху й ключів.
  function buildReport(log, error) {
    const parts = [
      `ADV columns · Anty ${typeof __ANTY_VERSION === 'string' ? __ANTY_VERSION : ''} · ${new Date().toISOString()}`,
      `Page: ${location.host}${location.pathname} · lang=${document.documentElement.lang || '?'}`,
      `columns= in address: ${hasAdvColumns() ? 'ADV' : new URL(location.href).searchParams.get('columns') || '(none)'}`,
      '',
      ...log,
      '',
      `Error: ${error.message}`,
    ];
    if (error.detail) {
      parts.push('', `expected: ${PRESET.columns.join(', ')}`, `table:    ${error.detail.keys.join(', ')}`);
    } else {
      parts.push('', String(error.stack || ''));
    }
    return parts.join('\n');
  }

  /* ---------------- інтерфейс ---------------- */

  let host = null; // наш shadow-host: його вміст ніколи не вважаємо частиною Ads Manager

  const CSS = `
    :host { all: initial; }
    .fab, .panel { position: fixed; z-index: 2147483000; box-sizing: border-box;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1c1e21; }
    .fab { right: 20px; bottom: 20px; padding: 8px 14px; border: 0; border-radius: 6px;
      background: #1c2b33; color: #fff; font-weight: 600; cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,.2); }
    .fab:disabled { opacity: .6; cursor: default; }
    .panel { right: 20px; bottom: 64px; width: 300px; padding: 12px; background: #fff; border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,.2); }
    .panel[hidden] { display: none; }
    .title { font-weight: 600; margin-bottom: 6px; }
    ol { margin: 0; padding-left: 18px; }
    li { margin: 2px 0; overflow-wrap: anywhere; }
    li.cur { font-weight: 600; }
    .msg { margin-top: 8px; padding: 8px; border-radius: 6px; overflow-wrap: anywhere; }
    .msg[hidden] { display: none; }
    .msg.ok { background: #e7f3e8; }
    .msg.warn { background: #fff4d6; }
    .msg.err { background: #fde8e8; }
    .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
    .row button { padding: 5px 10px; border: 1px solid #ccd0d5; border-radius: 6px; background: #f5f6f7;
      font: inherit; cursor: pointer; }
    .row button[hidden] { display: none; }
    textarea { width: 100%; height: 120px; margin-top: 8px; box-sizing: border-box; font: 11px/1.3 monospace; }
    textarea[hidden] { display: none; }
  `;

  // Кнопку натиснули → перехід → у новому документі цей самий скрипт звіряє таблицю.
  // Прапорець у sessionStorage каже, що звірку ініціювала кнопка, а не закладка.
  const PENDING = '__advColumnsPending';
  const takePending = () => {
    try {
      const at = Number(sessionStorage.getItem(PENDING));
      sessionStorage.removeItem(PENDING);
      return at > 0 && Date.now() - at < 120000;
    } catch (_) {
      return false;
    }
  };

  function mountUi() {
    host = document.createElement('div');
    host.id = 'adv-columns-host';
    const shadow = host.attachShadow({ mode: 'open' });
    // Стилі через adoptedStyleSheets: на них не діє style-src CSP сторінки, на <style> — може.
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (_) {
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
    }
    shadow.innerHTML += `
      <div class="panel" hidden>
        <div class="title">${PRESET.name} columns</div>
        <ol></ol>
        <div class="msg" hidden></div>
        <textarea readonly hidden></textarea>
        <div class="row">
          <button class="copy" hidden>Copy report</button>
          <button class="close">Close</button>
        </div>
      </div>
      <button class="fab">${PRESET.name} columns</button>`;
    document.documentElement.appendChild(host);

    const $ = (s) => shadow.querySelector(s);
    const panel = $('.panel');
    const list = $('ol');
    const msg = $('.msg');
    const copyBtn = $('.copy');
    const area = $('textarea');
    const fab = $('.fab');
    let log = [];
    let report = '';

    const ui = {
      step(text) {
        list.querySelector('li.cur')?.classList.remove('cur');
        const li = document.createElement('li');
        li.className = 'cur';
        li.textContent = text;
        list.appendChild(li);
        log.push(`step: ${text}`);
      },
      note(text) {
        log.push(`note: ${text}`);
        show('warn', text);
      },
      info(text) {
        log.push(`info: ${text}`); // лише у звіт, людині не показується
      },
    };

    function show(kind, text) {
      msg.hidden = false;
      msg.className = `msg ${kind}`;
      msg.textContent = text;
    }

    function reset() {
      panel.hidden = false;
      list.textContent = '';
      msg.hidden = true;
      copyBtn.hidden = true;
      area.hidden = true;
      log = [];
    }

    // quiet: відкрили закладку з columns=ADV, а не натиснули кнопку — панель лише при збої.
    async function check({ quiet }) {
      fab.disabled = true;
      reset();
      if (quiet) panel.hidden = true;
      try {
        const result = await verify(ui);
        list.querySelector('li.cur')?.classList.remove('cur');
        if (result === 'ok' && !quiet) {
          show('ok', `${PRESET.name} is on.`);
          // Панель стоїть над Ads Manager — після успіху прибираємо її, щоб не заважала.
          setTimeout(() => { if (!fab.disabled) panel.hidden = true; }, 5000);
        }
        if (result !== 'ok' && quiet) panel.hidden = false;
      } catch (error) {
        console.error('[ADV columns]', error); // повний слід лишається в консолі
        report = buildReport(log, error);
        panel.hidden = false;
        show('err', error instanceof CheckError
          ? `${error.message} Copy the report and send it to the dev.`
          : 'Something broke in ADV columns. Copy the report and send it to the dev.');
        copyBtn.hidden = false;
      } finally {
        fab.disabled = false;
      }
    }

    // Перехід навіть тоді, коли в адресі вже columns=ADV: колонки могли змінити руками,
    // а Ads Manager застосовує columns= лише при відкритті сторінки.
    fab.addEventListener('click', () => {
      reset();
      ui.step(`Open the table with the ${PRESET.name} columns`);
      fab.disabled = true;
      try { sessionStorage.setItem(PENDING, String(Date.now())); } catch (_) {}
      location.assign(advUrl());
    });

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(report);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy report'; }, 1500);
      } catch (_) {
        area.value = report; // буфер недоступний — даємо виділити вручну
        area.hidden = false;
        area.select();
      }
    });

    $('.close').addEventListener('click', () => { panel.hidden = true; });

    const pending = takePending();
    if (onAdsManager() && hasAdvColumns()) void check({ quiet: !pending });
  }

  // Скрипт виконується ще до розбору сторінки; кнопку ставимо, коли DOM готовий.
  const start = () => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      return;
    }
    mountUi();
    const sync = () => { host.style.display = onAdsManager() ? '' : 'none'; };
    sync();
    setInterval(sync, 1000);
  };
  start();
})();
