// Пошук нових англійських рядків для словника (src/renderer/i18n-zh.js):
//   OUT=/tmp/strings.json node scripts/i18n-extract.js src/renderer/index.html src/renderer/main.js src/main/*.js
// Порівняйте з ключами словника — те, чого бракує, треба перекласти за глосарієм.
const fs = require('fs');

const QUOTED = /'([^'\n]*)'|"([^"\n]*)"/g;
const files = process.argv.slice(2);
const exact = new Map(); // text -> Set(files)
const add = (s, f) => {
  s = s.replace(/\s+/g, ' ').trim();
  if (!s || !/[A-Za-z]{2}/.test(s)) return;
  if (s.length > 1200) return;
  if (!exact.has(s)) exact.set(s, new Set());
  exact.get(s).add(f.split('/').slice(-2).join('/'));
};

// Те, що схоже на код, а не на текст для людини.
function looksLikeCode(s) {
  if (/^(https?:|anty:|\/|#|\.|data:|mailto:)/.test(s)) return true;
  if (/^[a-z][\w-]*:[\w:-]+$/.test(s)) return true; // ipc-канали profile:create
  if (/^[a-z0-9_-]+$/.test(s) && !/\s/.test(s) && s.length < 40 && !/^[a-z]+$/.test(s)) return true; // css-класи, ключі
  if (/^[a-z]+[A-Z]\w*$/.test(s)) return true; // camelCase
  if (/^[A-Z_][A-Z0-9_]+$/.test(s) && s.length > 3) return true; // КОНСТАНТИ
  if (/[{};=]|=>|\(\)|\bfunction\b|\.(js|css|png|svg|html)\b/.test(s)) return true;
  if (/^[\w-]+(\s[\w-]+)*$/.test(s) && /-/.test(s) && !/\s/.test(s)) return true;
  if (/^(div|span|button|input|svg|path|option|select|label|li|ul|td|tr|a|b|i|p|img|textarea)$/i.test(s)) return true;
  if (/^(GET|POST|PUT|DELETE|PATCH|true|false|null|undefined|none|auto|block|flex|hidden|visible|absolute|relative|fixed|transparent|pointer|center|left|right|top|bottom|inherit|nowrap|ease|linear)$/.test(s)) return true;
  return false;
}

for (const f of files) {
  let src = fs.readFileSync(f, 'utf8');
  if (f.endsWith('.html')) {
    src = src.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    src = src.replace(/<svg[\s\S]*?<\/svg>/gi, '');
    for (const m of src.matchAll(/>([^<]+)</g)) add(m[1].replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&mdash;/g, '—'), f);
    for (const m of src.matchAll(/\b(?:title|placeholder|aria-label|alt|data-tooltip|label)="([^"]+)"/g)) add(m[1], f);
    continue;
  }
  // JS: прибираємо коментарі (грубо, але рядки з // усередині рідкісні).
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  // Шаблонні рядки
  for (const m of src.matchAll(/`((?:\\.|[^`\\])*)`/g)) {
    const body = m[1].replace(/<svg[\s\S]*?<\/svg>/gi, '');
    // Розрізаємо по тегах: кожен шматок тексту між тегами — окремий текстовий вузол.
    const chunks = body.split(/<[^>]*>/);
    for (let c of chunks) {
      if (!/[A-Za-z]{2}/.test(c.replace(/\$\{[^}]*\}/g, ''))) continue;
      let i = 0;
      const tpl = c.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, () => `{${i++}}`).replace(/&nbsp;/g, ' ');
      const t = tpl.replace(/\s+/g, ' ').trim();
      if (!t || looksLikeCode(t.replace(/\{\d+\}/g, 'X'))) continue;
      if (/^\{\d+\}$/.test(t)) continue;
      add(t, f);
    }
    // рядки всередині ${…}: 'Launch', 'Disabled', 'proxy' / 'proxies'
    for (const e of body.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
      for (const q of e[1].matchAll(QUOTED)) {
        const v = q[1] ?? q[2];
        if (/[A-Za-z]{2}/.test(v) && !looksLikeCode(v.trim()) && (/\s/.test(v.trim()) || /^[A-Z][a-zA-Z]+[.!?…]?$/.test(v.trim()) || /^[a-z]{3,}$/.test(v.trim()))) add(v, f);
      }
    }
    // атрибути в шаблонах
    for (const a of body.matchAll(/\b(?:title|placeholder|aria-label|alt)="([^"]+)"/g)) {
      let i = 0;
      add(a[1].replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, () => `{${i++}}`), f);
    }
  }
  // Звичайні рядки
  const noTpl = src.replace(/`(?:\\.|[^`\\])*`/g, '``');
  for (const m of noTpl.matchAll(/'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"/g)) {
    const s = (m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, ' ');
    if (!/\s/.test(s) && !/^[A-Z][a-z]+$/.test(s) && !/^[A-Z][a-z]+[.!?]?$/.test(s)) {
      // одне слово: беремо лише слова з великої (Save, Cancel)
      if (!/^[A-Z][a-zA-Z]+[.!?…]?$/.test(s)) continue;
    }
    if (looksLikeCode(s)) continue;
    if (/<[a-z][^>]*>/i.test(s)) {
      for (const c of s.split(/<[^>]*>/)) if (!looksLikeCode(c.trim())) add(c, f);
      continue;
    }
    add(s, f);
  }
}

const out = [...exact].map(([s, fs]) => ({ s, files: [...fs] })).sort((a, b) => a.s.localeCompare(b.s));
fs.writeFileSync(process.env.OUT || '/dev/stdout', JSON.stringify(out, null, 1));
console.error(`${out.length} strings`);
