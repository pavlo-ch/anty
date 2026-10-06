/*
 * USD — кнопка-тумблер на Facebook: суми не в доларах показати в доларах. Вбудовано в Anty.
 *
 * Це НЕ модуль Node: файл читається як текст і виконується в кожній вкладці профілю в
 * ізольованому світі (див. src/main/usd-toggle.js). Перед ним підставляється
 * `const __ANTY_FX = { date, rates }` — ринковий курс дня, 1 USD = rates[КОД] КОД.
 *
 * Як працює:
 * - Кнопка з'являється лише там, де на сторінці є сума в іншій валюті (₴, €, UAH, zł…).
 *   В Ads Manager вона стоїть ліворуч від ADV columns.
 * - Увімкнено: кожна така сума в тексті сторінки показується як $1,234.56 (англійський
 *   формат), оригінал — у підказці при наведенні. Нові й перемальовані React-ом вузли
 *   підхоплюються на льоту. Вимкнено: усе повертається як було.
 * - Змінюється лише текст на екрані: поля вводу, редактори й сам акаунт не чіпаються.
 * - Вибір запам'ятовується для сайту (localStorage), тож таблиця відкривається в доларах.
 *
 * Валюта впізнається за символом чи кодом так, як їх пише англійський Facebook (Intl
 * en-US: «UAH 1,234.56», «€1,234.56», «₹…»), плюс вузькі символи (₴, zł, Kč) і «грн».
 * Символи, що належать кільком валютам ($, kr, ¥ без префікса), не беруться: інакше
 * доларові суми чи чужі кроні «конвертувались» би навмання.
 */
(function () {
  if (window.top !== window || window.__antyUsd) return;
  if (!/(^|\.)facebook\.com$/.test(location.hostname)) return;
  window.__antyUsd = true;

  const FX = typeof __ANTY_FX === 'object' && __ANTY_FX && __ANTY_FX.rates ? __ANTY_FX : null;
  if (!FX) return; // курсу немає (ні мережі, ні кешу) — кнопки теж немає
  const STORE_KEY = '__antyUsdOn';

  /* ---------------- розпізнавання сум ---------------- */

  function currencyTokens() {
    const owners = new Map(); // токен → множина кодів
    const add = (token, code) => {
      if (!token || token === '$' || token === 'US$') return;
      if (!owners.has(token)) owners.set(token, new Set());
      owners.get(token).add(code);
    };
    for (const code of Object.keys(FX.rates)) {
      if (code === 'USD' || !(FX.rates[code] > 0)) continue;
      add(code, code);
      for (const display of ['symbol', 'narrowSymbol']) {
        try {
          const part = new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: display })
            .formatToParts(1).find((p) => p.type === 'currency');
          if (part && part.value !== code) add(part.value.trim(), code);
        } catch (_) {}
      }
    }
    if (FX.rates.UAH) add('грн', 'UAH');
    // Коди, що читаються як англійські слова чи назви («TOP 10», «ALL 3», «AMD 5»), і
    // короткі латинські символи (K, L, Ft) дали б хибні «конвертації» — не беремо.
    const WORDS = new Set(['ALL', 'TOP', 'CUP', 'PEN', 'SOS', 'GEL', 'MOP', 'BAM', 'BOB', 'TRY', 'MAD', 'AMD', 'LAK', 'ERN', 'MRU']);
    const safe = (token) => !WORDS.has(token) && (!/^[A-Za-z]+$/.test(token) || /^[A-Z]{3}$/.test(token));
    const tokens = new Map();
    for (const [token, codes] of owners) if (codes.size === 1 && safe(token)) tokens.set(token, [...codes][0]);
    return tokens;
  }

  const TOKENS = currencyTokens();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Довші першими: «CA$» раніше за «A$», «HK$» раніше за «K»-що-завгодно.
  const TOK = [...TOKENS.keys()].sort((a, b) => b.length - a.length).map(esc).join('|');
  const NUM = String.raw`\d{1,3}(?:[,.\u00a0\u202f ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
  const SFX = '[KMB]';
  const SP = '[\\u00a0\\u202f ]?';
  const MONEY = new RegExp(
    String.raw`(?<![\p{L}\d])(-?)(?:(${TOK})${SP}(${NUM})(${SFX})?|(${NUM})(${SFX})?${SP}(${TOK}))(?![\p{L}\d])`,
    'gu',
  );
  const PROBE = new RegExp(`(?:${TOK})`, 'u'); // дешевий відсів вузлів без жодного токена

  // «1,234.56», «1 234,56», «1.234,56», «12,5» → число. Останній роздільник з 1–2 цифрами
  // після нього — десятковий, решта — тисячі.
  function parseNumber(raw) {
    const s = raw.replace(/[\u00a0\u202f ]/g, '');
    const last = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    if (last === -1) return Number(s);
    const tail = s.length - last - 1;
    if (tail >= 1 && tail <= 2) return Number(`${s.slice(0, last).replace(/[,.]/g, '')}.${s.slice(last + 1)}`);
    return Number(s.replace(/[,.]/g, ''));
  }

  const SCALE = { K: 1e3, M: 1e6, B: 1e9 };
  const exact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

  function toUsd(text) {
    let changed = false;
    const out = text.replace(MONEY, (match, minus, tokA, numA, sfxA, numB, sfxB, tokB) => {
      const code = TOKENS.get(tokA || tokB);
      const rate = code && FX.rates[code];
      const value = parseNumber(numA || numB);
      if (!rate || !Number.isFinite(value)) return match;
      const suffix = sfxA || sfxB;
      const usd = (value * (suffix ? SCALE[suffix] : 1)) / rate;
      changed = true;
      return (minus ? '-' : '') + (suffix ? compact : exact).format(usd);
    });
    return changed ? out : null;
  }

  /* ---------------- текст сторінки ---------------- */

  let host = null;
  const SKIP = 'script, style, noscript, textarea, input, select, [contenteditable=""], [contenteditable="true"]';
  const original = new WeakMap(); // вузол → текст до нас
  const written = new WeakMap(); // вузол → текст, який поставили ми
  const titled = new Map(); // елемент → його title до нас (null — не було)
  const touched = new Set(); // вузли, які зараз показують долари

  function skippable(node) {
    const el = node.parentElement;
    return !el || (host && host.contains(el)) || Boolean(el.closest(SKIP));
  }

  function convert(node) {
    if (skippable(node)) return;
    const data = node.data;
    if (written.get(node) === data) return; // наш же текст
    if (!PROBE.test(data)) return;
    const usd = toUsd(data);
    if (usd === null) return;
    original.set(node, data);
    written.set(node, usd);
    touched.add(node);
    node.data = usd;
    const el = node.parentElement;
    if (!titled.has(el)) titled.set(el, el.getAttribute('title'));
    el.setAttribute('title', `${data.trim()} · market rate ${FX.date ? FX.date.replace(/ \d\d:\d\d:\d\d.*$/, '') : ''}`.trim());
  }

  function walk(root, visit, limit = Infinity) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n = 0;
    for (let node = walker.nextNode(); node && n < limit; node = walker.nextNode(), n += 1) {
      if (visit(node) === true) return true;
    }
    return false;
  }

  function hasForeignMoney() {
    if (!document.body) return false;
    return walk(document.body, (node) => {
      if (!PROBE.test(node.data) || skippable(node)) return false;
      MONEY.lastIndex = 0;
      return MONEY.test(node.data);
    }, 40000);
  }

  let on = false;
  let queue = new Set();
  let scheduled = false;
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') queue.add(r.target);
      else for (const n of r.addedNodes) queue.add(n);
    }
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(flushQueue);
    }
  });

  function flushQueue() {
    scheduled = false;
    const batch = queue;
    queue = new Set();
    if (!on) return;
    for (const n of batch) {
      if (!n.isConnected) continue;
      if (n.nodeType === Node.TEXT_NODE) convert(n);
      else if (n.nodeType === Node.ELEMENT_NODE) walk(n, (t) => { convert(t); });
    }
  }

  function enable() {
    on = true;
    walk(document.body, (t) => { convert(t); });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function disable() {
    on = false;
    observer.disconnect();
    queue.clear();
    for (const node of touched) {
      // Вузол, який React уже переписав своїм текстом, лишаємо як є.
      if (node.isConnected && written.get(node) === node.data) node.data = original.get(node);
      written.delete(node);
    }
    touched.clear();
    for (const [el, title] of titled) {
      if (title === null) el.removeAttribute('title');
      else el.setAttribute('title', title);
    }
    titled.clear();
  }

  /* ---------------- кнопка ---------------- */

  const CSS = `
    :host { all: initial; }
    button { position: fixed; bottom: 20px; z-index: 2147483000; box-sizing: border-box; padding: 8px 14px;
      border: 1px solid #1c2b33; border-radius: 6px; background: #fff; color: #1c2b33; cursor: pointer;
      font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,.2); }
    button[aria-pressed="true"] { background: #1c2b33; color: #fff; }
  `;

  // В Ads Manager ліворуч від ADV columns (та кнопка — right: 20px, ~112px завширшки).
  const onAdsManager = () => location.hostname === 'adsmanager.facebook.com' || location.pathname.startsWith('/adsmanager');

  function mountUi() {
    host = document.createElement('div');
    host.id = 'anty-usd-host';
    host.style.display = 'none';
    const shadow = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (_) {
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'USD';
    btn.setAttribute('aria-pressed', 'false');
    btn.title = `Show amounts in US dollars (market rate${FX.date ? ` of ${FX.date.replace(/ \d\d:\d\d:\d\d.*$/, '')}` : ''})`;
    shadow.appendChild(btn);
    document.documentElement.appendChild(host);

    const remember = (value) => { try { localStorage.setItem(STORE_KEY, value ? '1' : '0'); } catch (_) {} };
    const wanted = () => { try { return localStorage.getItem(STORE_KEY) === '1'; } catch (_) { return false; } };
    const render = () => {
      btn.setAttribute('aria-pressed', String(on));
      btn.style.right = onAdsManager() ? '140px' : '20px';
    };

    btn.addEventListener('click', () => {
      if (on) disable(); else enable();
      remember(on);
      render();
    });

    // Кнопку показуємо, щойно на сторінці знайшлась чужа валюта, і тримаємо до переходу
    // на іншу адресу (SPA Facebook міняє її без перезавантаження).
    let found = false;
    let href = location.href;
    const tick = () => {
      if (location.href !== href) {
        href = location.href;
        if (!on) { found = false; host.style.display = 'none'; }
      }
      if (!found && document.visibilityState === 'visible' && hasForeignMoney()) {
        found = true;
        host.style.display = '';
        if (!on && wanted()) enable();
      }
      render();
    };
    tick();
    setInterval(tick, 3000);
  }

  const start = () => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      return;
    }
    mountUi();
  };
  start();
})();
