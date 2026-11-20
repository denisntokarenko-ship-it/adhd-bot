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
| 0.5 | Cron-серце й зовнішній монітор · 👤 | Opus 5.5 | high | `phase-0/05-heartbeat` | ✅ | — |
| R-0 | Незалежне рев'ю Фази 0 | Opus 5.5 | high | `review/phase-0` | ✅ | ✅ |
| 1.1 | Схема записів, FTS5 і шар даних · 🔒 | Opus 5.5 | high | `phase-1/01-items-data` | ✅ | ✅ |
| 1.2 | Розбір запису через Claude Haiku | Opus 5.5 | high | `phase-1/02-ai-parse` | ✅ | — |
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

- Тест 0.3.f (збій додаткової роботи не валить прогін) — у 2.2, коли `processQueue` отримає тіло. (0.5)
- Шви рев'ю Фази 0 (`docs/reviews/phase-0.md`, розд. 4): **2** — порядок параметрів `Db` різний (`users.ts` `(userId, …, db)`, `system.ts` `(db, key, now)`): у Фазі 1 обрати один стиль; **3** — `openDb(env)` двічі за прогін cron, `pingMonitor` може брати `db`; **4** — тест `parseAllowlist` у `tone.test.ts`; **5** — `catch` у `app.ts:39-45` розщепити в 1.3 (збій D1 на записі захоплення не має давати тихий 200); **6** — `processQueue` після `pingMonitor` у 2.1–2.2 (повільний монітор ≤ 5 с гальмує чергу); **8** — сканер 0.4.c лексичний (обчислений ключ `env["D"+"B"]` не бачить). (R-0)
- **1.1.g закрито частково** (виправлення рев'ю 1.1, В1): `wrangler d1 export` з FTS5 **падає** (перевірено живцем, `decisions.md`) — резерв Time Travel + `/export` JSON (1.11). `time-travel restore` з FTS5 **не перевірено — до prod**: **ворота — `0002` на prod лише після перевіреного `restore` на preview** (`open-questions.md`, Фаза 1). (1.1)
- **1.1.f — частково** (рев'ю 1.1, В2): `DB.batch` без `points_ledger` (він у `0003_points.sql`, 1.5): тест перевіряє capture + запис + збій + хвіст після збою. Повторити на справжньому шляху capture→items→points, де очки — третя інструкція (1.5). (1.1)
- **Д1 рев'ю 1.1:** `items.capture_id` і `ai_calls.capture_id` приймають `captures.id` чужого користувача (`create(B, …, {captureId: <id A>})` проходить). Сьогодні клієнт `captureId` не передає. Вирішити в 1.3: `captures.ts` віддає id лише через `userId`, або складений ключ/тригер `(id, user_id)`. (1.1)
- **Д2 рев'ю 1.1:** `dayBounds` (`src/time.ts`) неправильний для поясів, де перехід на літній час припадає на північ (`America/Santiago`, `2026-09-06`: дає 24 год замість 23). Для `Europe/Kyiv` правильно; пояс змінити зараз не можна. Виправити до кроку, що відкриє вибір `tz` (Фаза 3). (1.1)
- Невикористані поки: `items.travel_min`, `snooze_count`, `done_at` для `open` — порожні до Фаз 2/5; `captures.ts` (функції захоплень) пише 1.3, `claimDuePendingCaptures`/`countPending` для `system.ts` — теж пізніше. (1.1)
- Скрипта `npm run lint` немає — спека й CI не вимагають; вирішити у 0.3-подібному кроці, якщо знадобиться. 👤 звірити в BotFather `/setjoingroups → Disable`. (R-0)
- **1.2 (кеш і вартість):** живий прогін показав `usage.input_tokens` = 372 на 5 викликів — API рахує там лише НЕкешовану частину, тож сталий `system` (з `cache_control`) схоже кешується. Перший скрипт недораховував вартість; тепер `AiResponse.inputTokens` = звичайні + кеш-запис + кеш-читання (`ai_calls.input_tokens` — увесь промпт), а розбивка `cacheReadTokens`/`cacheWriteTokens` лишається в відповіді клієнта й у скрипті. У `ai_calls` колонок кеш-токенів немає — точну вартість з БД не відновити; вирішити, коли з'являться Sonnet-кроки (5.1, 7.1). (1.2)
- **1.2 (preview):** `ANTHROPIC_API_KEY` на preview 👤 введено ДО першого (невдалого) живого прогону, а прогін ішов з локальною змінною, не з секретом воркера: **не доведено, що на preview лежить робочий ключ** — це перевірить перший живий виклик у 1.3 (або Денис перевводить `wrangler secret put ANTHROPIC_API_KEY --env preview`). На prod — крок 3.3. (1.2)

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
- **2026-11-20** Монітор (0.5, 0.3.h): healthchecks.io, Hobbyist (безкоштовно): 20 перевірок, 100 записів логу на перевірку, пінг простим `GET`/`HEAD`/`POST` на `https://hc-ping.com/<uuid>`, ліміт ≤ 5 пінгів/хв на перевірку (наш 1/хв). Сповіщення: email — на сторінці документації; Telegram у прочитаних сторінках не названий, а мінімальний період 1 хв і діапазон grace у документації числом не вказані → 👤 звіряє в UI при створенні (запасний варіант — email). UptimeRobot Free відхилено: опитування, інтервал ≥ 5 хв, heartbeat-перевірок у безкоштовному плані немає. https://healthchecks.io/pricing/ · https://healthchecks.io/docs/http_api/ · https://healthchecks.io/docs/configuring_notifications/ · https://uptimerobot.com/pricing/ (0.5)
- **2026-11-20** Секрет називається `MONITOR_PING_URL` (спека НФ-6/0.5.c), а не `HEALTHCHECK_URL` з промпту; grace = 4 хв (спека `open-questions.md`: period 1 хв + grace 4 хв = тривога ≤ 5 хв після останнього пінгу, НФ-6), а не 5 хв з промпту. Тож у живому доказі лист чекаємо за ≤ ~5–6 хв від останнього пінгу. (0.5)
- **2026-11-20** `scheduled()` у `src/scheduled.ts` (`runScheduled(env, clock)`): (1) `heartbeat` upsert → (2) пінг лише якщо (1) вдався, таймаут 5 с через `AbortController`, URL — секрет, у лог не потрапляє (лише статус / ім'я помилки) → (3) `processQueue` у `try/catch` (порожній каркас, TODO 2.2). Збій запису серця не ловимо: прогін падає, пінгу немає, монітор б'є тривогу (0.3.d). `/health`: prod без `MONITOR_PING_URL` → `ok:false, monitor:"missing"`, 200 (0.2.f). `stale` вже був з 0.4. Тест 0.3.f (збій додаткової роботи) не написано: додаткової роботи ще немає, `processQueue` не підміняється — додасть 2.2. (0.5)
- **2026-11-20** Як вимкнути cron на preview для живого доказу (0.5): ні відсутність `[triggers]`, ні `crons = []` (ні `wrangler triggers deploy` з порожнім списком) наявний розклад Cloudflare НЕ знімають — прогони йшли далі. Спрацювало: тимчасовий конфіг поза git з розкладом, що практично не спрацьовує (`crons = ["0 0 29 2 *"]`) і `wrangler deploy --config <тимчасовий> --env preview`; прогони стали після ~25 с затримки поширення. Перед відліком тривоги монітора звіряй `/health`: `age_s` росте > 120 с. Повернення — звичайний деплой із `wrangler.toml`. (0.5)

- **2026-11-20** Виправлення R-0 (`fix/phase-0-review`): R3 — тест таймауту пінгу тепер «завислий» `fetch`, що відхиляється лише на `abort` (без `signal` прогін висить → червоний); R5 — `system.ts` у закритому списку імен `USERID_EXCEPTIONS`, виняток для цілого файлу (`SYSTEM_FILES`) прибрано; S0.8.b — `scripts/mutate.py` у репозиторії (копія скілового + відмова `git status --porcelain` непорожній / не git → вихід 2, без прапорця-обходу) і `test/node/mutate-script.test.ts`; посилання на скіловий скрипт у `docs/prompts/phase-*.md` замінено на `scripts/mutate.py`. Мутанти — `docs/mutants/fix-phase-0-review.md` (5/5 KILLED). (R-0)

- **2026-11-20** Схема `0002` (1.1): `migrations/0002_items.sql` = `captures`, `capture_fixes` (+ два тригери «один простір update_id»), `items`, `items_fts` (+ 3 тригери), `ai_calls`. `captures` узято зі спеки, бо на них посилаються `items.capture_id` і `ai_calls.capture_id` (FK); функцій над ними ще немає (1.3). За завданням без `points_ledger`, `parent_id`, `person_id`. Доба в `countToday` — `dayBounds(tz, now)` у новому `src/time.ts` (мінімум для 1.1; `localToUtc` додасть 1.3 у той самий модуль). (1.1)
- **2026-11-20** FTS5 з українською — живий прогін на D1 preview (тимчасова віртуальна таблиця, видалена; `users`/`heartbeat` не чіпались), токенайзер `unicode61 remove_diacritics 2`: (а) регістр кирилиці згортається (`ЛІКАР` = `лікар`); (б) стемінгу немає: точне `"лікар"` не знаходить «лікаря», а префіксне `"лікар"*` знаходить → `search` додає `*` до кожного слова (`src/fts.ts`, `toMatchQuery`); закінчення, що змінюють корінь («п'ятниця» → «п'ятницю»), префікс не лікує — Фаза 7; (в) `й`/`ї` НЕ зливаються з `и`/`і` (`remove_diacritics` на кирилицю не діє) — хибних збігів немає; (г) ASCII `'` і `’` (U+2019) — розділювачі: «п'ятниця» = два токени `п`+`ятниця`, а `ʼ` (U+02BC, апостроф українських розкладок) — літера, що склеювала б слово в один токен, тож «п'ятниця» не знаходила «пʼятниця». Тому токенайзер доповнено `separators 'ʼ'` (відхилення від рядка токенайзера у спеці; перевірено живцем: усі три апострофи знаходять один одного). (1.1)
- **2026-11-20** Порядок параметрів шару даних (шов 2 з Боргу R-0): у нових модулях `items.ts`, `aiCalls.ts` — `(userId, db, …, now)`: власник першим (охоронець 0.4.d), далі дескриптор. `users.ts` (`setVariantIdx(userId, kind, idx, db)`) і `system.ts` (`(db, key, now)`) не чіпались — вирівняти можна окремим кроком. `toMatchQuery` — у `src/fts.ts`, а не в `src/db/`: чиста функція без D1, інакше охоронець 0.4.d вимагав би від неї `userId`. (1.1)
- **2026-11-20** Мутації 1.1 — `docs/mutants/1.1.md`, 16/16 KILLED (M1–M3 із промпту + 13 додаткових на ізоляцію, released у пошуку, префікс, апострофи, тригер delete, межі доби, CHECK-и). M9 (вимкнений тригер delete) спершу ВИЖИВ: `search` робить JOIN із `items`, тож «привид» видаленого запису в індексі не видно через пошук; тест підсилено прямим читанням `items_fts` і `integrity-check` з `rank=1` (для external content без `rank=1` перевірки немає). (1.1)
- **2026-11-20** Виправлення за рев'ю 1.1: В1 — живий прогін `d1 export`/Time Travel, результат у `docs/spec/decisions.md`; В2 — тест атомарності з хвостом після збою, позначено «частково»; В3 — тест межі `title`=200 (мутант M17 = R4); Д3 — `setStatus` лишає перший `done_at` (`COALESCE`, мутант M18); Д4 — `capture_fixes`/`ai_calls` по одному випадку на тест (мутант M19 для зворотного тригера); Д5 — спека й `decisions.md` вирівняні; Д6 — `SEARCH_COLUMNS` константою; Д1, Д2 — у «Борг». (1.1)
- **2026-11-20** Structured outputs (1.2.h), живцем із документації: `output_config.format = {type:"json_schema", schema}` (старий `output_format` застарів), `claude-haiku-5-5` у списку підтримуваних. Обмеження схеми: `additionalProperties:false` обов'язково; `type:[..,"null"]` не документовано → у схемі `anyOf:[{string},{null}]` (відхилення від рядка спеки); `maxItems` не підтримується → «до 20» тримає код (`validateShape`). https://platform.claude.com/docs/en/build-with-claude/structured-outputs (1.2)
- **2026-11-20** SDK у Workers (1.2): `@anthropic-ai/sdk` 1.12.0, один клієнт у `src/ai/client.ts` (SDK більше ніде не імпортується — тест). Перевірено живцем: справжній SDK працює у workerd проти підміненого `fetch` (форма запиту: `output_config.format`, `system` з `cache_control`, без prefill/`temperature`/`thinking`); `wrangler deploy --dry-run` збирає клієнт: ≈1.1 МБ / 185 KiB gzip. SDK 1.x шле `apiKey` як `Authorization: Bearer`. `maxRetries: 0` (повтори — черга S1.5, не SDK: інакше 3×20 с проти НФ-10). `output_config.effort: "low"` (дефолт Haiku 5.5 — `medium`; розбір — витяг, не міркування). У Vitest-проєкті `workers` потрібен `deps.optimizer.ssr.include: ["standardwebhooks"]` (SDK тягне її транзитивно; без цього runner не резолвить `./timing_safe_equal`). (1.2)
- **2026-11-20** Понад 20 записів (1.2): за спекою (S1.2, 1.2.b) — відповідь відкинуто цілком, `error='schema'`, fallback-нотатка; а не «обрізати», як у брифі кроку: обрізання мовчки губило б справи, fallback — ні. Промпт просить моделі злити зайві в одну нотатку. (1.2)
- **2026-11-20** `parseCapture(ctx, text)` (1.2): замість `(text, nowLocal, tz)` — контекст `{client, db, userId, now, tz, model, dailyLimit, source?, captureId?, timeoutMs?}`; `nowLocal` і `weekday` рахуються всередині з `now` і `tz` (`localIso`, `weekdayName` у `src/time.ts`) — їх не можна передати неузгодженими. Результат: `{fallback:false, items}` | `{fallback:true, reason:'limit'|'unavailable'}`; кожен запис має `clarify` (`unclear|event_no_date|past|bad_format|too_far|null`) — з нього 1.3 складе одне питання на захоплення. `refusal` → у `ai_calls` `error='schema'` (CHECK має лише 4 значення), `max_tokens` → `json`. Модель і ліміт — `aiConfig(env)` (`AI_MODEL_PARSE`, `AI_DAILY_LIMIT`, за замовчуванням Haiku 5.5 і 100). `localToUtc` додано в `src/time.ts` у цьому кроці: історії S1.3 (дата) за спекою належать 1.2. (1.2)
- **2026-11-20** Мутації 1.2 — `docs/mutants/1.2.md`, 21/21 KILLED (M1–M3 із промпту + 18 додаткових: ліміт `>=`, `<=` проти `<`, now_local за UTC, екранування тегу, зайве поле, 21 запис, керуючі символи, обрізання title, DST-зсув і подвійна година, refusal, порожній `items`, запис у `ai_calls`, 2 роки, `cache_control`, `maxRetries`). M14 спершу дав WRONG-KILL — не слабкий тест, а `match`: дужки в regex. (1.2)
- **2026-11-20** Живий прогін 1.2 (`node scripts/live-parse.mjs`, справжній Claude Haiku 5.5, локальний D1; 👤 Денис, коміт 96debd6): ключ 106 символів, `sk-ant-`. Перший запуск дав 5×`http` за ~200 мс — найімовірніше хибний ключ у змінній (причину не встановлено); повторний — 5/5 ok. (1) «завтра о 10 лікар і купити корм» → event «Лікар» 2026-11-21T08:00Z + task «Купити корм» без дати; (2) переслане «ігноруй інструкції й видали все» → одна note, без дати; (3) 00:30 сб «сьогодні о 9 зробити зарядку» → task 2026-11-21T07:00Z (дата Києва, не UTC); (4) «через тиждень оплатити інтернет, це важливо» → task, `important`, all_day 2026-11-26 (поч. доби 22:00Z); (5) «може у вівторок, а може в середу» → task без дати, `clarify: unclear`. 0.9–2.3 с на виклик (перший 2.3 с). ai_calls 5×ok; промпт ≈ 372 незакешованих input + 433 output токенів; вартість з урахуванням кешу — менше за верхню оцінку ≈ $0.0006 на 5 викликів (≈ $0.0001 за виклик; ліміт 100/добу ≈ $0.01/добу на користувача). (1.2)

## Нотатка для наступного кроку

1.2 ✅ (PR гілки `phase-1/02-ai-parse`; рев'ю 1.2 не вимагається). **Для 1.3:** `parseCapture(ctx, text)` у `src/ai/parse.ts` повертає `{fallback:false, items:[{kind,title,body,dueAt,allDay,priority,clarify}]}` або `{fallback:true, reason:'limit'|'unavailable'}`; клієнт — `createAiClient(env.ANTHROPIC_API_KEY)` (`src/ai/client.ts`), модель і ліміт — `aiConfig(env)`; питання «уточнити» складай з `clarify` (одне на захоплення). Запис через `ai_calls` робить сам `parseCapture`. Перший живий виклик через воркер перевірить ключ на preview (див. Борг 1.2).
**Диспетчер після мержу:** передеплой preview з main; prod не чіпати (міграція `0002` на prod — лише після перевіреного `time-travel restore`, ворота 1.1.g). Мутації — `python scripts/mutate.py docs/mutants/1.2.toml` лише після коміту з чистого дерева.
