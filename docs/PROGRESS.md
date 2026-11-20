# Прогрес

Єдина пам'ять між сесіями. Стан читається лише з `origin/main`. Порядок рядків = порядок кроків у `docs/prompts/phase-N.md`.
Статус: ⬜ не почато · 🟡 у роботі / PR відкритий · ✅ змерджено. Рев'ю: — не потрібне · ⬜ потрібне (🔒) · ✅ закрите.
Позначки в назві: 🔒 — рев'ю до мержу · 👤 — крок людини.

## Кроки

| id | Назва | Модель | Effort | Гілка | Статус | Рев'ю |
|---|---|---|---|---|---|---|
| 0.1 | Каркас репозиторію і процес | Opus 5.5 | high | `main` (перший коміт) | ✅ | — |
| 0.2 | Специфікація Фаз 0–1 · 🔒 | Opus 5.5 | high | `phase-0/02-spec` | ✅ | ✅ |
| 0.3 | Інструменти й CI | Sonnet 5.5 | medium | `phase-0/03-ci` | ✅ | — |
| 0.4 | Worker, оточення preview/prod і шар даних · 👤 · 🔒 | Opus 5.5 | high | `phase-0/04-worker-db` | ✅ | ✅ |
| 0.5 | Cron-серце й зовнішній монітор · 👤 | Opus 5.5 | high | `phase-0/05-heartbeat` | ⬜ | — |
| R-0 | Незалежне рев'ю Фази 0 | Opus 5.5 | high | `review/phase-0` | ⬜ | ⬜ |
| 1.1 | Схема записів, FTS5 і шар даних · 🔒 | Opus 5.5 | high | `phase-1/01-items-data` | ⬜ | ⬜ |
| 1.2 | Розбір запису через Claude Haiku | Opus 5.5 | high | `phase-1/02-ai-parse` | ⬜ | — |
| 1.3 | Текстовий запис, квитанція й «не так» | Sonnet 5.5 | medium | `phase-1/03-capture-text` | ⬜ | — |
| 1.4 | Голос і пересилання · 👤 | Sonnet 5.5 | medium | `phase-1/04-voice-forward` | ⬜ | — |
| 1.5 | Журнал очок, /today і /export · 🔒 | Opus 5.5 | high | `phase-1/05-ledger-today-export` | ⬜ | ⬜ |
| R-1 | Незалежне рев'ю Фази 1 | Opus 5.5 | high | `review/phase-1` | ⬜ | ⬜ |
| 2.0 | Специфікація Фази 2 · 🔒 | Opus 5.5 | high | `phase-2/00-spec` | ⬜ | ⬜ |
| 2.1 | Черга нагадувань і планувальник · 🔒 | Opus 5.5 | xhigh | `phase-2/01-reminder-queue` | ⬜ | ⬜ |
| 2.2 | Відправка з cron і кнопки ✅ ⏰ 🗑 | Opus 5.5 | high | `phase-2/02-dispatch-buttons` | ⬜ | — |
| 2.3 | Події: дорога, напередодні й «час виходити» | Sonnet 5.5 | high | `phase-2/03-events-travel` | ⬜ | — |
| 2.4 | Тиша, пауза, зведення й варіації текстів | Sonnet 5.5 | medium | `phase-2/04-quiet-variants` | ⬜ | — |
| R-2 | Незалежне рев'ю Фази 2 | Opus 5.5 | xhigh | `review/phase-2` | ⬜ | ⬜ |
| 3.0 | Специфікація Фази 3 · 🔒 | Opus 5.5 | high | `phase-3/00-spec` | ⬜ | ⬜ |
| 3.1 | Ранок, вечір, тиждень · 🔒 | Sonnet 5.5 | high | `phase-3/01-digests` | ⬜ | ⬜ |
| 3.2 | Налаштування кнопками | Sonnet 5.5 | medium | `phase-3/02-settings` | ⬜ | — |
| R-3 | Незалежне рев'ю Фази 3 | Opus 5.5 | high | `review/phase-3` | ⬜ | ⬜ |
| 3.3 | Перша викатка в prod і скрипт релізу · 👤 · 🔒 | Opus 5.5 | xhigh | `phase-3/03-prod-release` | ⬜ | ⬜ |
| 4.0 | Специфікація Фази 4 · 🔒 | Opus 5.5 | high | `phase-4/00-spec` | ⬜ | ⬜ |
| 4.1 | Схема рутин і шар даних · 🔒 | Opus 5.5 | high | `phase-4/01-routines-data` | ⬜ | ⬜ |
| 4.2 | Майстер рутин і ескалація до відповіді | Opus 5.5 | high | `phase-4/02-routines-bot` | ⬜ | — |
| R-4 | Незалежне рев'ю Фази 4 | Opus 5.5 | high | `review/phase-4` | ⬜ | ⬜ |
| 4.3 | Викатка Фази 4 · 👤 | Opus 5.5 | high | `phase-4/03-release` | ⬜ | — |
| 5.0 | Специфікація Фази 5 · 🔒 | Opus 5.5 | high | `phase-5/00-spec` | ⬜ | ⬜ |
| 5.1 | Мікрокроки через Sonnet · 🔒 | Opus 5.5 | high | `phase-5/01-microsteps` | ⬜ | ⬜ |
| 5.2 | Таймер і очки за старт | Sonnet 5.5 | medium | `phase-5/02-timer` | ⬜ | — |
| R-5 | Незалежне рев'ю Фази 5 | Opus 5.5 | high | `review/phase-5` | ⬜ | ⬜ |
| 5.3 | Викатка Фази 5 · 👤 | Opus 5.5 | high | `phase-5/03-release` | ⬜ | — |
| 6.0 | Специфікація Фази 6 · 👤 · 🔒 | Opus 5.5 | high | `phase-6/00-spec` | ⬜ | ⬜ |
| 6.1 | Правила очок, бонуси й рівні · 🔒 | Opus 5.5 | high | `phase-6/01-points-rules` | ⬜ | ⬜ |
| 6.2 | Досягнення й м'яка тижнева серія · 🔒 | Sonnet 5.5 | high | `phase-6/02-achievements` | ⬜ | ⬜ |
| 6.3 | Магазин нагород · 🔒 | Opus 5.5 | xhigh | `phase-6/03-reward-shop` | ⬜ | ⬜ |
| R-6 | Незалежне рев'ю Фази 6 | Opus 5.5 | xhigh | `review/phase-6` | ⬜ | ⬜ |
| 6.4 | Викатка Фази 6 · 👤 | Opus 5.5 | high | `phase-6/04-release` | ⬜ | — |
| 7.0 | Специфікація Фази 7 · 🔒 | Opus 5.5 | high | `phase-7/00-spec` | ⬜ | ⬜ |
| 7.1 | Пошук питаннями | Opus 5.5 | high | `phase-7/01-ask` | ⬜ | — |
| 7.2 | Люди й дні народження · 🔒 | Sonnet 5.5 | high | `phase-7/02-people` | ⬜ | ⬜ |
| R-7 | Незалежне рев'ю Фази 7 | Opus 5.5 | high | `review/phase-7` | ⬜ | ⬜ |
| 7.3 | Викатка Фази 7 · 👤 | Opus 5.5 | high | `phase-7/03-release` | ⬜ | — |
| R-F | Фінальне рев'ю MVP | Opus 5.5 | xhigh | `review/phase-F` | ⬜ | ⬜ |

Разом: 36 завдань, 9 фазових рев'ю. Рев'ю кроку (🔒) пише `docs/reviews/<id>.md` у гілку кроку; виправлення фазового рев'ю — `fix/phase-<N>-review`.

## Борг

- Cron `* * * * *` оголошено в `wrangler.toml` обох env (спека 0.5.b), але обробника `scheduled()` ще немає (крок 0.5): на preview Cloudflare щохвилини логуватиме відсутність handler-а — очікувано до 0.5. (0.4)
- `scripts/mutate.py` (S0.8.b, правило 9) у репозиторії ще немає — створити до першої мутаційної перевірки (0.4). (0.3)

## Рішення

- **2026-11-20** Гілки фазових рев'ю — `review/phase-<N>`, фінального — `review/phase-F` (за правилом «Гілки» в `docs/PROMPTS.md`; у промптах фаз явно не названі). (0.1)
- **2026-11-20** `scripts/check-docs.sh` перевіряє `docs/spec/*.md`, `docs/prompts/*.md`, `CLAUDE.md`, `docs/PROGRESS.md` ≤ 40 КБ і `docs/PROMPTS.md` ≤ 60 КБ; відсутній файл — не помилка. (0.1)
- **2026-11-20** Рішення специфікації (allowlist, `captures`, `date_unclear`, повтори розбору, правила дат) — у `docs/spec/decisions.md`, відкриті питання — `docs/spec/open-questions.md`. (0.2)
- **2026-11-20** Рев'ю 0.2 (ПРИЙНЯТИ ПІСЛЯ ВИПРАВЛЕНЬ) закрито: Б1–Б2, В1–В6, Д1–Д6 виправлено в спеці, рядки рішень — `docs/spec/decisions.md`; «Борг» не поповнено. (0.2)
- **2026-11-20** Тест Worker+D1: `@cloudflare/vitest-plugin` ^1.8 (замінив `@cloudflare/vitest-pool-workers` ≤0.23; peer `vitest ^4.1 || ^5`), конфіг `cloudflareTest({ wrangler: { configPath } })`, міграції — `readD1Migrations` + `applyD1Migrations` у `setupFiles`. Потрібен wrangler-конфіг → підключає 0.4; у 0.3 — звичайний Node-раннер. https://developers.cloudflare.com/workers/testing/vitest-integration/ (0.3)
- **2026-11-20** Версії: Node 24 у CI (LTS Krypton, = локальна; v26 теж LTS), `actions/checkout@v7`, `actions/setup-node@v7`, vitest 5.1, TypeScript 7.0 (`tsc` працює). https://nodejs.org/en/about/previous-releases (0.3)
- **2026-11-20** Тест Worker+D1 (0.4): два проєкти Vitest — `node` (скани файлів, `wrangler.toml` через `smol-toml`, тексти) і `workers` (`@cloudflare/vitest-plugin` 1.8.5, `environment: "preview"`, міграції в `setupFiles`). Версії живцем: wrangler 4.165.0, grammy 1.46.0, compatibility_date `2026-11-18` (= workerd 1.20261118). https://developers.cloudflare.com/workers/testing/vitest-integration/ (0.4)
- **2026-11-20** Імена секретів — за спекою (`BOT_TOKEN`, `WEBHOOK_SECRET`, `ALLOWED_TG_IDS`), а не `TELEGRAM_*` з тексту промпту; D1 — `src/db/users.ts` (`ensureUser`, `getById`, `setVariantIdx`) і `src/db/system.ts` (читання серця, `queueSize`), а не `heartbeat.ts`; запис серця — крок 0.5. Функції БД беруть непрозорий `Db` (`openDb(env)`, D1 — лише `d1Of`) другим параметром, `userId` — першим. (0.4)
- **2026-11-20** Не-текстові update-и й `edited_message` ігноруються повністю (без `ensureUser`): 0.7.c «без запису» важить більше за «`ensureUser` на кожен update» з 0.1.c. grammY: `botInfo` підставлено з токена (без `getMe` на холодному старті), `handleUpdate` викликаємо самі — `webhookCallback` не потрібен, бо 401/200 повертаємо власною логікою. (0.4)
- **2026-11-20** Ресурси prod (D1, бот-токен) у Фазі 0 не створюються (спека 0.5.f, `open-questions.md`): у `wrangler.toml` `production` лише оголошено з плейсхолдером `REPLACE_WITH_PROD_D1_ID`; створює 3.3. (0.4)
- **2026-11-20** Рев'ю 0.4 (В1): `Db` — непрозорий дескриптор (`unique symbol` + `WeakMap`), поля `d1` немає; шар даних бере D1 через `d1Of(db)`. `d1Of` — другий (поряд з `openDb`) явний виняток «userId першим» для `src/db/index.ts`, бо без експортованого доступу файли `src/db/**` до D1 не дістануться; поза `src/db/` її забороняє сканер (`d1Of`, `.d1`, `DB`), тип — `test/worker/opaque-db.typecheck.ts`. (0.4)

## Нотатка для наступного кроку

0.4 ✅ (рев'ю В1–В5, Д1–Д3 закрито): `src/db/system.ts` має лише `readHeartbeat` — 0.5 додає запис серця (`heartbeat(db, ...)`, `last_ping_ok_at`), `scheduled()` у `src/index.ts` і `MONITOR_PING_URL`. `/health` вже читає ключ `cron` (0.2.f «monitor:missing» — теж 0.5). Тести: `npx vitest run --reporter=dot`; `test/worker/helpers.ts` — `mockTelegram`, `send`, `baseEnv`. Вебхук preview ставить `node scripts/set-webhook.mjs <url>/webhook` (перевіряє `getWebhookInfo`). Нові файли шару даних беруть D1 лише через `d1Of(db)`, перший параметр — `userId` (охоронець у `test/node/guard-lib.ts`); новий пул текстів у `src/texts.ts` тон-тест підхопить сам.
