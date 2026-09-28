# FB Connect — контракт Anty ↔ платформа BlackAffiliate

Мета: у редакторі профілю Anty (Platform = Facebook) баєр вставляє токен і тисне Connect —
або тисне «Connect via Facebook login» → офіційне вікно Meta (Facebook Login for Business) → доступи (`ads_read`, `ads_management`,
`business_management`) зберігаються на платформі й прив'язуються до команди.
treker підключимо пізніше — у цьому етапі не чіпаємо.

## Env (платформа)
`FB_APP_ID`, `FB_APP_SECRET`, `FB_LOGIN_CONFIG_ID`, `FB_TOKEN_ENC_KEY` (32 байти, base64), `FB_GRAPH_VERSION=v21.0`.
Значень поки немає — власник створить додаток Meta. Код має коректно відповідати «не налаштовано», якщо env порожні.

## Дані (платформа, Supabase)
`public.fb_connections`
- `id uuid pk`, `team_id uuid not null → teams`, `workspace_id uuid null → workspaces`,
  `anty_profile_id text null`, `connected_by uuid → profiles`
- `fb_user_id text not null`, `fb_user_name text`
- `access_token_enc text not null` — AES-256-GCM ключем `FB_TOKEN_ENC_KEY`; **ніколи** не віддається клієнту
- `expires_at timestamptz`, `granted_scopes text[]`
- `status text` (`active|expired|revoked|error`), `last_error text`, `last_checked_at timestamptz`
- `created_at`, `updated_at`; `unique (team_id, fb_user_id)` — повторне підключення оновлює рядок

`public.fb_ad_accounts`
- `connection_id uuid → fb_connections on delete cascade`, `act_id text`, `name`, `currency`,
  `timezone_name`, `account_status int`, `business_id`, `business_name`, `updated_at`
- `unique (connection_id, act_id)`

RLS увімкнений, клієнтських політик немає — доступ тільки через серверні роути з service role.
Видимість як у workspaces: owner/lead бачать усі підключення команди, buyer — лише свого workspace.

## Токен вручну (без застосунку Meta)
`POST /api/desktop/anty/fb-token {profileId, accessToken, adAccountId?}` (Anty-токен) → платформа
перевіряє токен самим Facebook (/me, /me/permissions, /me/adaccounts), шифрує, прив'язує до команди.
Потрібен лише `FB_TOKEN_ENC_KEY`. `adAccountId` (цифри, з act_ чи без) — токен мусить його бачити,
інакше 422 `ad_account_not_visible`. Невалідний токен — 422 `fb_rejected` з текстом Facebook.
Anty очищає поле токена після успіху й ніде його не зберігає.

## Потік (вікно згоди Meta)
1. «Connect via Facebook login» у блоці Facebook редактора профілю (профіль запускається, якщо ще не запущений) →
   Anty main process.
2. Anty main: `POST /api/desktop/anty/fb-connect-ticket` `{ profileId }` з тим самим
   токеном, яким Anty вже ходить у платформу (profiles pull/push).
   Відповідь: `{ url }` — `https://<платформа>/api/fb/connect?ticket=…`.
   Ticket: одноразовий, 10 хв, зашиті user_id, team_id, workspace_id профілю, anty_profile_id.
3. Anty відкриває `url` у новому вікні/вкладці **того ж профілю** (FB-cookies профілю → вікно згоди без логіну).
4. `GET /api/fb/connect?ticket=` → перевірка → redirect на
   `https://www.facebook.com/{ver}/dialog/oauth?client_id&redirect_uri=<платформа>/api/fb/callback&config_id&response_type=code&state=<підписаний ticket id>`
5. `GET /api/fb/callback` → перевірка state → code→token → обмін на long-lived (60 днів) →
   `/me`, `/me/permissions`, `/me/adaccounts?fields=account_id,name,currency,timezone_name,account_status,business` →
   upsert обох таблиць → проста сторінка «Підключено ✓, вікно можна закрити».
   Відмова/помилка → зрозуміла сторінка з причиною, нічого не пишемо.
6. `GET /api/desktop/anty/fb-status?profileId=` (той самий Anty-токен) →
   `{ connected, fbUserName, adAccounts: n, scopes, expiresAt, status }` — для значка на кнопці.
   Anty опитує після відкриття вікна (кожні 3 с, до 5 хв) і при завантаженні Ads Manager.

## UI платформи
Розділ команди → «Facebook-підключення»: хто підключив, профіль Anty, workspace, кабінети,
права, строк дії (жовтим < 7 днів), статус. Owner/lead: «Відключити» (видаляє рядок +
`DELETE /me/permissions` у Graph).

## Пізніше (не зараз)
- Внутрішній API для treker/black-oracle (токен лише server-to-server).
- Нагадування про протухання в Telegram.
