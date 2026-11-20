#!/bin/sh
# scripts/check-docs.sh — червоніє (exit 1), якщо файл, який читає агент, переріс бюджет.
# Бюджет: 40 КБ на файл; docs/PROMPTS.md — індекс, 60 КБ. Відсутній файл — не помилка.
cd "$(dirname "$0")/.." || exit 2
LIMIT=40960
LIMIT_PROMPTS=61440
fail=0
checked=0

check() {
  f=$1
  limit=$2
  [ -f "$f" ] || return 0
  checked=$((checked + 1))
  size=$(wc -c < "$f" | tr -d ' ')
  if [ "$size" -gt "$limit" ]; then
    echo "ЧЕРВОНЕ: $f — $size Б > $limit Б: ріж на зрізи"
    fail=1
  fi
}

for f in docs/spec/*.md docs/prompts/*.md CLAUDE.md docs/PROGRESS.md; do
  check "$f" "$LIMIT"
done
check docs/PROMPTS.md "$LIMIT_PROMPTS"

if [ "$fail" -eq 0 ]; then
  echo "check-docs: зелено ($checked файлів у бюджеті)"
fi
exit $fail
