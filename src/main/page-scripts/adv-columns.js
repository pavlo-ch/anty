/*
 * ADV columns — один клік відкриває таблицю Ads Manager одразу з колонками ADV. Вбудовано в Anty.
 *
 * Це НЕ модуль Node: файл читається як текст і виконується в кожній вкладці профілю в
 * ізольованому світі (див. src/main/adv-columns.js) — як контент-скрипт розширення, але
 * без розширення і без порту налагодження. Сторінка Facebook не бачить його змінних;
 * спільний з нею лише DOM (кнопка в shadow DOM).
 *
 * Як працює, два кроки:
 * 1. Колонки — посиланням. Ads Manager бере набір із параметра columns= в адресі — ключі
 *    через кому, у потрібному порядку. Кнопка перевідкриває поточну таблицю (кампанії,
 *    групи оголошень чи оголошення) з columns=<ключі ADV>; дата, фільтри й акаунт з
 *    адреси лишаються. Ключі не залежать від мови інтерфейсу, і таблиця після
 *    завантаження звіряється за ними ж: у заголовку колонки є id «reporting_table_column_<ключ>».
 * 2. Пресет ADV. Посилання дає лише «Columns: Custom» — пресет Ads Manager не створює.
 *    Якщо ADV ще немає, кнопка зберігає вже відкритий набір: Columns → Customize columns
 *    (колонки там уже стоять, нічого не проклікується) → Save ▾ → Save as new preset →
 *    «ADV» → Save. Якщо ADV із цим набором уже є, Ads Manager сам підписує таблицю
 *    «Columns: ADV» — тоді нічого не зберігається. Цей крок шукає елементи за видимим
 *    текстом, тож лише він вимагає англійського інтерфейсу.
 *
 * Перевірено на справжньому Ads Manager 25.09.2026 (профіль «Facebook Maria Shevchyk»):
 * на всіх трьох рівнях таблиця відкривається з цими колонками рівно в цьому порядку;
 * business.facebook.com/adsmanager/… переадресовує на adsmanager.facebook.com з тим самим
 * columns=; column_preset= у тій самій адресі перебив би набір, тож його прибираємо.
 * Кроки збереження пресета — зі старої кнопки, прогнаної на живому Ads Manager 23.09.2026.
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

  /* ---------------- пресет ADV: пошук за текстом ---------------- */

  // Далі — кроки старої кнопки (перевірені на живому Ads Manager 23.09.2026) без
  // проклікування колонок: набір уже відкрито посиланням. Класи у верстці Facebook
  // обфусковані, тож елементи шукаються за видимим текстом і ARIA-ролями.
  const CLICKABLE = 'button, a, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [tabindex]';
  const COUNT_RE = /^(\d+) columns? selected$/i;

  // Найглибші видимі елементи під root, чий текст приймає accept. Текст може бути
  // розбитий на кілька вузлів, тому звіряється textContent предків, а prefilter
  // дешево відсікає вузли, які точно не частина шуканого.
  function findText(root, accept, prefilter) {
    const out = [];
    if (!root) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const piece = norm(n.data);
      if (!piece || !prefilter(piece)) continue;
      for (let el = n.parentElement, i = 0; el && root.contains(el) && i < 4; el = el.parentElement, i++) {
        const text = norm(el.textContent);
        if (accept(text)) {
          if (!out.includes(el) && isVisible(el) && !(host && host.contains(el))) out.push(el);
          break;
        }
        if (text.length > 120) break;
      }
    }
    return out;
  }

  function exactly(label) {
    const want = norm(label).toLowerCase();
    return [(t) => t.toLowerCase() === want, (p) => want.includes(p.toLowerCase())];
  }

  function pattern(re, hint) {
    return [(t) => t.length <= 80 && re.test(t), (p) => hint.test(p)];
  }

  // Вище за el, але ще не спільний предок з anchor: для порталу — корінь меню/діалогу.
  function popupRoot(el, anchor) {
    let root = el;
    while (root.parentElement && root.parentElement !== document.body && !root.parentElement.contains(anchor)) {
      root = root.parentElement;
    }
    return root;
  }

  const isDisabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true';

  function press(el) {
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', ptr));
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new PointerEvent('pointerup', ptr));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
  }

  // React стежить за value через власний сетер; нативний сетер прототипу + подія input
  // — перевірений спосіб, щоб onChange спрацював.
  function typeInto(input, value) {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findColumnsButton() {
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (host && host.contains(el)) continue;
      const label = norm(el.getAttribute('aria-label')) || norm(el.textContent);
      if (/^columns\b/i.test(label) && isVisible(el)) return el;
    }
    return null;
  }

  // «Columns: ADV» — Ads Manager упізнав відкритий набір як наш пресет.
  const saysPreset = (btn) => new RegExp(`\\b${PRESET.name}\\b`).test(norm(btn.textContent));

  // Діалог «Customize columns»: корінь і лічильник «N columns selected». Шукається
  // заново щоразу — React перемальовує діалог, і старі посилання відвалюються.
  function locateDialog(anchor) {
    const countEl = findText(document.body, ...pattern(COUNT_RE, /selected/i))[0];
    if (!countEl) return null;
    return { dialog: countEl.closest('[role="dialog"]') || popupRoot(countEl, anchor), countEl };
  }

  const readCount = (ctx) => Number(COUNT_RE.exec(norm(ctx.countEl.textContent))[1]);

  class StepError extends Error {
    constructor(message, root) {
      super(message);
      this.root = root; // що покласти у звіт: меню, діалог або сторінку
    }
  }

  /* ---------------- пресет ADV: збереження ---------------- */

  // Викликається після звірки таблиці, тож у ній уже рівно набір ADV.
  async function ensurePreset(ui) {
    const colBtn = await waitFor(findColumnsButton, 15000);
    if (!colBtn) {
      ui.note(`The columns are set, but the Columns button wasn't found, so the ${PRESET.name} preset wasn't saved.`);
      return 'warn';
    }
    if (saysPreset(colBtn)) return 'ok';

    ui.step(`Save the ${PRESET.name} preset`);
    // Меню прив'язане до кнопки через aria-controls (перевірено 23.09.2026). Шукати
    // «Customize columns» по всій сторінці не можна: у кнопці «+» шапки таблиці є
    // прихований текст «Customize columns…», і клік по ньому відкриває інший поповер.
    const customize = pattern(/^customi[sz]e columns/i, /customi[sz]e/i);
    const menuEl = () => {
      const id = colBtn.getAttribute('aria-controls');
      const el = id && document.getElementById(id);
      if (el && isVisible(el)) return el;
      return [...document.querySelectorAll('[role="menu"]')].find(isVisible) || null;
    };
    if (colBtn.getAttribute('aria-expanded') !== 'true') press(colBtn);
    // Одразу після завантаження сторінки меню секунди зо три-п'ять показує «Loading...».
    const menu = await waitFor(() => { const m = menuEl(); return m && findText(m, ...customize)[0] && m; }, 15000);
    if (!menu) {
      const lang = document.documentElement.lang || 'unknown';
      throw new StepError(
        "The Columns menu didn't open, or it has no Customize columns item." +
        (/^en/i.test(lang) ? '' : ` Saving the preset needs Ads Manager in English (now: ${lang}).`),
        menuEl(),
      );
    }

    // ADV уже є, а таблиця не «Columns: ADV» — отже, в ньому інший набір. Другий ADV
    // не створюємо (як і стара кнопка): його треба перейменувати чи видалити самому.
    let existing = findText(menu, ...exactly(PRESET.name))[0];
    if (!existing) {
      const yours = findText(menu, ...pattern(/^view your (column )?presets$/i, /view|presets/i))[0];
      if (yours) {
        press(yours.closest(CLICKABLE) || yours);
        // «Back» — іконка з прихованим підписом, тож шукаємо кнопку за її textContent.
        const back = await waitFor(() => {
          const m = menuEl();
          return m && [...m.querySelectorAll('button, [role="button"]')]
            .find((b) => isVisible(b) && /^back\b/i.test(norm(b.textContent).replace(/​/g, '')));
        }, 3000);
        existing = await waitFor(() => { const m = menuEl(); return m && findText(m, ...exactly(PRESET.name))[0]; }, back ? 2000 : 0);
        if (!existing && back) {
          press(back.closest(CLICKABLE) || back);
          await waitFor(() => { const m = menuEl(); return m && findText(m, ...customize)[0]; }, 3000);
        }
      }
    }
    if (existing) {
      press(colBtn); // закрити меню, нічого не вибравши
      ui.note(
        `The table has the ${PRESET.name} columns now. A preset named ${PRESET.name} with other columns already ` +
        `exists, so a second one wasn't saved — rename or delete it in Ads Manager and click again.`,
      );
      return 'warn';
    }

    const item = findText(menuEl() || menu, ...customize)[0];
    if (!item) throw new StepError('Lost the Customize columns item in the Columns menu.', menuEl());
    press(item.closest(CLICKABLE) || item);

    // Діалог — модуль, що довантажується: перший раз буває повільно.
    let ctx = await waitFor(() => locateDialog(colBtn), 15000);
    if (!ctx) throw new StepError("Customize columns didn't open.", menuEl());
    await sleep(500);
    ctx = locateDialog(colBtn);
    // У діалозі вже набір із посилання (Campaign + решта). Інша кількість — це не наш
    // набір, і зберігати його під назвою ADV не можна.
    if (readCount(ctx) !== PRESET.columns.length) {
      throw new StepError(
        `Customize columns shows ${readCount(ctx)} columns, expected ${PRESET.columns.length}. ` +
        'Nothing was saved — press Cancel in the dialog.',
        ctx.dialog,
      );
    }

    const textInputs = () => [...document.querySelectorAll('input')]
      .filter((i) => isVisible(i) && !isDisabled(i) && ['text', 'search', ''].includes(i.type) && !(host && host.contains(i)));
    const inputsBefore = new Set(textInputs());

    // Нинішній Ads Manager (перевірено 23.09.2026): розділена кнопка «Save ▾» → пункт
    // «Save as new preset» → поле назви. Старіший: чекбокс «Save as preset» + поле + «Apply».
    const saveText = findText(ctx.dialog, ...exactly('Save'))[0];
    const dropdown = (saveText && saveText.closest('[role="group"]')?.querySelector('[aria-haspopup="menu"]'))
      || [...ctx.dialog.querySelectorAll('[aria-haspopup="menu"]')].find((b) => /open dropdown/i.test(norm(b.textContent)));
    if (dropdown) {
      press(dropdown);
      const saveNew = await waitFor(() => {
        const found = findText(document.body, ...pattern(/^save as( a)? new (column )?preset$/i, /save|preset/i));
        return found.find((el) => el.closest('[role="menu"], [role="menuitem"]')) || found[0] || null;
      }, 4000);
      if (!saveNew) throw new StepError("The Save menu has no 'Save as new preset'. Nothing was saved — press Cancel.", ctx.dialog);
      press(saveNew.closest(CLICKABLE) || saveNew);
    } else {
      const saveLabel = findText(ctx.dialog, ...pattern(/^save\b.*\bpreset$/i, /save|preset/i))[0];
      const saveBox = saveLabel && (saveLabel.closest('input[type="checkbox"], [role="checkbox"]')
        || saveLabel.parentElement?.querySelector('input[type="checkbox"], [role="checkbox"]'));
      if (!saveBox) throw new StepError("Couldn't find how to save a preset here. Nothing was saved — press Cancel.", ctx.dialog);
      if (!(saveBox.checked === true || saveBox.getAttribute('aria-checked') === 'true')) {
        if (saveBox instanceof HTMLInputElement) saveBox.click(); else press(saveBox);
      }
    }

    const nameInput = await waitFor(() => textInputs().find((i) => !inputsBefore.has(i)) || null, 4000);
    if (!nameInput) {
      throw new StepError("The preset name field didn't appear. Nothing was saved — press Cancel.", locateDialog(colBtn)?.dialog);
    }
    typeInto(nameInput, PRESET.name);
    await sleep(300);

    // Підтвердження — кнопка в тому ж діалозі, що й поле назви, і після нього.
    const scope = nameInput.closest('[role="dialog"]') || document.body;
    const confirm = [...scope.querySelectorAll('button, [role="button"]')].find((b) =>
      isVisible(b) && !isDisabled(b) && /^(save|create|save preset|confirm|done|apply)$/i.test(norm(b.textContent))
      && nameInput.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!confirm) {
      throw new StepError(`Typed ${PRESET.name}, but found no button to confirm it. Nothing was saved — press Cancel.`, scope);
    }
    ui.info(`confirm: "${norm(confirm.textContent)}" in ${scope === document.body ? 'page' : 'dialog'}`);
    press(confirm);

    const closed = await waitFor(() => !locateDialog(colBtn), 8000);
    if (!closed) {
      const alert = [...document.querySelectorAll('[role="alert"]')].find((el) => isVisible(el) && norm(el.textContent));
      throw new StepError(
        `Ads Manager kept the dialog open${alert ? `: "${norm(alert.textContent)}"` : ''}.`,
        locateDialog(colBtn)?.dialog,
      );
    }
    const named = await waitFor(() => { const b = findColumnsButton(); return b && saysPreset(b); }, 5000);
    if (!named) {
      ui.note(`Saved, but the Columns button doesn't say ${PRESET.name} — check the Columns menu.`);
      return 'warn';
    }
    return 'ok';
  }

  /* ---------------- звіт ---------------- */

  // Скелет меню чи діалогу для звіту: ролі, підписи й власний текст, без класів.
  function outline(root, limit = 300) {
    const lines = [];
    (function walk(el, depth) {
      if (lines.length >= limit || !(el instanceof Element) || el === host) return;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const aria = el.getAttribute('aria-label');
      const own = norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join(' '));
      const keep = Boolean(role || aria || own || tag === 'input' || tag === 'button');
      if (keep && isVisible(el)) {
        let line = '  '.repeat(Math.min(depth, 20)) + tag;
        if (role) line += `[role=${role}]`;
        if (tag === 'input') line += `[type=${el.type}]${el.checked ? '[checked]' : ''}`;
        if (isDisabled(el)) line += '[disabled]';
        if (aria) line += ` aria="${aria.slice(0, 60)}"`;
        if (own) line += ` "${own.slice(0, 60)}"`;
        lines.push(line);
      }
      for (const c of el.children) walk(c, depth + (keep ? 1 : 0));
    })(root, 0);
    return lines.join('\n');
  }

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
    } else if (error instanceof StepError) {
      parts.push('', '--- dialog/menu outline ---', error.root ? outline(error.root) : '(none)');
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
        place();
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
      place();
    }

    // Над відкритим діалогом Ads Manager панель не стоїть: на реальному прогоні 23.09 вона
    // перекривала «Save». Ставимо її збоку від діалогу — там лише затемнений фон.
    function place() {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .map((d) => d.getBoundingClientRect())
        .filter((r) => r.width > 300 && r.height > 200)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
      panel.style.left = panel.style.right = panel.style.width = '';
      if (!dialog) return;
      const gap = 8;
      const onRight = innerWidth - dialog.right >= dialog.left;
      const room = (onRight ? innerWidth - dialog.right : dialog.left) - gap * 2;
      panel.style.width = `${Math.max(200, Math.min(300, room))}px`;
      if (onRight) panel.style.right = `${gap}px`;
      else { panel.style.left = `${gap}px`; panel.style.right = 'auto'; }
    }
    addEventListener('resize', () => { if (!panel.hidden) place(); });

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
        let result = await verify(ui);
        // Пресет — лише на клік: закладка з columns=ADV нічого в акаунті не зберігає.
        if (result === 'ok' && !quiet) result = await ensurePreset(ui);
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
          : error instanceof StepError
            ? error.message
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
