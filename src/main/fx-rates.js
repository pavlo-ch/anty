/**
 * Ринкові курси валют до долара для кнопки USD на Facebook (page-scripts/usd-toggle.js).
 *
 * Джерело — open.er-api.com (без ключа, ~166 валют, оновлюється раз на добу). Сторінка
 * Facebook сама по курс сходити не може: її CSP (connect-src) не пускає запити на чужі
 * домени, тож курс бере основний процес і кладе в скрипт сторінки.
 *
 * Кеш — у пам'яті й у файлі fx-rates.json поруч із базою; свіжим вважається 12 год.
 * Мережа впала — лишається останній збережений курс, хоч і старий: старий курс кращий
 * за відсутню кнопку. Нічого не кидає.
 */
const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://open.er-api.com/v6/latest/USD';
const FRESH_MS = 12 * 60 * 60 * 1000;

let memory = null;
let inflight = null;

function cacheFile() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'fx-rates.json');
  } catch (_) {
    return null;
  }
}

function readCache() {
  if (memory) return memory;
  const file = cacheFile();
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && parsed.rates && parsed.fetchedAt) memory = parsed;
  } catch (_) {}
  return memory;
}

function writeCache(value) {
  memory = value;
  const file = cacheFile();
  if (!file) return;
  try { fs.writeFileSync(file, JSON.stringify(value)); } catch (_) {}
}

async function download() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(SOURCE_URL, { signal: controller.signal });
    const body = await res.json();
    if (body?.result !== 'success' || !body.rates || typeof body.rates.USD !== 'number') {
      throw new Error(`unexpected answer: ${body?.result || res.status}`);
    }
    const value = {
      base: 'USD',
      date: body.time_last_update_utc || '',
      fetchedAt: Date.now(),
      rates: body.rates, // 1 USD = rates[CODE] CODE
    };
    writeCache(value);
    return value;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Курси: свіжі з кешу, інакше з мережі (не довше за waitMs), інакше старі з кешу або null.
 * Запит у мережу, що не вклався в waitMs, доходить у фоні й оновлює кеш на наступний раз.
 */
async function getRates({ waitMs = 3000 } = {}) {
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return cached;
  if (!inflight) {
    inflight = download()
      .catch((err) => {
        console.error('[USD] Could not fetch exchange rates:', err.message);
        return null;
      })
      .finally(() => { inflight = null; });
  }
  const fresh = await Promise.race([inflight, new Promise((r) => setTimeout(() => r(null), waitMs))]);
  return fresh || cached || null;
}

module.exports = { getRates };
