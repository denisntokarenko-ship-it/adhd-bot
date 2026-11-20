# Фаза 0 — Каркас

Читати разом з [00-common.md](00-common.md). Кроки: 0.3 (CI), 0.4 (Worker, оточення, шар даних), 0.5 (cron-серце, монітор). Кроки 0.1–0.2 — процес і ця спека.

## Задача

Порожній, але **живий** бот: Worker приймає вебхук Telegram, відповідає на `/start`, має `/health`, cron щохвилини б'є своє серце й пінгує зовнішній монітор. Нічого «розумного» — тільки те, на чому стоять усі наступні фази: схема з `userId`, огорожа доступу до D1, розділені preview/prod, і тривога, коли cron замовк. Фаза закрита, коли в preview-боті `/start` відповідає, `/health` показує свіжий `sha` і прогін cron, а вимкнений cron за ≤ 5 хв дає лист від монітора.

Порядок історій = порядок реалізації; кожна тестується окремо.

## Схема (міграція `0001`)

Часи — UTC ms, значення в коді від injectable `clock` (SQL-`DEFAULT` на час немає: тести ставлять фіксований час). Хвилини доби — `INTEGER 0..1439`.

```sql
CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id       INTEGER NOT NULL UNIQUE,
  tz          TEXT    NOT NULL DEFAULT 'Europe/Kyiv' CHECK (length(tz) BETWEEN 1 AND 64),
  quiet_from  INTEGER NOT NULL DEFAULT 1380 CHECK (quiet_from  BETWEEN 0 AND 1439), -- 23:00
  quiet_to    INTEGER NOT NULL DEFAULT 480  CHECK (quiet_to    BETWEEN 0 AND 1439), -- 08:00; рівні = тихих годин немає
  morning_at  INTEGER NOT NULL DEFAULT 540  CHECK (morning_at  BETWEEN 0 AND 1439), -- 09:00
  evening_at  INTEGER NOT NULL DEFAULT 1260 CHECK (evening_at  BETWEEN 0 AND 1439), -- 21:00
  weekly_dow  INTEGER NOT NULL DEFAULT 7    CHECK (weekly_dow  BETWEEN 1 AND 7),    -- ISO, 7 = неділя
  pause_until INTEGER,
  greet_variant_idx INTEGER CHECK (greet_variant_idx IS NULL OR greet_variant_idx >= 0), -- останній варіант вітання (НФ-4)
  soon_variant_idx  INTEGER CHECK (soon_variant_idx  IS NULL OR soon_variant_idx  >= 0), -- останній варіант «навчуся скоро»
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE heartbeat (
  key             TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 32),  -- у Фазі 0 єдиний ключ 'cron'
  last_run_at     INTEGER NOT NULL,
  last_ping_ok_at INTEGER                                                  -- останній успішний пінг монітора
);
```

Валідність `tz`: IANA-ім'я перевіряє код (`Intl.DateTimeFormat` кидає на невідомому), `CHECK` лише відсікає сміття. `users.plan` і `users.ai_consent_at` **не створюються** — додаються міграцією, коли знадобляться.

## Історії

### S0.1 · P1 · Вебхук і `/start` (крок 0.4)

Власник пише боту в Telegram — бот відповідає, а в БД з'являється його рядок.

- **0.1.a** Given порожня БД, tg_id власника в `ALLOWED_TG_IDS`, When `POST /webhook` з валідним секретом і update `/start`, Then в `users` рівно один рядок з `tz='Europe/Kyiv'`, дефолтами тихих годин, `created_at = last_seen_at = now`; бот надсилає вітання одним повідомленням.
- **0.1.b** Given рядок уже є, When `/start` вдруге, Then `COUNT(users)=1`, `tz` і налаштування не змінені, `last_seen_at` оновлено. Два `/start` паралельно (один `tg_id`) → теж один рядок (`INSERT … ON CONFLICT(tg_id) DO UPDATE`).
- **0.1.c** Given рядка немає, When власник пише довільний текст до `/start`, Then рядок створюється так само (`ensureUser` — на кожен автентичний update), бот відповідає, що записувати навчиться скоро. Жодного запису в `items` — таблиці ще немає.
- **0.1.d** Вітання й відповідь «навчуся скоро» — пули ≥ 3 варіантів, без повтору підряд, пройшли тест заборонених слів (НФ-4). Індекс попереднього варіанта — у `users.greet_variant_idx` / `soon_variant_idx` (пам'ять isolate між запитами скидається): два `/start` поспіль → різні вітання.
- **0.1.e** Негатив. Given запит без заголовка `X-Telegram-Bot-Api-Secret-Token` або з неправильним, When `POST /webhook`, Then відповідь 401, тіло не розбирається, `users` не змінено. Порівняння секрету — у сталий час.
- **0.1.f** Негатив. Given `GET /webhook` або будь-який інший шлях, Then 404/405, без витоку причини.
- **0.1.g** Негатив (fail-closed). Given `WEBHOOK_SECRET` не заданий, порожній чи з самих пробілів, When будь-який `POST /webhook` (без заголовка, з порожнім, з будь-яким), Then 401, тіло не розбирається, `users` не змінено; перевірка секрету — до allowlist. Тест з `env` без секрету (`undefined === undefined` не пропускає).

### S0.2 · P1 · `/health` (кроки 0.4, 0.5)

Одна адреса, за якою людина (і скрипт релізу) бачить, чи живий бот і яка версія.

- **0.2.a** Given свіжий прогін cron (`last_run_at` 40 с тому), When `GET /health`, Then 200 і JSON рівно такої форми: `{"ok":true,"env":"preview","sha":"<GIT_SHA>","cron":{"last_run_at":<ms>,"age_s":40,"stale":false},"queue":{"pending":0}}`. `Cache-Control: no-store`.
- **0.2.b** Given прогону ще не було (рядка `cron` немає), Then 200, `cron:{"last_run_at":null,"age_s":null,"stale":true}`, `ok:true` (щойно викочений Worker: його cron стартує до ~15 хв).
- **0.2.c** Given `last_run_at` старший за 180 с, Then `stale:true`. Межа в мс: `stale = age_ms > 180000`, `age_s = floor(age_ms/1000)`: 180000 → `{age_s:180,stale:false}`, 180001 → `stale:true`, 180400 → `{age_s:180,stale:true}`.
- **0.2.d** Given D1 кидає помилку, Then 503 і `{"ok":false,"error":"db"}` — без тексту помилки.
- **0.2.e** `sha` — той, що передав деплой (`GIT_SHA`); без змінної — `"unknown"`. `queue.pending` у Фазі 0 — константа `0` із функції `queueSize()` (форма стабільна, Фаза 1 підставляє реальне число). У відповіді немає tg_id, імен, текстів — лише перелічені поля.
- **0.2.f** Поля `"monitor":"missing"` у відповіді немає, окрім випадку з 0.3.e (prod без `MONITOR_PING_URL`: `ok:false`, 200); у решті випадків форма — як у 0.2.a.

### S0.3 · P1 · Cron-серце й dead man's switch (крок 0.5)

Cron щохвилини доводить, що він живий, — і монітор нарікає, якщо ні (НФ-6).

- **0.3.a** Given фіксований час, мок `fetch`, When `scheduled()`, Then `heartbeat('cron').last_run_at = now`, один `GET MONITOR_PING_URL`, після успіху `last_ping_ok_at = now`.
- **0.3.b** Два прогони в одну хвилину → один рядок `heartbeat` (upsert), без помилки.
- **0.3.c** Негатив. Given пінг відповідає 500 або таймаут 5 с, Then `scheduled()` не кидає, `last_run_at` оновлено, `last_ping_ok_at` не змінено, помилка в лозі.
- **0.3.d** Негатив. Given запис у D1 кидає, Then `fetch` на монітор **не викликано** (тривога має спрацювати), прогін завершується помилкою в лозі. *Мутант: пінг до запису → цей тест червоніє.*
- **0.3.e** Given `MONITOR_PING_URL` не задано і `env≠production`, Then прогін проходить без `fetch`, в лозі попередження. Given `env=production` без нього, Then прогін так само не кидає, але на кожен прогін `console.error`, а `GET /health` → 200 `{"ok":false,"monitor":"missing",…}` (без тривоги монітора «тихо живий» був би невидимий, НФ-6).
- **0.3.f** Given прогін робить додаткову роботу (її поки немає, стає в Фазі 1+), Then вона у `try/catch`: її збій не скасовує вже зроблені heartbeat і пінг.
- **0.3.g** 👤 Живе в preview: вимкнути cron-тригер → монітор шле лист за ≤ 5 хв від останнього пінгу; увімкнути → монітор «одужав». Прогін має слід: `tail` логу Worker і рядок `heartbeat` у D1.
- **0.3.h** Вибір монітора (healthchecks.io чи аналог) і його ліміти — крок 0.5, закриває `open-questions.md` (пошук, результат у `decisions.md`).

### S0.4 · P1 · Шар даних і огорожа (крок 0.4)

Правило «D1 лише через `src/db/` з `userId`» — тест, а не домовленість (НФ-3).

- **0.4.a** Given міграція `0001`, When застосовано на чистій SQLite/D1 (Miniflare), Then `users` і `heartbeat` існують з колонками й CHECK з розділу «Схема»; повторний прогін міграцій — без помилки (журнал D1).
- **0.4.b** Негатив у БД: `INSERT users` з `quiet_from=1440`, `weekly_dow=0`, повторним `tg_id`, `tz=''` — кожен відхилено.
- **0.4.c** Given код `src/**` поза `src/db/`, When тест-охоронець сканує, Then жодного `env.DB`, `.prepare(`, імпорту чи згадки `D1Database`. Тип `Env` (з `DB: D1Database`) живе в `worker-configuration.d.ts` у корені (генерує `wrangler types`, поза `src/`); у `src/` до `.DB` звертається лише код `src/db/`. Додано навмисний порушник → тест червоніє.
- **0.4.d** Given функції `src/db/users.ts`, Then кожна приймає `userId` першим параметром, окрім `ensureUser(tgId)` (створює користувача) і системних у `src/db/system.ts` (`heartbeat`; з Фази 1 — вибірка `pending`-захоплень, S1.5.c). Тест перелічує експорти й перевіряє сигнатури; новий експорт без `userId` і без явного списку винятків — червоний.
- **0.4.e** Функції БД і `clock` — єдине джерело `now`: у `src/**` немає `Date.now()` і `new Date()` без аргументів поза `clock.ts`; `new Date(ms)` для форматування (`dayBounds`, `localToUtc`) дозволено.

### S0.5 · P2 · Два оточення (крок 0.4; 👤 створення ресурсів)

Спершу preview, потім prod, і ніколи не одне й те саме (правила 7, 8 з `CLAUDE.md`).

- **0.5.a** `wrangler.toml` містить `account_id` на верхньому рівні; оточення `preview` і `production` мають різні `name` Worker-а й різні `database_name`; `database_id`, коли задані, різні. Верхній рівень не має `[[d1_databases]]` (D1 — лише в `env.preview` / `env.production`): `wrangler d1 migrations apply` без `--env` не має куди йти й не потрапить у prod. Тест розбирає файл.
- **0.5.b** Cron `* * * * *` оголошений для кожного оточення, не лише верхнього рівня (тригери не успадковуються між env).
- **0.5.c** Секрети (`BOT_TOKEN`, `WEBHOOK_SECRET`, `ALLOWED_TG_IDS`, `MONITOR_PING_URL`) — окремі набори на оточення, вводить людина (👤); `git ls-files | grep -iE '\.env|\.dev\.vars|secret'` порожньо, а тест відхиляє в трекнутих файлах рядок, схожий на токен бота (`\d{8,}:[\w-]{30,}`).
- **0.5.d** 👤 Вебхук preview-бота виставлено з `secret_token` і `allowed_updates=["message","callback_query"]`; `getWebhookInfo` показує саме цей масив і порожній `last_error_message`. Перевірка — за відповіддю Telegram, не за тим, що ввели в команді (лапки в curl обрізають масив).
- **0.5.e** Після деплою preview `/health.sha` = `git rev-parse HEAD` деплоєного коміту; `env:"preview"`.
- **0.5.f** Ресурси prod (D1, токен, монітор) у Фазі 0 не створюються — `production` лише оголошено в конфігу; питання й припущення — `open-questions.md`.

### S0.6 · P2 · Allowlist — чужі не їдять бюджет (крок 0.4)

- **0.6.a** Given tg_id поза `ALLOWED_TG_IDS`, When будь-який update, Then рядок у `users` не створюється, одна статична відповідь «бот приватний», без виклику ШІ (ШІ ще немає — тест на шарі `ensureUser`).
- **0.6.b** Given `ALLOWED_TG_IDS` порожній або відсутній, Then відхиляються всі (fail-closed), а не приймаються всі.
- **0.6.c** Given `ALLOWED_TG_IDS="111, 222"` (пробіли, кома), Then розбирається в `{111,222}`; сміття на кшталт `"abc"` — конфіг розбирається на кожен запит (на Workers старту немає) і відхиляє всіх: fail-closed, відповідь 200 (щоб Telegram не повторював, 0.7.a) і `console.error`, а не мовчки ігнорується.
- **0.6.d** Негатив. Given update з `chat.type ≠ 'private'` (для callback — `message.chat`; немає `message` → так само), `from.id` у allowlist, When `/today`, `/export` чи будь-який текст у групі, Then 200, без відповіді, без `ensureUser` і запису; тест: `sendMessage` не викликано. 👤 додатково `/setjoingroups` → Disable у BotFather.

### S0.7 · P3 · Стійкість вебхука (крок 0.4)

- **0.7.a** Given автентичний update і обробник кидає виняток, When відповідь Telegram, Then 200 і помилка в лозі (отруйний update не має блокувати чергу доставки); винятків із D1 на записі захоплення це не стосується — їх поводження у `phase-1.md`.
- **0.7.b** Хук помилок grammY у вебхуку не викликається (він лише для polling): охоронець — тест, що кидає з обробника й перевіряє 200 + лог, а не наявність `bot.catch`.
- **0.7.c** Не-текстовий update (стікер, фото) і `edited_message` у Фазі 0 → 200 без відповіді або з короткою відповіддю; без винятку й без запису.

### S0.8 · P2 · Інструменти й CI (крок 0.3)

Деталі — за промптом кроку 0.3; тут лише те, що спека вимагає від результату.

- **0.8.a** PR запускає `npm ci`, typecheck, тести, `npm run check:docs`; навмисна помилка типу, червоний тест або файл спеки > 40 КБ дають червоний CI.
- **0.8.b** `scripts/mutate.py` відмовляється працювати з брудним деревом (мутант зносить незакомічене — правило 9).
- **0.8.c** `check:docs` у CI — той самий `scripts/check-docs.sh`, що й локально.

## Поза межами

Таблиці `items`, `captures`, `ai_calls`, `points_ledger` та будь-який виклик ШІ чи Whisper (Фаза 1). Черга `reminders`, тихі години як логіка (поки лише колонки). Налаштування кнопками. Перший деплой у prod і скрипт релізу (3.3). Автоматичний `setWebhook` у CI. Нотифікації про збої людині від самого бота.

## Невідоме

Усі відкриті питання Фази 0 (монітор, prod-ресурси, дефолти тихих годин) — в `open-questions.md`, розділ «Фаза 0»; тут не дублюються.
