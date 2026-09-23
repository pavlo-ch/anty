/*
 * ADV columns — один клік ставить пресет колонок ADV в Ads Manager. Вбудовано в Anty.
 *
 * Це НЕ модуль Node: файл читається як текст і виконується в кожній вкладці профілю в
 * ізольованому світі (див. src/main/adv-columns.js) — як контент-скрипт розширення, але
 * без розширення і без порту налагодження. Сторінка Facebook не бачить його змінних;
 * спільний з нею лише DOM (кнопка в shadow DOM).
 *
 * Робить те саме, що людина руками: Columns → Customize columns → зняти всі колонки →
 * відмітити потрібні по одній у заданому порядку (Ads Manager дописує щойно відмічену
 * колонку в кінець списку, тож порядок кліків = порядок колонок) → Save ▾ → Save as new
 * preset → «ADV» → Save. Якщо пресет ADV уже є (Recently used або View your column
 * presets) — просто застосовує його, другого не створює.
 *
 * Прогнано на справжньому Ads Manager 23.09.2026 (профіль «Facebook Maria Shevchyk»).
 * Коментарі «перевірено 23.09.2026» нижче — те, що там з'ясувалось про верстку.
 *
 * Класи у верстці Facebook обфусковані й міняються з релізами, тому елементи шукаються
 * лише за видимим текстом і ARIA-ролями. Звідси вимога: інтерфейс Ads Manager англійською.
 *
 * Нічого не зберігається, доки список у діалозі не звірено з пресетом: якщо щось не
 * знайшлось чи порядок не той — зупинка з відкритим діалогом (Cancel нічого не змінить)
 * і звіт, який можна скопіювати дев'ю.
 */
(function () {
  // Скрипт приходить у кожен документ профілю; працює лише у вкладці Ads Manager.
  if (window.top !== window || window.__advColumns) return;
  if (!/^(adsmanager|business)\.facebook\.com$/.test(location.hostname)) return;
  window.__advColumns = true;
  // business.facebook.com — одна сторінка на весь Business Suite, Ads Manager там лише
  // розділ; перехід усередині неї не перезавантажує документ.
  const onAdsManager = () => location.pathname.startsWith('/adsmanager');

  // Набір і порядок — зі скрінів дева (23.09.2026), 1 → 2 → 3. Назви — дослівно як у
  // діалозі «Customize columns» англійського інтерфейсу: за ними шукаються колонки.
  // Колонку «Campaign» («Ad set» / «Ad») Ads Manager закріплює сам.
  const PRESET = {
    name: 'ADV',
    columns: [
      // скрін 1
      'Delivery',
      'Actions',
      'Budget',
      'Amount spent',
      'Impressions',
      'Reach',
      'CPM (cost per 1,000 impressions)',
      'CTR (all)',
      'CPC (all)',
      'Clicks (all)',
      // скрін 2 надіслано дублем скріну 1: у діалозі «26 columns selected», а видно 20,
      // тож ~6 колонок між «Clicks (all)» і «Results» ще не відомі.
      // скрін 3
      'Results',
      'Cost per result',
      'Video average play time',
      'Video plays at 25%',
      'Video plays at 75%',
      'Video plays at 50%',
      'Post engagements',
      'Post reactions',
      'Post comments',
    ],
  };
  const CHECKBOX = 'input[type="checkbox"], [role="checkbox"]';
  const CLICKABLE = 'button, a, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [tabindex]';
  const COUNT_RE = /^(\d+) columns? selected$/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  let host = null; // наш shadow-host: його вміст ніколи не вважаємо частиною Ads Manager

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1; // 1×1 — прихований підпис для скрінрідера, не елемент
  }

  async function waitFor(fn, timeout, every = 150) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() > end) return null;
      await sleep(every);
    }
  }

  /* ---------------- пошук за текстом ---------------- */

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

  // Рядок навколо el, у якому рівно один чекбокс: { box, row } або null.
  function checkboxRow(el, boundary) {
    const own = el.closest(CHECKBOX);
    if (own && boundary.contains(own)) return { box: own, row: own };
    for (let a = el, i = 0; a && a !== boundary && i < 8; a = a.parentElement, i++) {
      const boxes = a.querySelectorAll(CHECKBOX);
      if (boxes.length === 1) return { box: boxes[0], row: a };
      if (boxes.length > 1) return null; // дійшли до контейнера зі списком — рядок не той
    }
    return null;
  }

  function checkboxNear(el, boundary) {
    const hit = checkboxRow(el, boundary);
    return hit && hit.box;
  }

  // Текст рядка = назва колонки; дозволено лише хвіст без літер і цифр (іконка «ⓘ»).
  // «Amount spent percentage» чи «Unique CTR (all)» назвами «Amount spent» / «CTR (all)» не є.
  function sameLabel(text, label) {
    const t = norm(text).replace(/\u200b/g, '').toLowerCase();
    const want = norm(label).toLowerCase();
    return t === want || (t.startsWith(want) && !/[\p{L}\p{N}]/u.test(t.slice(want.length)));
  }

  const isChecked = (box) => box.checked === true || box.getAttribute('aria-checked') === 'true';
  const isDisabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true';

  /* ---------------- дії, як від людини ---------------- */

  function press(el) {
    if (el instanceof HTMLInputElement) {
      el.click(); // нативний checkbox сам згенерує click/input/change
      return;
    }
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

  /* ---------------- Ads Manager ---------------- */

  function findColumnsButton() {
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (host && host.contains(el)) continue;
      const label = norm(el.getAttribute('aria-label')) || norm(el.textContent);
      if (/^columns\b/i.test(label) && isVisible(el)) return el;
    }
    return null;
  }

  // Діалог «Customize columns» зі всім, що в ньому потрібно. Шукається заново щоразу:
  // React перемальовує список після кожного кліку, і старі посилання відвалюються.
  // Спершу — у вже знайденому діалозі: весь DOM Ads Manager сканувати дорого.
  let lastDialog = null;
  function locateDialog(anchor) {
    const count = pattern(COUNT_RE, /selected/i);
    let countEl = lastDialog && lastDialog.isConnected ? findText(lastDialog, ...count)[0] : null;
    if (!countEl) countEl = findText(document.body, ...count)[0];
    if (!countEl) return null;
    const dialog = countEl.closest('[role="dialog"]') || popupRoot(countEl, anchor);
    lastDialog = dialog;
    const inputs = [...dialog.querySelectorAll('input')]
      .filter((i) => isVisible(i) && ['text', 'search', ''].includes(i.type));
    const search = inputs.find((i) => /search/i.test(i.placeholder || i.getAttribute('aria-label') || '')) || inputs[0];
    if (!search) return { dialog, countEl, search: null, pane: null };
    // Права панель «N columns selected»: найвищий предок лічильника, що ще не містить пошуку.
    let pane = countEl;
    while (pane.parentElement && pane.parentElement !== dialog && !pane.parentElement.contains(search)) {
      pane = pane.parentElement;
    }
    return { dialog, countEl, search, pane };
  }

  const readCount = (ctx) => (ctx ? Number(COUNT_RE.exec(norm(ctx.countEl.textContent))[1]) : null);

  // «Прибрати» в рядку правої панелі. В Ads Manager (перевірено 23.09.2026) це
  // div[role=button] з іконкою X і візуально прихованим текстом «Remove», без aria-label.
  // Запасний варіант — кнопка-іконка без тексту; ручка перетягування зліва, X — справа,
  // тому першою пробується найправіша.
  function removeCandidates(ctx, tried) {
    const all = [...ctx.pane.querySelectorAll('button, [role="button"]')]
      .filter((b) => isVisible(b) && !isDisabled(b) && !b.contains(ctx.countEl) && !tried.has(b));
    const says = (b) => norm(b.getAttribute('aria-label')) || norm(b.textContent).replace(/​/g, '');
    const labelled = all.filter((b) => /^(remove|delete)\b/i.test(says(b)));
    const picked = labelled.length ? labelled : all.filter((b) => !/[\p{L}\p{N}]/u.test(b.textContent));
    const right = (b) => b.getBoundingClientRect().right;
    const top = (b) => b.getBoundingClientRect().top;
    return picked.sort((a, b) => right(b) - right(a) || top(a) - top(b));
  }

  // Найближчий не-inline предок: рядок тексту, в якому стоїть елемент.
  function textBlock(el, boundary) {
    let block = el;
    while (block.parentElement && block.parentElement !== boundary
      && ['inline', 'contents'].includes(getComputedStyle(block).display)) block = block.parentElement;
    return block;
  }

  // Пошук Facebook підсвічує збіг вкладеним inline-span: «Post re|actions|» містить
  // фрагмент «actions», що дорівнює «Actions». Тому назва звіряється з усім рядком тексту
  // (блоком), а не з фрагментом; хлібні крихти «Engagement > …» — окремий блок і не заважають.
  // Перевірено 23.09.2026: без цього відмічались Post reactions, Unique CTR (all) тощо.
  function checkboxFor(ctx, label) {
    for (const el of findText(ctx.dialog, ...exactly(label))) {
      if (ctx.pane.contains(el)) continue;
      if (!sameLabel(textBlock(el, ctx.dialog).textContent, label)) continue;
      const box = checkboxNear(el, ctx.dialog);
      if (box) return box;
    }
    return null;
  }

  // «CPM (cost per 1,000 impressions)» пошук Facebook може не знайти повністю — тоді
  // шукаємо коротшою частиною, а звіряємо все одно повну назву.
  function searchTerms(label) {
    const short = label.split(' (')[0];
    return short !== label ? [label, short] : [label];
  }

  // Порядок у правій панелі. Панель може не рендерити прокручені рядки, тож перевіряємо
  // те, що видно: порядок знайдених має збігатися з пресетом, а лічильник — з розміром.
  function checkOrder(ctx, labels) {
    const found = [];
    for (const label of labels) {
      const el = findText(ctx.pane, ...exactly(label))[0];
      if (el) found.push({ label, el });
    }
    found.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const seen = found.map((f) => f.label);
    const expected = labels.filter((l) => seen.includes(l));
    const wrongAt = seen.findIndex((l, i) => l !== expected[i]);
    return { seen, wrongAt, notVisible: labels.filter((l) => !seen.includes(l)) };
  }

  function tableHeaders() {
    return [...document.querySelectorAll('[role="columnheader"]')]
      .filter((h) => isVisible(h) && !(host && host.contains(h)))
      .map((h) => norm(h.textContent));
  }

  // Таблиця рендерить лише колонки в межах видимої ширини, тож «не видно» ≠ «немає».
  // Звіряємо порядок тих, що відрендерені, і що їх достатньо, щоб це щось доводило.
  function headersMatch(labels) {
    const headers = tableHeaders().map((h) => h.toLowerCase());
    const positions = labels
      .map((label) => ({ label, at: headers.findIndex((h) => sameLabel(h, label)) }))
      .filter((p) => p.at !== -1);
    const outOfOrder = positions.filter((p, i) => i > 0 && p.at < positions[i - 1].at).map((p) => p.label);
    // Перші колонки пресету мають бути на екрані завжди — інакше це не наш набір.
    const leading = labels.slice(0, 5).filter((l) => !positions.some((p) => p.label === l));
    return { total: headers.length, seen: positions.length, outOfOrder, leading };
  }

  /* ---------------- сценарій ---------------- */

  class StepError extends Error {
    constructor(message, root) {
      super(message);
      this.root = root; // що покласти у звіт: меню, діалог або сторінку
    }
  }

  async function run(ui) {
    const labels = PRESET.columns;

    ui.step('Open the Columns menu');
    const colBtn = await waitFor(findColumnsButton, 15000);
    if (!colBtn) {
      const lang = document.documentElement.lang || 'unknown';
      throw new StepError(
        `Couldn't find the Columns button. Open the campaigns table first` +
        (/^en/i.test(lang) ? '.' : ` and switch Ads Manager to English (now: ${lang}).`),
        null,
      );
    }
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
    const opened = await waitFor(() => {
      const m = menuEl();
      return (m && findText(m, ...customize)[0] && m) || locateDialog(colBtn);
    }, 15000); // одразу після завантаження сторінки меню секунди зо три-п'ять показує «Loading...»
    if (!opened) throw new StepError("The Columns menu didn't open, or it has no Customize columns item.", menuEl());

    if (opened instanceof Element) {
      ui.step(`Look for the ${PRESET.name} preset`);
      // Власні пресети: у «Recently used» або всередині «View your column presets».
      let existing = findText(opened, ...exactly(PRESET.name))[0];
      if (!existing) {
        const yours = findText(opened, ...pattern(/^view your (column )?presets$/i, /view|presets/i))[0];
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
        press(existing.closest(CLICKABLE) || existing);
        ui.note(`${PRESET.name} already exists — applied it instead of creating a second one.`);
        await sleep(1500);
        return verifyTable(ui, labels, true);
      }

      ui.step('Open Customize columns');
      const item = findText(menuEl() || opened, ...customize)[0];
      if (!item) throw new StepError("Lost the Customize columns item in the Columns menu.", menuEl());
      press(item.closest(CLICKABLE) || item);
    }

    let ctx = await waitFor(() => {
      const c = locateDialog(colBtn);
      return c && c.search ? c : null;
    }, 15000); // діалог — модуль, що довантажується: перший раз буває повільно
    if (!ctx) throw new StepError("Customize columns didn't open, or it has no search field.", locateDialog(colBtn)?.dialog);

    ui.step('Clear the current columns');
    const tried = new WeakSet();
    for (let guard = 0; ; guard++) {
      ctx = locateDialog(colBtn);
      const before = readCount(ctx);
      const candidates = removeCandidates(ctx, tried);
      if (!candidates.length) break;
      if (guard > 200) throw new StepError('Clearing the columns never finished.', ctx.dialog);
      press(candidates[0]);
      const dropped = await waitFor(() => {
        const c = locateDialog(colBtn);
        return c && readCount(c) < before;
      }, 1500);
      if (!dropped) tried.add(candidates[0]); // це був не «прибрати» — наступний кандидат
    }
    const fixed = readCount(locateDialog(colBtn));

    const missing = [];
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      ui.step(`Add columns ${i + 1}/${labels.length}: ${label}`);
      let status = 'missing';
      for (const term of searchTerms(label)) {
        typeInto(locateDialog(colBtn).search, term);
        const box = await waitFor(() => checkboxFor(locateDialog(colBtn), label), 4000);
        if (!box) continue;
        if (isChecked(box)) { status = 'ok'; break; }
        const before = readCount(locateDialog(colBtn));
        press(box);
        const added = await waitFor(() => readCount(locateDialog(colBtn)) > before, 2000);
        status = added ? 'ok' : 'stuck';
        break;
      }
      if (status !== 'ok') missing.push(status === 'stuck' ? `${label} (checkbox didn't react)` : label);
    }
    ctx = locateDialog(colBtn);
    typeInto(ctx.search, '');
    if (missing.length) {
      throw new StepError(
        `Not found in Customize columns: ${missing.join(', ')}. Nothing was saved — press Cancel in the dialog.`,
        ctx.dialog,
      );
    }

    ui.step('Check the order');
    await sleep(300);
    ctx = locateDialog(colBtn);
    const order = checkOrder(ctx, labels);
    const count = readCount(ctx);
    if (order.wrongAt !== -1 || count !== fixed + labels.length) {
      const where = order.wrongAt !== -1 ? ` First out of place: ${order.seen[order.wrongAt]}.` : '';
      throw new StepError(
        `The list in the dialog doesn't match the preset (${count} selected, expected ${fixed + labels.length}).${where} ` +
        'Nothing was saved — press Cancel in the dialog.',
        ctx.dialog,
      );
    }

    ui.step(`Save as ${PRESET.name}`);
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
      const item = await waitFor(() => {
        const found = findText(document.body, ...pattern(/^save as( a)? new (column )?preset$/i, /save|preset/i));
        return found.find((el) => el.closest('[role="menu"], [role="menuitem"]')) || found[0] || null;
      }, 4000);
      if (!item) throw new StepError("The Save menu has no 'Save as new preset'. Nothing was saved — press Cancel.", ctx.dialog);
      press(item.closest(CLICKABLE) || item);
    } else {
      const saveLabel = findText(ctx.dialog, ...pattern(/^save\b.*\bpreset$/i, /save|preset/i))[0];
      const saveBox = saveLabel && checkboxNear(saveLabel, ctx.dialog);
      if (!saveBox) throw new StepError("Couldn't find how to save a preset here. Nothing was saved — press Cancel.", ctx.dialog);
      if (!isChecked(saveBox)) press(saveBox);
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
    await sleep(1500);
    return verifyTable(ui, labels, false);
  }

  function verifyTable(ui, labels, reused) {
    ui.step('Check the table');
    const colBtn = findColumnsButton();
    const active = colBtn && new RegExp(`\\b${PRESET.name}\\b`).test(norm(colBtn.textContent));
    const { total, seen, outOfOrder, leading } = headersMatch(labels);
    if (!total) {
      ui.note("Couldn't read the table headers to double-check.");
    } else if (outOfOrder.length || leading.length) {
      const what = outOfOrder.length ? `out of order: ${outOfOrder.join(', ')}` : `missing: ${leading.join(', ')}`;
      ui.note(
        `Table columns don't match the preset (${what}).` +
        (reused ? ` The existing ${PRESET.name} preset differs from this list — rename or remove it and click again.` : ''),
      );
      return 'warn';
    }
    if (colBtn && !active) {
      ui.note(`The Columns button doesn't say ${PRESET.name} — check the menu.`);
      return 'warn';
    }
    ui.info(`table: ${seen} of ${labels.length} preset columns on screen, in order`);
    return active || total ? 'ok' : 'warn';
  }

  /* ---------------- звіт ---------------- */

  function outline(root, limit = 300) {
    const lines = [];
    (function walk(el, depth) {
      if (lines.length >= limit || !(el instanceof Element) || el === host) return;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const aria = el.getAttribute('aria-label');
      const ph = el.getAttribute('placeholder');
      const own = norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join(' '));
      const keep = Boolean(role || aria || ph || own || tag === 'input' || tag === 'button');
      if (keep && isVisible(el)) {
        let line = '  '.repeat(Math.min(depth, 20)) + tag;
        if (role) line += `[role=${role}]`;
        if (tag === 'input') line += `[type=${el.type}]${el.checked ? '[checked]' : ''}`;
        if (el.getAttribute('aria-checked')) line += `[aria-checked=${el.getAttribute('aria-checked')}]`;
        if (isDisabled(el)) line += '[disabled]';
        if (aria) line += ` aria="${aria.slice(0, 60)}"`;
        if (ph) line += ` placeholder="${ph.slice(0, 40)}"`;
        if (own) line += ` "${own.slice(0, 60)}"`;
        lines.push(line);
      }
      for (const c of el.children) walk(c, depth + (keep ? 1 : 0));
    })(root, 0);
    return lines.join('\n');
  }

  function buildReport(log, error) {
    const parts = [
      `ADV columns · Anty ${typeof __ANTY_VERSION === 'string' ? __ANTY_VERSION : ''} · ${new Date().toISOString()}`,
      `Page: ${location.host}${location.pathname} · lang=${document.documentElement.lang || '?'}`,
      '',
      ...log,
      '',
      `Error: ${error.message}`,
    ];
    if (error.root) {
      parts.push('', '--- dialog/menu outline ---', outline(error.root));
    } else {
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .filter((b) => isVisible(b) && !(host && host.contains(b)))
        .slice(0, 60)
        .map((b) => `- ${norm(b.getAttribute('aria-label')) || norm(b.textContent).slice(0, 60) || '(no text)'}`);
      parts.push('', '--- visible buttons ---', ...buttons);
    }
    if (!(error instanceof StepError)) parts.push('', String(error.stack || ''));
    return parts.join('\n');
  }

  /* ---------------- інтерфейс ---------------- */

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
    ol { margin: 0; padding-left: 18px; max-height: 180px; overflow-y: auto; }
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
        <div class="title">${PRESET.name} column preset</div>
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
        li.textContent = text; // назви колонок — лише через textContent
        // Кроки «Add columns i/N» оновлюють один рядок, а не плодять 19.
        const last = list.lastElementChild;
        if (last && /^Add columns /.test(last.textContent) && /^Add columns /.test(text)) last.replaceWith(li);
        else list.appendChild(li);
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

    // Над відкритим діалогом Ads Manager панель не стоїть: на реальному прогоні вона
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

    let runs = 0;
    fab.addEventListener('click', async () => {
      const runId = ++runs;
      fab.disabled = true;
      panel.hidden = false;
      list.textContent = '';
      msg.hidden = true;
      copyBtn.hidden = true;
      area.hidden = true;
      log = [];
      try {
        const result = await run(ui);
        list.querySelector('li.cur')?.classList.remove('cur');
        if (result === 'ok') {
          const extra = msg.hidden ? '' : ` ${msg.textContent}`;
          show('ok', `${PRESET.name} is on.${extra}`);
          // Панель стоїть над Ads Manager — після успіху прибираємо її, щоб не заважала.
          setTimeout(() => { if (runId === runs && !fab.disabled) panel.hidden = true; }, 5000);
        }
      } catch (error) {
        console.error('[ADV columns]', error); // повний слід лишається в консолі
        report = buildReport(log, error);
        show('err', error instanceof StepError ? error.message : 'Something broke inside the extension. Copy the report and send it to the dev.');
        copyBtn.hidden = false;
      } finally {
        fab.disabled = false;
      }
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
  }

  // Скрипт виконується ще до розбору сторінки; кнопку ставимо, коли DOM готовий —
  // як розширення з run_at: document_idle, на якому це й перевірялось.
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
