/**
 * Переклад інтерфейсу Anty: англійська (вихідна) і китайська zh-CN.
 *
 * Ключ словника — сам англійський рядок, як він стоїть у розмітці чи в main.js.
 * Тому main.js майже не знає про переклад: цей файл стежить за вікном
 * (MutationObserver) і підміняє англійський текст у вузлах і атрибутах title /
 * placeholder / aria-label, щойно той зʼявляється — у списку, тості, модалці.
 * Рядок зі змінними записаний у словнику з {0}, {1}… і перекладається як шаблон.
 *
 * Мова: ?lang= в адресі чи cookie ba_lang (так її передає платформа у вебверсії) → вибір у
 * Settings → мова системи. Зміна мови перезавантажує вікно: так простіше, ніж
 * повертати англійський текст на місце.
 *
 * Словники кладуть себе в window.ANTY_I18N_DICTS[мова] (i18n-zh.js).
 */
(function () {
  const STORE_KEY = 'anty.language'; // 'auto' | 'en' | 'zh-CN'
  const SUPPORTED = ['en', 'zh-CN'];

  function normalize(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v.startsWith('zh')) return 'zh-CN';
    if (v.startsWith('en')) return 'en';
    return null;
  }

  function readStored() {
    try { return localStorage.getItem(STORE_KEY) || 'auto'; } catch (_) { return 'auto'; }
  }

  function systemLanguage() {
    const list = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language];
    for (const l of list) {
      const n = normalize(l);
      if (n) return n;
    }
    return 'en';
  }

  function resolveLanguage() {
    const fromUrl = normalize(new URLSearchParams(location.search).get('lang'));
    if (fromUrl) return fromUrl;
    // Вебверсія на платформі: мова платформи в cookie ba_lang (у десктопі його немає).
    const fromCookie = normalize((document.cookie.match(/(?:^|;\s*)ba_lang=([^;]+)/) || [])[1]);
    if (fromCookie) return fromCookie;
    const stored = readStored();
    if (SUPPORTED.includes(stored)) return stored;
    return systemLanguage();
  }

  const lang = resolveLanguage();
  const dict = (window.ANTY_I18N_DICTS && window.ANTY_I18N_DICTS[lang]) || null;
  const active = lang !== 'en' && !!dict;

  // Точні рядки й шаблони окремо: шаблон «Failed: {0}» стає регулярним виразом.
  const exact = new Map();
  const patterns = [];
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  if (active) {
    for (const [source, target] of Object.entries(dict)) {
      if (target == null || target === '') continue;
      const key = squash(source);
      if (!/\{\d+\}/.test(key)) { exact.set(key, target); continue; }
      const order = [];
      const re = key
        .split(/(\{\d+\})/)
        .map((part) => {
          const m = part.match(/^\{(\d+)\}$/);
          if (m) { order.push(Number(m[1])); return '([\\s\\S]*?)'; }
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('');
      patterns.push({ re: new RegExp('^' + re + '$'), order, target, weight: key.replace(/\{\d+\}/g, '').length });
    }
    // Довший сталий текст — точніший шаблон: «Failed to save profile: {0}» раніше за «Failed: {0}».
    patterns.sort((a, b) => b.weight - a.weight);
  }

  function fill(target, values) {
    return target.replace(/\{(\d+)\}/g, (_, i) => (values[Number(i)] != null ? values[Number(i)] : ''));
  }

  /** Переклад рядка; null — перекладу немає (лишаємо як є). */
  function lookup(text) {
    if (!active) return null;
    const key = squash(text);
    if (!key || !/[A-Za-z]/.test(key)) return null;
    if (exact.has(key)) return exact.get(key);
    for (const p of patterns) {
      const m = key.match(p.re);
      if (!m) continue;
      const values = [];
      p.order.forEach((idx, k) => {
        const raw = m[k + 1];
        // Значення в шаблоні теж може бути рядком інтерфейсу («Failed: Profile is not running»).
        values[idx] = lookup(raw) || raw;
      });
      return fill(p.target, values);
    }
    // «Failed to launch: <помилка>» — префікс зі словника, решта перекладається окремо.
    const m = key.match(/^([^:]{2,80}):\s+([\s\S]+)$/);
    if (m) {
      const head = exact.get(m[1] + ':') || exact.get(m[1]);
      if (head) return head.replace(/[:：]\s*$/, '') + '：' + (lookup(m[2]) || m[2]);
    }
    return null;
  }

  /** Для коду: t('Saved'), t('Failed: {0}', msg). Без перекладу повертає англійський з підставленими значеннями. */
  function t(source, ...values) {
    const target = active ? (exact.get(squash(source)) || null) : null;
    if (target) return fill(target, values);
    const english = fill(source, values);
    return lookup(english) || english;
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  const SKIP = 'script, style, code, pre, textarea, [contenteditable="true"], [data-i18n-skip], .profile-item-name';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

  function skipped(el) {
    return !!(el && el.closest && el.closest(SKIP));
  }

  function translateTextNode(node) {
    const value = node.nodeValue;
    if (!value || !/[A-Za-z]/.test(value)) return;
    if (skipped(node.parentElement)) return;
    const out = lookup(value);
    if (out == null || out === squash(value)) return;
    const lead = value.match(/^\s*/)[0];
    const trail = value.match(/\s*$/)[0];
    node.nodeValue = lead + out + trail;
  }

  // Атрибути поля вводу (placeholder, title) перекладаємо: пропускається лише його вміст.
  const SKIP_ATTRS = '[data-i18n-skip], .profile-item-name';

  function translateAttributes(el) {
    if (el.closest && el.closest(SKIP_ATTRS)) return;
    for (const name of ATTRS) {
      const v = el.getAttribute && el.getAttribute(name);
      if (!v || !/[A-Za-z]/.test(v)) continue;
      const out = lookup(v);
      if (out != null && out !== v) el.setAttribute(name, out);
    }
    // Кнопка-input: текст у value.
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.value) {
      const out = lookup(el.value);
      if (out != null) el.value = out;
    }
  }

  function translateTree(root) {
    if (!active || !root) return;
    if (root.nodeType === Node.TEXT_NODE) { translateTextNode(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      translateAttributes(root);
      if (skipped(root)) return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) {
      if (n.nodeType === Node.TEXT_NODE) translateTextNode(n);
      else translateAttributes(n);
      n = walker.nextNode();
    }
  }

  function start() {
    document.documentElement.lang = lang;
    if (!active) return;
    translateTree(document.body);
    const t0 = document.title && lookup(document.title);
    if (t0) document.title = t0;
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') r.addedNodes.forEach(translateTree);
        else if (r.type === 'characterData') translateTextNode(r.target);
        else if (r.type === 'attributes') translateAttributes(r.target);
      }
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
  }

  // Рідні вікна confirm / alert / prompt теж говорять мовою інтерфейсу.
  if (active) {
    const wrap = (fn) => function (message, ...rest) { return fn.call(window, message == null ? message : t(String(message)), ...rest); };
    window.alert = wrap(window.alert);
    window.confirm = wrap(window.confirm);
    window.prompt = wrap(window.prompt);
  }

  function setLanguage(value) {
    const v = value === 'auto' ? 'auto' : (normalize(value) || 'auto');
    try { localStorage.setItem(STORE_KEY, v); } catch (_) {}
    // Основному процесу — для його власних вікон (оновлення, вибір теки).
    try { window.api && window.api.setLanguage && window.api.setLanguage(v); } catch (_) {}
    location.reload();
  }

  window.i18n = { lang, t, lookup, setLanguage, stored: readStored, translateTree };

  // Основний процес дізнається мову й при старті, не лише при зміні.
  try { window.api && window.api.setLanguage && window.api.setLanguage(readStored()); } catch (_) {}

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
