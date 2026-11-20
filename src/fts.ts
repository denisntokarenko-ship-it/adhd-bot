// Підготовка користувацького запиту для FTS5 (items_fts). Чиста функція без доступу до БД — тому поза src/db/.

const MAX_TOKENS = 8;
const MAX_TOKEN_LENGTH = 64;

// Користувацький ввід → безпечний вираз FTS5. Кожне слово береться в лапки (лапки всередині подвоюються) —
// тож AND/OR/NEAR/`*`/дужки/`"` стають звичайним текстом, а не синтаксисом. Слова без літер і цифр відкидаються
// (порожня фраза в FTS5 — це помилка). Суфікс `*` = префіксний пошук: стемінгу в unicode61 немає, а «лікар» має
// знаходити «лікаря». Слова зʼєднуються через пробіл = AND.
export function toMatchQuery(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, MAX_TOKENS)
    .map((t) => `"${t.slice(0, MAX_TOKEN_LENGTH).replaceAll('"', '""')}"*`);
  return tokens.length > 0 ? tokens.join(" ") : null;
}
