# Anty Browser

Anti-detect browser з підміною fingerprint, ізоляцією профілів і REST API для автоматизації.

---

## Зміст

- [Запуск](#запуск)
- [Профілі](#профілі)
- [Fingerprint](#fingerprint)
- [REST API (серверний режим)](#rest-api-серверний-режим)
- [Формат даних акаунтів](#формат-даних-акаунтів)

---

## Запуск

### Desktop (Electron GUI)

```bash
git clone https://github.com/pavlo-ch/anty.git
cd anty
npm install
npm start
```

### Серверний режим (без GUI, для ботів)

```bash
npm run start:server
# Сервер слухає на http://127.0.0.1:3032
```

Кастомний шлях до даних:

```bash
ANTY_DATA_DIR=/custom/path npm run start:server
ANTY_API_PORT=8080 npm run start:server
```

---

## Профілі

Кожен профіль — окремий браузерний контекст з:

- Унікальним User-Agent і fingerprint (WebGL, Canvas, Audio, Fonts, Screen)
- Окремими cookies і localStorage
- Проксі (http/https/socks5)
- Налаштуванням платформи (Facebook, Instagram, LinkedIn)

### Що підміняється

| Параметр | Значення |
|----------|---------|
| `navigator.userAgent` | Кастомний UA |
| `navigator.platform` | Win32 / MacIntel / Linux x86_64 |
| `navigator.hardwareConcurrency` | CPU cores з профілю |
| `navigator.deviceMemory` | RAM з профілю |
| `WebGL RENDERER / VENDOR` | GPU з профілю |
| `screen.width/height` | Роздільна здатність з профілю |
| `Sec-CH-UA` | Відповідає версії Chrome в UA |
| `Sec-CH-UA-Platform` | Відповідає ОС в UA |
| Canvas fingerprint | Noise (унікальний на профіль) |
| Audio fingerprint | Noise (унікальний на профіль) |
| WebRTC | Вимкнено |

### Sec-CH-UA автоматична підстановка

При вставці кастомного UA (наприклад Chrome/143) — всі Client Hints заголовки виставляються автоматично:

```
Sec-CH-UA: "Not_A Brand";v="8", "Chromium";v="143", "Google Chrome";v="143"
Sec-CH-UA-Platform: "Windows"
Sec-CH-UA-Mobile: ?0
```

### Вибір заліза по UA

При вставці UA з куплених акаунтів — система автоматично підбирає відповідне залізо:

- Windows Chrome → Intel UHD / NVIDIA GeForce / AMD Radeon
- Mac Chrome/146+ → 65% Apple Silicon (M1/M2/M3), 35% Intel
- Mac Chrome < 100 → 95% Intel UHD/Iris/Radeon Pro
- Linux Chrome → Mesa / llvmpipe

---

## REST API (серверний режим)

Base URL: `http://127.0.0.1:3032`

---

### Профілі

#### Список профілів
```
GET /api/profiles
```

```json
{
  "ok": true,
  "profiles": [
    {
      "id": 1,
      "name": "siemevqx@legenmail.com",
      "status": "ready",
      "proxy": "http://185.x.x.x:8080",
      "start_page": "https://www.facebook.com",
      "wsEndpoint": null
    }
  ]
}
```

---

#### Отримати профіль
```
GET /api/profiles/:id
```

---

#### Створити профіль
```
POST /api/profiles
```

| Поле | Тип | Опис |
|------|-----|------|
| `name` | string | Назва профілю (email акаунту) |
| `platform` | string | `facebook` \| `instagram` \| `linkedin` — виставляє start_page |
| `userAgent` | string | UA з акаунту — fingerprint підбирається автоматично |
| `proxy` | string або object | `"http://host:port:user:pass"` або `{ type, host, port, username, password }` |
| `cookies` | array | Масив cookie-об'єктів |
| `warmup_url` | string | URL для прогріву перед основним сайтом |
| `start_page` | string | Стартова сторінка (якщо не вказана `platform`) |
| `created_by` | string | Назва бота / автора |

**Приклад — Facebook акаунт:**

```json
POST /api/profiles
{
  "name": "siemevqx@legenmail.com",
  "platform": "facebook",
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "proxy": "http://185.220.1.1:8080:login:password",
  "cookies": [
    { "domain": ".facebook.com", "name": "c_user", "value": "61587430743680", "path": "/" },
    { "domain": ".facebook.com", "name": "xs", "value": "28%3ALMhHo5...", "path": "/" }
  ],
  "created_by": "OpenClaw Bot"
}
```

**Відповідь:**

```json
{
  "ok": true,
  "profile": { "id": 5, "name": "siemevqx@legenmail.com", ... }
}
```

---

#### Оновити профіль
```
PATCH /api/profiles/:id
```

```json
{ "proxy": "http://new-host:port:user:pass" }
```

---

#### Видалити профіль
```
DELETE /api/profiles/:id
```

---

### Запуск браузера

#### Запустити профіль (headless)
```
POST /api/profiles/:id/start
```

**Відповідь:**

```json
{
  "ok": true,
  "wsEndpoint": "ws://127.0.0.1:54321/devtools/browser/abc..."
}
```

Підключення через Playwright:

```js
const { chromium } = require('playwright-core');
const browser = await chromium.connect(wsEndpoint);
const [page] = browser.contexts()[0].pages();
await page.goto('https://www.facebook.com');
// cookies зберігаються автоматично при закритті
```

---

#### Зупинити профіль
```
POST /api/profiles/:id/stop
```

Cookies зберігаються в БД автоматично.

---

#### Запущені профілі
```
GET /api/running
```

```json
{
  "ok": true,
  "running": [
    { "id": 5, "wsEndpoint": "ws://127.0.0.1:54321/..." }
  ]
}
```

---

### Проксі

#### Перевірити проксі
```
POST /api/proxy/check
```

```json
{ "proxy": "http://host:port:user:pass" }
```

**Відповідь:**

```json
{
  "ok": true,
  "success": true,
  "ip": "185.220.1.1",
  "country": "PL",
  "city": "Warsaw",
  "timezone": "Europe/Warsaw"
}
```

---

## Формат даних акаунтів

Підтримуваний формат для парсингу ботом (поля через ` :: `):

```
email :: fb_token :: user_agent :: (пусто) :: cookies_json :: password :: metadata
```

**Приклад парсингу в боті:**

```js
const parts = line.split(' :: ');
const [email, token, userAgent, , cookiesRaw, password] = parts;
const cookies = JSON.parse(cookiesRaw);

await fetch('http://127.0.0.1:3032/api/profiles', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: email,
    platform: 'facebook',
    userAgent,
    cookies,
    created_by: 'OpenClaw Bot',
  }),
});
```

---

## Дані

За замовчуванням зберігаються в `~/.anty/`:

```
~/.anty/
  anty_browser.db     ← SQLite база профілів
  profiles/
    profile_1/        ← Chrome user data dir
    profile_2/
    ...
```

Кастомний шлях: `ANTY_DATA_DIR=/custom/path`
