# Прогрес

Єдина пам'ять між сесіями. Стан читається лише з `origin/main`. Порядок рядків = порядок кроків у `docs/prompts/phase-N.md`.
Статус: ⬜ не почато · 🟡 у роботі / PR відкритий · ✅ змерджено. Рев'ю: — не потрібне · ⬜ потрібне (🔒) · ✅ закрите.
Позначки в назві: 🔒 — рев'ю до мержу · 👤 — крок людини.

## Кроки

| id | Назва | Модель | Effort | Гілка | Статус | Рев'ю |
|---|---|---|---|---|---|---|
| 0.1 | Каркас репозиторію і процес | Opus 5.5 | high | `main` (перший коміт) | ✅ | — |
| 0.2 | Специфікація Фаз 0–1 · 🔒 | Opus 5.5 | high | `phase-0/02-spec` | ✅ | ✅ |
| 0.3 | Інструменти й CI | Sonnet 5.5 | medium | `phase-0/03-ci` | ⬜ | — |
| 0.4 | Worker, оточення preview/prod і шар даних · 👤 · 🔒 | Opus 5.5 | high | `phase-0/04-worker-db` | ⬜ | ⬜ |
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

- `npm run check:docs` ще не існує — до кроку 0.3 бюджет перевіряється `bash scripts/check-docs.sh`. (0.1)

## Рішення

- **2026-11-20** Гілки фазових рев'ю — `review/phase-<N>`, фінального — `review/phase-F` (за правилом «Гілки» в `docs/PROMPTS.md`; у промптах фаз явно не названі). (0.1)
- **2026-11-20** `scripts/check-docs.sh` перевіряє `docs/spec/*.md`, `docs/prompts/*.md`, `CLAUDE.md`, `docs/PROGRESS.md` ≤ 40 КБ і `docs/PROMPTS.md` ≤ 60 КБ; відсутній файл — не помилка. (0.1)
- **2026-11-20** Рішення специфікації (allowlist, `captures`, `date_unclear`, повтори розбору, правила дат) — у `docs/spec/decisions.md`, відкриті питання — `docs/spec/open-questions.md`. (0.2)
- **2026-11-20** Рев'ю 0.2 (ПРИЙНЯТИ ПІСЛЯ ВИПРАВЛЕНЬ) закрито: Б1–Б2, В1–В6, Д1–Д6 виправлено в спеці, рядки рішень — `docs/spec/decisions.md`; «Борг» не поповнено. (0.2)

## Нотатка для наступного кроку

0.3 (CI): тримай разом з `npm run check:docs` = `bash scripts/check-docs.sh`; `scripts/mutate.py` відмовляється працювати з брудним деревом (S0.8). Спека Фаз 0–1 готова: `docs/spec/phase-0.md`, `phase-1.md` (історії `S0.x`/`S1.x`, критерії `0.1.a`…). `phase-1.md` ≈ 37,9 КБ з 40 — нові правила Фази 1 пиши в `decisions.md`, а не в зріз. Після рев'ю 0.2 у спеці є `capture_fixes` + тригери (S1.6), `users.*_variant_idx`, перевірка `chat.type` (0.6.d) і fail-closed `WEBHOOK_SECRET` (0.1.g): 0.4/1.1 реалізують їх за DDL зі спеки.
