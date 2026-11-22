#!/usr/bin/env bash
# scripts/release.sh — викатка в prod (S3.10, крок 3.3). Запуск: `npm run release` з чистого main = origin/main.
#   npm run release -- --dry-run   усі перевірки й список міграцій, БЕЗ bookmark-відкату, міграцій, деплою, Telegram
#   npm run release -- --first     перша викатка: відкат коду = deleteWebhook, у кінці — команда setWebhook prod (RUNBOOK §3)
#   npm run release -- --yes       без питання «застосувати?» перед міграціями й деплоєм
# Секрети вводить людина (ввід прихований); скрипт їх не друкує й не бере зі змінних оболонки:
# BOT_TOKEN preview, що лишився в env, не має шансу потрапити в prod-бота.
# Журнал і рядок відкату — поза репозиторієм ($RELEASE_LOG_DIR, за замовчуванням ~/adhd-releases): дерево лишається чистим,
# а файл переживає видалення worktree. Відкат — docs/RUNBOOK.md.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

DRY=0 FIRST=0 YES=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --first) FIRST=1 ;;
    --yes) YES=1 ;;
    *) echo "Невідомий прапорець: $a (є --dry-run, --first, --yes)"; exit 2 ;;
  esac
done
# API_ROOT — теж: з ним крок 9 (меню команд) шле токен prod-бота на інший хост (рев'ю 3.3, Д4).
unset BOT_TOKEN WEBHOOK_SECRET API_ROOT

ENV=production
LIB="node scripts/release-lib.mjs"
WR="npx wrangler"
DONE=()
step() { printf '\n== %s\n' "$*"; }
ok() { echo "   ✓ $*"; DONE+=("$*"); }
fail() {
  echo "   ✗ $*" >&2
  echo
  echo "СТОП. Зроблено до зупинки:"
  [ ${#DONE[@]} -eq 0 ] && echo "  - нічого (prod не чіпав)"
  for d in "${DONE[@]}"; do echo "  - $d"; done
  [ -n "${ROLLBACK_FILE:-}" ] && echo "Команди відкату: $ROLLBACK_FILE (docs/RUNBOOK.md, «Відкат»)"
  exit 1
}
# Справжній реліз — стоп; dry-run — попередження (він лише показує, що зупинить реліз).
stop_or_warn() { if [ $DRY = 1 ]; then echo "   ⚠ $*"; else fail "$*"; fi; }

SHA=$(git rev-parse HEAD)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG_DIR="${RELEASE_LOG_DIR:-$HOME/adhd-releases}/$STAMP-${SHA:0:7}$([ $DRY = 1 ] && echo -dry)"
mkdir -p "$LOG_DIR" || exit 2
echo "Реліз $([ $DRY = 1 ] && echo '(DRY-RUN) ')sha ${SHA:0:12} → env $ENV; журнал: $LOG_DIR"

step "1. Git: чисте дерево й HEAD = origin/main"
git fetch -q origin main || fail "git fetch origin main"
GIT_PORCELAIN=$(git status --porcelain) GIT_HEAD=$SHA GIT_ORIGIN_MAIN=$(git rev-parse origin/main) \
  $LIB git-check "$([ $DRY = 1 ] && echo dry || echo real)" || fail "реліз лише з чистого main = origin/main"
if [ $DRY = 1 ]; then ok "git: dry-run — розбіжності вище лише попередження"; else ok "git: чисте дерево, HEAD = origin/main"; fi

step "2. typecheck + test"
npm run typecheck > "$LOG_DIR/typecheck.log" 2>&1 || { tail -20 "$LOG_DIR/typecheck.log"; fail "typecheck червоний"; }
ok "typecheck зелений"
npm test > "$LOG_DIR/test.log" 2>&1 || { tail -30 "$LOG_DIR/test.log"; fail "тести червоні"; }
grep -E "Tests +[0-9]+" "$LOG_DIR/test.log" | tail -1
ok "тести зелені"

step "3. prod D1 у wrangler.toml"
DB=$($LIB prod-d1 wrangler.toml 2> "$LOG_DIR/prod-d1.err")
D1_RC=$?
if [ $D1_RC -ne 0 ]; then
  if [ $DRY = 1 ]; then
    echo "   ⚠ prod D1 «$DB» ще не створено ($(cat "$LOG_DIR/prod-d1.err")) — RUNBOOK §1, 👤."
    echo "   Нова БД: застосуються всі міграції з migrations/:"
    ls migrations/*.sql | sed 's#^migrations/#     #'
    echo "   Віддалених перевірок prod (секрети, bookmark, migrations list) у dry-run не роблю: ресурсу немає."
    echo
    echo "DRY-RUN завершено: локальні перевірки зелені; prod не створено — віддалені кроки пропущено."
    exit 0
  fi
  fail "prod D1 не створено ($(cat "$LOG_DIR/prod-d1.err")) — RUNBOOK §1"
fi
ok "prod D1: $DB"

step "4. Секрети prod (лише назви)"
$WR secret list --env $ENV > "$LOG_DIR/secrets.log" 2>&1 || { tail -5 "$LOG_DIR/secrets.log"; fail "wrangler secret list"; }
MISSING=$($LIB secrets < "$LOG_DIR/secrets.log") || {
  if [ $DRY = 1 ]; then echo "   ⚠ бракує секретів: $(echo $MISSING)"; else fail "бракує секретів: $(echo $MISSING) — RUNBOOK §2"; fi
}
[ -z "$MISSING" ] && ok "усі 5 секретів НФ-8 є"

step "5. Поточні версії коду (prod, preview) й bookmark D1 (точки відкату)"
# Перша викатка — лише явно (--first) і лише коли журнал порожній: secret put (RUNBOOK §2) уже створив Worker-заглушку,
# тож за deployments status першу викатку не впізнати (рев'ю 3.3, Д2).
RELEASES=$($LIB release-count < docs/releases.md) || fail "не прочитав docs/releases.md"
[ $FIRST = 1 ] || [ "$RELEASES" != 0 ] || stop_or_warn "у docs/releases.md жодної викатки: перша — npm run release -- --first (RUNBOOK §3); ні — допиши рядок попереднього релізу"
# Ціль відкату коду: без --first версія на 100 % обов'язкова. Збій wrangler чи поступова викатка — стоп,
# а не «перша викатка → deleteWebhook» (рев'ю 3.3, В1). Вивід (там пошта автора) — лише у файл.
PREV_VERSION=""
if $WR deployments status --env $ENV --json > "$LOG_DIR/deployments.log" 2>&1; then
  PREV_VERSION=$($LIB deployed-version < "$LOG_DIR/deployments.log")
fi
if [ $FIRST = 1 ]; then
  echo "   перша викатка (--first): відкат коду — deleteWebhook (RUNBOOK, «Відкат»)"
elif [ -n "$PREV_VERSION" ]; then
  echo "   версія до релізу: $PREV_VERSION"
else
  stop_or_warn "не визначив версію prod на 100 % (deployments status, журнал $LOG_DIR/deployments.log) — без цілі відкату коду не викочую"
fi
# «preview не зачеплено» (3.10.a): версію preview знімаю ДО міграцій і деплою, інакше порівняння не почервоніє (рев'ю 3.3, В3).
PREVIEW_VERSION=""
if $WR deployments status --env preview --json > "$LOG_DIR/preview-before.log" 2>&1; then
  PREVIEW_VERSION=$($LIB deployed-version < "$LOG_DIR/preview-before.log")
fi
[ -n "$PREVIEW_VERSION" ] || stop_or_warn "не прочитав версію preview — «preview не зачеплено» не буде чим довести"
echo "   версія preview: ${PREVIEW_VERSION:-—}"
$WR d1 time-travel info "$DB" --env $ENV --json > "$LOG_DIR/bookmark.log" 2>&1 || { tail -5 "$LOG_DIR/bookmark.log"; fail "time-travel info"; }
BOOKMARK=$($LIB bookmark < "$LOG_DIR/bookmark.log") || fail "не розібрав bookmark"
echo "   bookmark: $BOOKMARK"
if [ $DRY = 0 ]; then
  ROLLBACK_FILE="$LOG_DIR/rollback.txt"
  {
    echo "# Відкат релізу ${SHA:0:12} ($STAMP UTC). Порядок і умови — docs/RUNBOOK.md, «Відкат»."
    echo "# 1) Код:"
    if [ $FIRST = 1 ]; then
      echo "# перша викатка: робочої попередньої версії немає — бот замовкає через deleteWebhook (RUNBOOK, «Відкат»)"
    else
      echo "npx wrangler rollback $PREV_VERSION --env $ENV -m \"rollback ${SHA:0:7}\""
    fi
    echo "# 2) БД (лише якщо міграція зламала дані; все, що записано після bookmark, зникне):"
    echo "npx wrangler d1 time-travel restore $DB --env $ENV --bookmark=$BOOKMARK"
  } > "$ROLLBACK_FILE"
  ok "точки відкату записано: $ROLLBACK_FILE"
fi

step "6. Міграції, що застосуються"
$WR d1 migrations list "$DB" --env $ENV --remote > "$LOG_DIR/migrations-list.log" 2>&1 || { tail -5 "$LOG_DIR/migrations-list.log"; fail "migrations list"; }
PENDING=$($LIB pending < "$LOG_DIR/migrations-list.log") || fail "не розпізнав вивід migrations list ($LOG_DIR/migrations-list.log)"
if [ -z "$PENDING" ]; then echo "   нових міграцій немає"; else echo "$PENDING" | sed 's/^/     /'; fi

if [ $DRY = 1 ]; then
  echo
  echo "DRY-RUN завершено: перевірки пройдено, нічого не застосовано й не задеплоєно."
  exit 0
fi

if [ $YES = 0 ]; then
  echo
  read -r -p "Застосувати міграції й задеплоїти ${SHA:0:7} у $ENV? (так / yes — далі, інше — стоп) " ans
  [ "$ans" = "так" ] || [ "$ans" = "yes" ] || fail "людина не підтвердила"
fi

step "7. Застосування міграцій"
if [ -n "$PENDING" ]; then
  CI=true $WR d1 migrations apply "$DB" --env $ENV --remote > "$LOG_DIR/migrations-apply.log" 2>&1 || { tail -15 "$LOG_DIR/migrations-apply.log"; fail "migrations apply"; }
  $WR d1 migrations list "$DB" --env $ENV --remote > "$LOG_DIR/migrations-after.log" 2>&1
  LEFT=$($LIB pending < "$LOG_DIR/migrations-after.log") || fail "не розпізнав migrations list після apply"
  [ -z "$LEFT" ] || fail "після apply лишились: $LEFT"
  ok "міграції застосовано: $(echo $PENDING)"
else
  ok "міграцій не було"
fi

step "8. Деплой з GIT_SHA"
# До розбору виводу: якщо далі стоп, людина має знати, що код, можливо, уже живий і його треба відкотити (рев'ю 3.3, Д1).
DONE+=("запущено wrangler deploy — нова версія може бути вже живою (відкат — rollback.txt)")
$WR deploy --env $ENV --var "GIT_SHA:$SHA" > "$LOG_DIR/deploy.log" 2>&1 || { tail -15 "$LOG_DIR/deploy.log"; fail "wrangler deploy"; }
DEPLOY=$($LIB deploy < "$LOG_DIR/deploy.log") || { echo "$DEPLOY"; fail "деплой без адреси або без cron"; }
URL=$(echo "$DEPLOY" | sed -n 's/^url=//p')
NEW_VERSION=$(echo "$DEPLOY" | sed -n 's/^version=//p')
ok "задеплоєно версію ${NEW_VERSION:-?}, cron «* * * * *» активний"

step "9. Telegram: меню команд (токен prod-бота вводить людина)"
read -r -s -p "BOT_TOKEN prod-бота (ввід прихований): " PROD_TOKEN; echo
[ -n "$PROD_TOKEN" ] || fail "порожній токен"
BOT_TOKEN="$PROD_TOKEN" node scripts/set-commands.mjs || fail "set-commands"
unset PROD_TOKEN
ok "меню команд виставлено"

step "10. Чекаю 2 хв і перевіряю /health"
sleep 120
for i in 1 2 3 4; do
  curl -sS --max-time 10 "$URL/health" > "$LOG_DIR/health.json" 2>&1
  PROBLEMS=$($LIB health "$SHA" < "$LOG_DIR/health.json") && break
  echo "   спроба $i: $PROBLEMS"
  [ $i -lt 4 ] && sleep 30
done
[ -z "$PROBLEMS" ] || fail "/health prod: $PROBLEMS"
ok "/health prod: ok, sha = HEAD, cron не stale"
PREVIEW_AFTER=""
if $WR deployments status --env preview --json > "$LOG_DIR/preview-after.log" 2>&1; then
  PREVIEW_AFTER=$($LIB deployed-version < "$LOG_DIR/preview-after.log")
fi
[ -n "$PREVIEW_VERSION" ] && [ "$PREVIEW_VERSION" = "$PREVIEW_AFTER" ] ||
  fail "3.10.a не доведено: версія preview до міграцій «${PREVIEW_VERSION:-—}», після /health «${PREVIEW_AFTER:-—}». Prod здоровий (вище) — відкочувати його через це не треба; з'ясуй, хто чіпав preview"
ok "preview не зачеплено (версія ${PREVIEW_VERSION:0:8} до міграцій = після /health)"

step "Готово"
for d in "${DONE[@]}"; do echo "  - $d"; done
echo
echo "Рядок у docs/releases.md (результат чекліста допиши після RUNBOOK §4):"
$LIB release-line "$(date -u +%Y-%m-%d)" "$SHA" "$BOOKMARK" $PENDING
echo
echo "Відкат: $ROLLBACK_FILE"
if [ $FIRST = 1 ]; then
  echo "Перша викатка — вебхук prod ставиш ти (RUNBOOK §3, той самий WEBHOOK_SECRET, що в secret put):"
  echo "  node scripts/set-webhook.mjs $URL/webhook"
fi
echo "Далі 👤: чекліст живого прогону — docs/RUNBOOK.md §4."
