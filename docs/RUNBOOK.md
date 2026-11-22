# RUNBOOK — prod РДУГ-бота

Prod — окремі Worker `adhd-bot-prod`, D1 `adhd-prod`, бот і монітор (правило 7). Preview тут не чіпається.
Спека — `docs/spec/phase-3-settings-prod.md` S3.10. 👤 — робить Денис (секрети, токени, «викочуй»); агент лише готує команди.
Команди — у pwsh 7 з кореня репозиторію (`D:\01CLOud CODE\ADHD`) на чистому `main` = `origin/main`.
Репозиторій публічний: у git, PR і `docs/releases.md` — жодних `tg_id`, пошт, токенів, URL пінгу, текстів записів.

## 0. Ворота першої викатки (S3.10) — усі до першої команди на prod

- [ ] R-3 закрите (`PROGRESS.md` на `origin/main`: R-3 ✅/✅).
- [ ] 👤 В3 звіту R-2 пройдено на preview.
- [ ] `time-travel restore` з FTS5 перевірено на preview (`open-questions.md`, «Блокуючі»): запис → bookmark → зміна → restore → `items_fts` цілий. Без цього відкат БД з §5 — неперевірена обіцянка.
- [ ] Вимір Whisper S2.12.b (`docs/notes/whisper-uk.md`, борг R-2 Д6).
- [ ] Код Фази 3 + `0005` на preview і ≥ 1 доби оглядів живцем (рядки `sent` для `digest_morning` і `digest_evening` у preview D1).
- [ ] Денис сказав «викочуй».

## 1. 👤 Ресурси prod (один раз)

1. **Бот.** BotFather → `/newbot` (окремий від preview), назва, опис, аватар; `/setjoingroups` → Disable. Токен — лише в менеджер паролів.
2. **D1.** Створити й вписати id у `wrangler.toml` окремим маленьким PR (`database_id` не секрет — preview теж у репо):

   ```powershell
   npx wrangler d1 create adhd-prod
   ```

   На питання wrangler «додати в конфіг?» — ні: правиш `[[env.production.d1_databases]] database_id` вручну замість `REPLACE_WITH_PROD_D1_ID`. Після мержу `npm run release -- --dry-run` уже показує справжній список міграцій (усі `0001…0005`) і bookmark.
3. **Монітор.** healthchecks.io → нова перевірка `adhd-prod` (окрема від preview): period 1 хв, grace 4 хв, сповіщення — тобі (Telegram/пошта). Ping URL — секрет (§2), у файли не пишеться. Одразу натисни «Send test notification» і переконайся, що дійшло (3.10.b).
4. **Адреса.** `env.production` має `workers_dev = true` → `https://adhd-bot-prod.<піддомен>.workers.dev` (рекомендація `open-questions.md`, **чекає твого підтвердження**; свій домен — після MVP).

## 2. 👤 Секрети prod (назви з НФ-8 — їх читає код; `TELEGRAM_BOT_TOKEN`/`HEALTHCHECK_URL` код не читає)

Кожна команда питає значення прихованим вводом. Перша може спитати «створити Worker `adhd-bot-prod`?» — так.

```powershell
npx wrangler secret put BOT_TOKEN --env production
```

```powershell
npx wrangler secret put ALLOWED_TG_IDS --env production
```

```powershell
npx wrangler secret put MONITOR_PING_URL --env production
```

```powershell
npx wrangler secret put ANTHROPIC_API_KEY --env production
```

`WEBHOOK_SECRET` — генеруєш у цьому ж вікні pwsh і **не закриваєш його до §3** (той самий секрет піде в `setWebhook`):

```powershell
$s = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)); $s | npx wrangler secret put WEBHOOK_SECRET --env production
```

Перевірка (лише назви, без значень) — реліз робить її сам, крок 4:

```powershell
npx wrangler secret list --env production
```

## 3. Викатка

```powershell
npm run release -- --dry-run
```

Сухий прогін: git, typecheck, тести, prod D1, секрети, bookmark, список міграцій — без застосування й деплою. Зелений → викатка:

```powershell
npm run release -- --first
```

(далі — просто `npm run release`). Що робить `scripts/release.sh`: чисте дерево й HEAD = `origin/main` → typecheck + test → prod D1 створено → 5 секретів є → поточна версія коду й **bookmark Time Travel** у `~/adhd-releases/<час>-<sha>/rollback.txt` → `migrations list` → питання «так» → `migrations apply` (і перевірка, що нічого не лишилось) → `wrangler deploy --env production --var GIT_SHA:<sha>` (адреса й `schedule: * * * * *` у виводі) → `set-commands.mjs` (токен prod-бота вводиш ти) → 2 хв → `/health` prod (ok, sha = HEAD, cron не stale) і `/health` preview (sha той самий, що до релізу) → друкує зроблене й рядок для `docs/releases.md`. Журнали кожного кроку — у тій самій теці `~/adhd-releases/…` (поза репо: переживе видалення worktree).

**Вебхук (лише перша викатка)** — у вікні з `$s` з §2; URL — з виводу релізу:

```powershell
$env:BOT_TOKEN = Read-Host -MaskInput 'BOT_TOKEN prod-бота'; $env:WEBHOOK_SECRET = $s; node scripts/set-webhook.mjs https://adhd-bot-prod.<піддомен>.workers.dev/webhook; Remove-Item Env:BOT_TOKEN, Env:WEBHOOK_SECRET
```

`ГОТОВО` у виводі = Telegram повернув той самий `url` і `allowed_updates`, помилок немає. Вікно з `$s` закрилось раніше — згенеруй новий `$s`, знову `secret put WEBHOOK_SECRET` і цей рядок.

## 4. 👤 Чекліст живого прогону (3.10.a–e) — докази в `docs/releases.md`

Запити до prod D1 — лише лічильники, без текстів і `tg_id` у виводі:

```powershell
npx wrangler d1 execute adhd-prod --env production --remote --json --command "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM items) AS items, (SELECT COUNT(*) FROM reminders WHERE kind LIKE 'digest_%' AND status='pending') AS digests_pending, (SELECT COALESCE(SUM(delta),0) FROM points_ledger) AS points"
```

1. [ ] **3.10.a** Реліз надрукував `/health prod: ok, sha = HEAD, cron не stale` і `preview не зачеплено`.
2. [ ] **3.10.b** healthchecks `adhd-prod` — «up», останній пінг ≤ 2 хв; 15 хв після деплою без тривоги; тестове сповіщення дійшло (§1.3).
3. [ ] **3.10.c** `getWebhookInfo`: `url` — адреса prod, `pending_update_count` 0 після `/start`, `last_error_message` порожній:

   ```powershell
   $t = Read-Host -MaskInput 'BOT_TOKEN prod-бота'; (Invoke-RestMethod "https://api.telegram.org/bot$t/getWebhookInfo").result | Select-Object url, pending_update_count, last_error_message, allowed_updates; Remove-Variable t
   ```

4. [ ] **3.10.d** `/start` → `users` = 1 і це ти (вводиш свій id — у виводі лише число):

   ```powershell
   $id = Read-Host 'мій tg_id'; npx wrangler d1 execute adhd-prod --env production --remote --json --command "SELECT COUNT(*) AS me FROM users WHERE tg_id = $id"; Remove-Variable id
   ```

   `me` = 1 → у доказі пишеш «збігається», не значення.
5. [ ] **3.10.d** Голосове з двома справами, одна — «через 3 хв важливо …» → квитанція з двома рядками; `items` = 2 (запит угорі).
6. [ ] **3.10.d** Нагадування прийшло ±1 хв, повтор через 5 хв; ✅ → `points` зросли на +10; `digests_pending` = 3.
7. [ ] **3.10.e** Через добу: ранковий і вечірній огляди прийшли ±1 хв від годин у `/settings`:

   ```powershell
   npx wrangler d1 execute adhd-prod --env production --remote --json --command "SELECT kind, status, COUNT(*) AS n FROM reminders WHERE kind LIKE 'digest_%' GROUP BY kind, status"
   ```

8. [ ] `/settings`: тиха ніч і години оглядів — як тобі треба (пункт «Запуск» плану).

Пройдено → рядок у `docs/releases.md` («результат» — що з 1–8 ✅) і ✅ кроку 3.3 у `PROGRESS.md` крихітним PR.

## 5. Відкат

Точні команди з bookmark і версією — у `~/adhd-releases/<час>-<sha>/rollback.txt` того релізу (і bookmark — у рядку `docs/releases.md`). Порядок: **спершу код (або тиша бота), потім БД** — інакше старий код зустріне нову схему чи навпаки.

**Код.**
- *Перша викатка* — попередньої робочої версії немає (версія від `secret put` — порожня заглушка). Відкат = бот мовчить, записи цілі:

  ```powershell
  $t = Read-Host -MaskInput 'BOT_TOKEN prod-бота'; Invoke-RestMethod -Method Post "https://api.telegram.org/bot$t/deleteWebhook"; Remove-Variable t
  ```

  Cron працює далі (пінгує монітор, шле нагадування) — щоб зупинити й його, Cloudflare → Workers → `adhd-bot-prod` → Settings → Triggers → видалити cron (повернеться наступним деплоєм).
- *Наступні викатки* — до версії, що **працювала до релізу** (з `rollback.txt`), а не «до попереднього деплою»: `secret put` теж створює версію.

  ```powershell
  npx wrangler rollback <PREV_VERSION_ID> --env production -m "rollback <sha>"
  ```

**БД** — лише якщо міграція зламала дані. Усе, записане після bookmark, зникне (записи людини за цей час — теж): спершу вирішуєш, чи це гірше за поломку. Restore з FTS5 — лише якщо ворота §0 (перевірка на preview) пройдено.

```powershell
npx wrangler d1 time-travel restore adhd-prod --env production --bookmark=<BOOKMARK>
```

Підказка wrangler після `time-travel info` друкує restore **без** `--env` — так не спрацює (верхній рівень `wrangler.toml` навмисно без D1); завжди з `--env production`. Після restore таблиця `d1_migrations` теж повертається — наступний `npm run release` застосує міграції знову.

Новий bookmark будь-коли (лише читання):

```powershell
npx wrangler d1 time-travel info adhd-prod --env production --json
```

## 6. Монітор кричить (немає пінгу ≥ 5 хв)

Бот про власну тишу сказати не може (НФ-6) — тривога монітора і є сигнал. По черзі:

1. `/health` prod у браузері чи `Invoke-RestMethod https://adhd-bot-prod.<піддомен>.workers.dev/health`:
   - **503 `{"error":"db"}`** — D1 недоступна → cloudflarestatus.com; нічого не відкочуй, поки D1 лежить.
   - **`cron.stale: true`** — cron не б'ється → Cloudflare → `adhd-bot-prod` → Triggers: cron `* * * * *` є? Немає → повторити `npm run release` (деплой поверне тригер). Є → Observability: помилки `scheduled`.
   - **`ok: false, monitor: "missing"`** — немає `MONITOR_PING_URL` → §2.
   - **`ok: true`, свіжий `last_run_at`** — cron живий, не доходить пінг: URL пінгу в секреті змінився чи монітор видалено → healthchecks, `secret put MONITOR_PING_URL` знову.
2. Тривога після свіжого релізу → відкат коду (§5), рядок у `docs/releases.md` з причиною.
3. Доказ подій бери з Cloudflare Observability (зберігає події), а не з `wrangler tail`: tail після реконнекту може мовчки перестати писати.
4. Повернулось «up» → коротко в `docs/releases.md` (дата, причина, що зробив).
