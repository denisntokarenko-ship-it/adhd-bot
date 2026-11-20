// Контракт розбору (phase-1.md «Контракт розбору»): JSON-схема для structured outputs і сувора перевірка
// відповіді кодом. Схемі моделі не довіряємо: зайве поле, не той тип, > 20 записів = відмова цілком (НФ-2).

export const MAX_ITEMS = 20;
export const TITLE_MAX = 200;
export const BODY_MAX = 4000;

export type Kind = "task" | "note" | "event";
export type Priority = "normal" | "important";

export interface RawItem {
  kind: Kind;
  title: string;
  body: string | null;
  due_local: string | null;
  all_day: boolean;
  priority: Priority;
  date_unclear: boolean;
}

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

// Відхилення від спеки: `"type": ["string","null"]` замінено на `anyOf` (structured outputs документують
// anyOf, а типи-масиви — ні); `maxItems` немає (не підтримується) — 20 записів тримає код.
export const PARSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title", "body", "due_local", "all_day", "priority", "date_unclear"],
        properties: {
          kind: { type: "string", enum: ["task", "note", "event"] },
          title: { type: "string" },
          body: nullableString,
          due_local: nullableString,
          all_day: { type: "boolean" },
          priority: { type: "string", enum: ["normal", "important"] },
          date_unclear: { type: "boolean" },
        },
      },
    },
  },
} as const;

const ITEM_KEYS = ["kind", "title", "body", "due_local", "all_day", "priority", "date_unclear"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const have = Object.keys(o);
  return have.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

// null — відповідь порушує схему (будь-який рівень).
export function validateShape(raw: unknown): RawItem[] | null {
  if (!isObject(raw) || !sameKeys(raw, ["items"])) return null;
  const items = raw.items;
  if (!Array.isArray(items) || items.length > MAX_ITEMS) return null;
  const out: RawItem[] = [];
  for (const it of items as unknown[]) {
    if (!isObject(it) || !sameKeys(it, ITEM_KEYS)) return null;
    const { kind, title, body, due_local, all_day, priority, date_unclear } = it;
    if (kind !== "task" && kind !== "note" && kind !== "event") return null;
    if (typeof title !== "string") return null;
    if (body !== null && typeof body !== "string") return null;
    if (due_local !== null && typeof due_local !== "string") return null;
    if (typeof all_day !== "boolean" || typeof date_unclear !== "boolean") return null;
    if (priority !== "normal" && priority !== "important") return null;
    out.push({ kind, title, body, due_local, all_day, priority, date_unclear });
  }
  return out;
}
