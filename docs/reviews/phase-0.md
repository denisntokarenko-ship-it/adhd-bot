# R-0 · Незалежне рев'ю Фази 0

Дата: 2026-11-20 · Рецензент: окрема сесія (Opus 5.5), коду не правила · База: `origin/main` = `7cfaf13` · Гілка: `review/phase-0`.

**Вердикт: фаза НЕ ЗАКРИТА.** Блокерів архітектури немає, межа preview/prod, огорожа секрету, allowlist і dead man's switch тримаються живцем. Але є одна історія спеки без реалізації (S0.8.b), тест таймауту пінгу, що нічого не доводить (мутант R3 вижив), і огорожа 0.4.d з дірою в `system.ts` (мутант R5 вижив). Виправлення невеликі — список «fix/phase-0-review» внизу.

## 1. Історії ↔ реалізація ↔ тест

| Історія | Реалізація | Тест / доказ | Стан |
|---|---|---|---|
| 0.1.a `/start` → 1 рядок з дефолтами, вітання | `src/bot.ts:44-56`, `src/db/users.ts:17-29` | `test/worker/webhook.test.ts:13`; живцем: D1 preview `users` = 1 рядок, `tz=Europe/Kyiv`, 1380/480, `created_at = last_seen_at` | ✅ |
| 0.1.b повторний і паралельний `/start` | upsert `ON CONFLICT(tg_id)` `users.ts:20-23` | `webhook.test.ts:31,41` | ✅ |
| 0.1.c текст до `/start` | `bot.ts:52-55` | `webhook.test.ts:48` | ✅ |
| 0.1.d пули ≥ 3, без повтору, індекс у БД | `texts.ts`, `setVariantIdx` | `webhook.test.ts:55`, `tone.test.ts:39,62`; живцем `greet_variant_idx=0` | ✅ |
| 0.1.e немає / хибний секрет → 401, тіло не розбирається | `app.ts:28-30`, `config.ts:15` (сталий час) | `webhook.test.ts:65` (вкл. секрет тієї ж довжини); мутант R1 KILLED; живцем 401/401 | ✅ |
| 0.1.f інші методи / шляхи | `app.ts:20,25,48` | `webhook.test.ts:78`; живцем 405 / 404, тіло 0 Б | ✅ |
| 0.1.g fail-closed без `WEBHOOK_SECRET` | `app.ts:27` | `webhook.test.ts:87` | ✅ |
| 0.2.a–f `/health` | `src/health.ts` | `health.test.ts:17-70`, `scheduled.test.ts:111-140`; живцем форма 0.2.a, `no-store` | ✅ |
| 0.3.a–b серце, upsert | `scheduled.ts:38-45`, `system.ts:18-25` | `scheduled.test.ts:40,49` | ✅ |
| 0.3.c пінг 500 / таймаут 5 с | `scheduled.ts:19-31` | `scheduled.test.ts:58,67,75` — **тест таймауту зелений і без таймауту** (R3) | ⚠️ |
| 0.3.d збій D1 → пінгу немає | `scheduled.ts:40-45` | `scheduled.test.ts:89`; мутант M1 кроку 0.5 | ✅ |
| 0.3.e без `MONITOR_PING_URL` (preview / prod) | `scheduled.ts:13-17`, `health.ts:18` | `scheduled.test.ts:103,111` | ✅ |
| 0.3.f додаткова робота в `try/catch` | `scheduled.ts:47-51` | **тесту немає** — свідомо перенесено в 2.2 («Рішення» 0.5) | ⚠️ |
| 0.3.g 👤 живий доказ монітора | — | PR #4: лист DOWN 15:49:27 UTC (1 + 4 хв від останнього пінгу), UP 16:00:26 UTC; зараз D1 `heartbeat.last_ping_ok_at` на 135 мс пізніше `last_run_at` | ✅ |
| 0.3.h вибір монітора | `decisions.md`, «Рішення» PROGRESS | healthchecks.io, джерела з посиланнями | ✅ |
| 0.4.a–b міграція, CHECK, UNIQUE | `migrations/0001_init.sql` | `db.test.ts:21,37` | ✅ |
| 0.4.c `env.DB` лише в `src/db/` | непрозорий `Db` (`db/index.ts`) | `guard.test.ts:8,13,42`, `opaque-db.typecheck.ts`; зонд R4 (обчислений ключ) вижив — очікувано, сканер лексичний | ✅ з ризиком |
| 0.4.d `userId` першим, явні винятки | `guard-lib.ts:58-111` | `guard.test.ts:22,28,54,73` — **`system.ts` виключено цілим файлом**, новий експорт там не червоніє (R5) | ⚠️ |
| 0.4.e `Date.now()` лише в `clock.ts` | `clock.ts` | `guard.test.ts:34` | ✅ |
| 0.5.a–b `wrangler.toml`: `account_id`, різні Worker/D1, cron у кожному env | `wrangler.toml` | `wrangler-config.test.ts:20,37` | ✅ |
| 0.5.c секрети не в git, токен-скан | `.gitignore`, `guard-lib.ts:113-118` | `wrangler-config.test.ts:53,57`; історія git — чисто (розд. 8) | ✅ |
| 0.5.d вебхук із `secret_token` і `allowed_updates` | `scripts/set-webhook.mjs` | `set-webhook.test.ts`; живцем — PR #3 (перевірка за відповіддю `getWebhookInfo`). Повторно не звіряв: потрібен токен | ✅ (за PR) |
| 0.5.e `/health.sha` = `HEAD` деплоєного коміту | `wrangler deploy --var GIT_SHA:…` | живцем `sha = c2b9dff` — коміт гілки 0.5 до squash, а не `origin/main` `7cfaf13`. Код рантайму ідентичний (`git diff c2b9dff 7cfaf13 -- src migrations wrangler.toml package*.json` порожній) | ⚠️ |
| 0.5.f prod лише оголошено | `wrangler.toml:30-38` (плейсхолдер D1) | живцем `adhd-bot-prod…/health` → 404; `wrangler secret list --env production` → «Worker not found» | ✅ |
| 0.6.a–d allowlist, приватний чат | `config.ts:2-12`, `bot.ts:44-71` | `webhook.test.ts:101-196`, `tone.test.ts:75`; мутант R2 KILLED. 👤 `/setjoingroups` не звіряв | ✅ |
| 0.7.a–c стійкість вебхука | `app.ts:38-45`, `bot.ts:44` | `webhook.test.ts:200,208,215` | ✅ |
| 0.8.a CI червоніє на тесті / типі / спеці > 40 КБ | `.github/workflows/ci.yml` | тест — червоний прогін у PR #2; тип і спеку довів локально тими самими командами CI (мутанти C1, C2 KILLED) | ✅ |
| 0.8.b `scripts/mutate.py` відмовляє на брудному дереві | **немає** | — (у «Борг» з 0.3; мутації ганяли скіловим скриптом, у якого перевірки брудного дерева немає — замість неї бекап і звірка байтів) | ❌ |
| 0.8.c `check:docs` у CI = локальний | `package.json` → `scripts/check-docs.sh` | `ci.yml:21` | ✅ |

## 2. Повний прогін (локально, `7cfaf13`)

| Команда | Результат |
|---|---|
| `npm ci` | 0 |
| `npm run lint` | **скрипта немає** (`Missing script: "lint"`); спека й CI lint не вимагають — не дефект, але кроку немає |
| `npm run typecheck` | 0 (обидва `tsconfig`) |
| `npm test` | 9 файлів, **64/64** зелені, 2.3 с |
| `npm run check:docs` | зелено, 17 файлів у бюджеті |
| build: `wrangler deploy --dry-run --env preview` | 0, 168 KiB / gzip 34 KiB, біндинги `DB (adhd-preview)`, `ENV="preview"` |
| CI на `main` (`7cfaf13`) | success |

## 3. Наскрізні сценарії (preview, Browser pane, 2026-11-20 ~16:16 UTC)

Сценарій плану для Фази 0 — «вимкнути cron → лист від монітора за ≤ 5 хв» + «після деплою `/health` показує `sha` і свіжий прогін». Перевіряв з боку наслідку.

- **Свіжий прогін cron — за рядком D1, не за відповіддю.** `wrangler d1 execute adhd-preview --remote --env preview`: `heartbeat(cron).last_run_at` за 3,6 с до моменту запиту, `last_ping_ok_at` на 135 мс пізніше — пінг монітора відповідає 2xx щохвилини. Таблиці: `users`, `heartbeat`, `d1_migrations` (+ службові) — зайвих немає.
- **`/health` (десктоп і 375×812):** `{"ok":true,"env":"preview","sha":"c2b9dff…","cron":{…,"age_s":11,"stale":false},"queue":{"pending":0}}`, `Cache-Control: no-store`. Скріншоти: [десктоп](phase-0/health-desktop.jpg), [мобільний](phase-0/health-mobile.jpg).
- **Вебхук без секрету (з тієї ж сторінки, `fetch`):** POST без заголовка → 401, з хибним → 401, GET → 405, `/nope` → 404. Наслідок — `users` у D1 так і лишився 1 рядок. Скріншот: [мобільний](phase-0/webhook-mobile.jpg).
- **Dead man's switch:** тривогу повторно не викликав (cron не вимикав) — доказ уже зібрано в 0.5 (листи DOWN/UP, PR #4), а поточний стан монітора підтверджує свіже `last_ping_ok_at`. Сторінка healthchecks потребує логіну Дениса — не відкривав.
- `/start` у Telegram сам не надсилав (немає акаунта власника); наслідок попереднього — рядок `users` з дефолтами і `greet_variant_idx=0`.

## 4. Шви між кроками

1. **Огорожа 0.4.d і `system.ts`.** `guard-lib.ts:104` пропускає `src/db/system.ts` цілим файлом, тож будь-який новий експорт без `userId` там — зелений (R5: `allUserTgIds(db)` пройшов). Фаза 1 додає саме сюди вибірку `pending`-захоплень (S1.5.c) — це момент, коли «системний» файл почне читати дані користувачів. Потрібен закритий список імен, як для `users.ts` і `index.ts`.
2. **Порядок параметрів `Db` різний:** `users.ts` — `(userId, …, db)`, `system.ts` — `(db, key, now)`, `ensureUser(tgId, db, now)`. Не баг, але в Фазі 1 нові функції підуть за котримось із двох стилів навмання.
3. **`openDb(env)` двічі за один прогін cron:** `scheduled.ts:37` і `:26` (у `pingMonitor`). Дубль дескриптора — нешкідливий, але `pingMonitor` міг би брати `db` параметром.
4. **Тест `parseAllowlist` живе у `tone.test.ts:74`** (файл про тон текстів) — при пошуку тестів allowlist його не видно.
5. **Ловля всіх помилок у `app.ts:39-45`** — правильна для Фази 0, але Фаза 1 вимагає інакшого поводження з помилками D1 на записі захоплення (0.7.a відсилає до `phase-1.md`): цей `catch` доведеться розщепити, інакше захоплення тихо губляться з 200.
6. **`processQueue` після `pingMonitor`** (`scheduled.ts:44-46`): повільний монітор затримує роботу черги до 5 с (а з R3 — без межі). Для Фази 2 (відправка нагадувань із cron) порядок варто переглянути.
7. **Мертвий код:** `getById` використовують лише тести (`db.test.ts`, `guard.test.ts`); `queueSize` — константа за спекою 0.2.e; `processQueue` — порожній каркас для 2.2. Усе задокументовано, вилучати не треба.
8. **Лексичний сканер 0.4.c** не бачить обчислений ключ (`env["D"+"B"]`, R4) і файли не `.ts` у `src/`. Прийнятний ризик: друга лінія — непрозорий `Db` і рев'ю.
9. `START_RE` приймає `/start@будь_який_бот` (відомо з рев'ю 0.4) — у приватному чаті нешкідливо.

## 5. «Борг» → блокери Фази 1

| Пункт «Боргу» | Блокує Фазу 1? |
|---|---|
| `scripts/mutate.py` немає (S0.8.b, правило 9) | Не блокує роботу (кроки ганяють скіловий скрипт), але **історія Фази 0 не виконана**, а `CLAUDE.md` правило 9 посилається на файл, якого немає → у fix-список |
| Тест 0.3.f → 2.2 | Ні (свідоме рішення 0.5) |
| (новий) R3 — тест таймауту | Ні для Фази 1, але правило «монітор кричить» спирається на нього → fix-список |
| (новий) `system.ts` без списку імен | **Так, перед 1.1/1.5:** S1.5.c кладе туди першу вибірку з даними користувачів → fix-список |
| (новий) preview на сироті `c2b9dff` | Ні, але ворота «`health.sha = HEAD`» для наступних кроків — передеплоїти з `origin/main` після мержу виправлень |

## 6. Мутаційна перевірка (скіловий `mutate.py`, після чистого дерева; `git status` порожній до і після)

| id | Правило | Що зламав | Результат |
|---|---|---|---|
| R1 | Вебхук без секрету відхиляється до розбору тіла | `app.ts`: `request.json()` перед перевіркою секрету | KILLED — `0.1.e` (кривий JSON дав 400 замість 401) |
| R2 | Allowlist fail-closed | `config.ts:8`: сміття → `continue` замість `return null` | KILLED — `parseAllowlist` / `0.6.c` |
| R3 | Dead man's switch: пінг із таймаутом 5 с | `scheduled.ts:21`: `fetch` без `signal` | **SURVIVED** — мок у `scheduled.test.ts:77-81` читає `init!.signal.addEventListener`; без `signal` він кидає `TypeError` одразу, `pingMonitor` ловить, тест зелений. Таймаут не доведено |
| R4 | (зонд) огорожа 0.4.c | `health.ts`: `env["D"+"B"]` | SURVIVED — очікувано, лексичний сканер (шов 8) |
| R5 | (зонд) огорожа 0.4.d | `system.ts`: новий `allUserTgIds(db)` | SURVIVED — `system.ts` виключено цілим файлом (шов 1) |
| C1 | 0.8.a: CI червоніє на помилці типу | `clock.ts`: `now: () => "now"` | KILLED — `npm run typecheck` |
| C2 | 0.8.a: CI червоніє на спеці > 40 КБ | `docs/spec/phase-0.md` + 30 КБ | KILLED — `check:docs` «ЧЕРВОНЕ» |

## 7. Межа preview / prod

- `wrangler.toml`: `account_id` на верхньому рівні; `adhd-bot-preview` / `adhd-bot-prod`; `adhd-preview` / `adhd-prod`; верхній рівень без D1 і cron; cron у кожному env — ✅ (тест + читання файлу).
- preview: секрети `ALLOWED_TG_IDS`, `BOT_TOKEN`, `MONITOR_PING_URL`, `WEBHOOK_SECRET` (`wrangler secret list --env preview`, лише назви). prod: Worker не існує, D1 — плейсхолдер `REPLACE_WITH_PROD_D1_ID` (випадковий `deploy --env production` впаде на біндингу, а не піде в preview-базу) — ✅.
- `env.DB` поза `src/db/`: 0 збігів (`guard.test.ts`), плюс перевірка типів непрозорого `Db` — ✅.

## 8. Секрети в історії git

- `git log --all -p` (5 комітів `main`) **і** pre-squash голови PR #1–#4 з GitHub (`refs/pull/N/head`, 17 комітів, яких немає в `main`): 0 збігів `\d{8,}:[\w-]{30,}`, крім фейкового `123456789:AAH…` у тексті рев'ю 0.4 (сценарій мутанта); `hc-ping.com/` — лише плейсхолдер `<uuid>` у PROGRESS і `hc-ping.example/…` у тестах. `git ls-files | grep -iE '\.env|\.dev\.vars|secret'` — порожньо.
- Репозиторій `PRIVATE` (`gh repo view`).

## Список для `fix/phase-0-review`

1. **R3 — тест таймауту 0.3.c має червоніти без `signal`.** Мок `fetch` не повинен залежати від наявності `signal`: «завислий» `fetch`, що відхиляється лише на `abort`; без `signal` прогін не завершиться за 5 с → тест червоний. Повторити R3 → KILLED.
2. **R5 — огорожа 0.4.d для `system.ts`:** замість виключення файлу — закритий список імен (`readHeartbeat`, `heartbeat`, `markPingOk`, `queueSize`); новий експорт без `userId` і поза списком → червоний. Повторити R5 → KILLED.
3. **S0.8.b — `scripts/mutate.py` у репозиторії** з відмовою на брудному дереві (`git status --porcelain` непорожній → вихід 2) і тестом на це; `CLAUDE.md` правило 9 і промпти фаз — на нього. Альтернатива (рішення диспетчера / Дениса): змінити спеку 0.8.b і правило 9 на скіловий скрипт — тоді записати в «Рішення», чому бекап і звірка байтів замінюють перевірку брудного дерева.
4. **0.5.e — після мержу виправлень передеплоїти preview з `origin/main`** (`--var GIT_SHA:$(git rev-parse HEAD)`) і звірити `/health.sha = origin/main`.

На потім (у «Борг»): шви 2–6, 8 з розділу 4; скрипт `lint` (спека не вимагає); 👤 звірити `/setjoingroups → Disable` у BotFather.

## Перевірка R-0

**Критерії готовності:**
- ✅ Таблиця історій ↔ реалізація ↔ тест — розділ 1 (28 рядків, файл:рядок).
- ✅ Повний прогін — розділ 2 (typecheck 0, test 64/64, check:docs зелено, dry-run build 0; lint — скрипта немає).
- ✅ Наскрізні сценарії в Browser pane, десктоп і 375×812, скріншоти `docs/reviews/phase-0/*.jpg`, наслідок — рядки D1 — розділ 3.
- ✅ Шви — розділ 4 (9 пунктів).
- ✅ «Борг» → блокери — розділ 5.
- ✅ Мутації 3 правил (R1–R3) + 2 зонди + 2 мутанти CI — розділ 6, логи `mutate-qg55e11n`, `mutate-k53h0wpp`.
- ✅ Субагент Explore не знадобився: 1 600 рядків коду прочитано напряму.
- ✅ Межа preview/prod, вебхук без секрету, `env.DB`, монітор живцем, історія git, приватність — розділи 3, 7, 8.

**Команди:** typecheck 0 / test 64 passed / check:docs зелено / build dry-run 0.
**Мутаційна перевірка:** R1, R2, C1, C2 KILLED; **R3 SURVIVED** (дефект тесту); R4, R5 SURVIVED як зонди (дефект огорожі R5).
**Ризики й припущення:** 0.5.d і 0.3.g (листи) прийняті за PR #3/#4 — повторно без токена й логіну Дениса не звіряв; `/start` у Telegram не надсилав.
**Доробити в цьому кроці (обовʼязково):** —
**На потім (іде в «Борг» PROGRESS.md):** шви 2–6, 8; скрипт `lint`; `/setjoingroups`.
**Вердикт рев'ю:** фаза **НЕ ЗАКРИТА** — 4 пункти для `fix/phase-0-review`.
