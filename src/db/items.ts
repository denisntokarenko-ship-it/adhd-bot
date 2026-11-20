import { toMatchQuery } from "../fts";
import { d1Of, type Db } from "./index";

export type ItemKind = "task" | "note" | "event";
export type ItemSource = "text" | "voice" | "forward" | "button";
export type ItemPriority = "normal" | "important";
export type ItemStatus = "open" | "done" | "released";

export interface Item {
  id: number;
  user_id: number;
  capture_id: number | null;
  kind: ItemKind;
  title: string;
  body: string | null;
  raw_text: string | null;
  source: ItemSource;
  due_at: number | null;
  all_day: number;
  priority: ItemPriority;
  status: ItemStatus;
  travel_min: number | null;
  created_at: number;
  done_at: number | null;
  snooze_count: number;
}

export interface NewItem {
  kind: ItemKind;
  title: string;
  source: ItemSource;
  body?: string | null;
  rawText?: string | null;
  captureId?: number | null;
  dueAt?: number | null;
  allDay?: boolean;
  priority?: ItemPriority;
  travelMin?: number | null;
}

// Поля, які можна міняти після створення. Статус — окремо (`setStatus`), бо тягне за собою `done_at`.
export interface ItemPatch {
  kind?: ItemKind;
  title?: string;
  body?: string | null;
  dueAt?: number | null;
  allDay?: boolean;
  priority?: ItemPriority;
  travelMin?: number | null;
}

const COLUMNS =
  "id, user_id, capture_id, kind, title, body, raw_text, source, due_at, all_day, priority, status, travel_min, created_at, done_at, snooze_count";

// Білий список «поле патча → колонка»: імена колонок у SQL беруться лише звідси, ніколи з вхідних даних.
const PATCH_COLUMNS: [keyof ItemPatch, string][] = [
  ["kind", "kind"],
  ["title", "title"],
  ["body", "body"],
  ["dueAt", "due_at"],
  ["allDay", "all_day"],
  ["priority", "priority"],
  ["travelMin", "travel_min"],
];

export async function create(userId: number, db: Db, input: NewItem, now: number): Promise<Item> {
  const row = await d1Of(db)
    .prepare(
      `INSERT INTO items (user_id, capture_id, kind, title, body, raw_text, source, due_at, all_day, priority, travel_min, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       RETURNING ${COLUMNS}`,
    )
    .bind(
      userId,
      input.captureId ?? null,
      input.kind,
      input.title,
      input.body ?? null,
      input.rawText ?? null,
      input.source,
      input.dueAt ?? null,
      input.allDay ? 1 : 0,
      input.priority ?? "normal",
      input.travelMin ?? null,
      now,
    )
    .first<Item>();
  if (!row) throw new Error("items.create: no row returned");
  return row;
}

export async function getById(userId: number, db: Db, id: number): Promise<Item | null> {
  return d1Of(db)
    .prepare(`SELECT ${COLUMNS} FROM items WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<Item>();
}

export interface ListOpenOptions {
  limit?: number;
}

// Відкриті записи: спершу з датою (за зростанням), потім без дати; усередині — за id. Індекс (user_id, status, due_at).
export async function listOpen(userId: number, db: Db, opts: ListOpenOptions = {}): Promise<Item[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const res = await d1Of(db)
    .prepare(
      `SELECT ${COLUMNS} FROM items WHERE user_id = ?1 AND status = 'open'
       ORDER BY due_at IS NULL, due_at, id LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<Item>();
  return res.results;
}

// Чужий або неіснуючий id → null (рядок не змінюється).
export async function update(userId: number, db: Db, id: number, patch: ItemPatch): Promise<Item | null> {
  const sets: string[] = [];
  const binds: unknown[] = [id, userId];
  for (const [key, column] of PATCH_COLUMNS) {
    const value = patch[key];
    if (value === undefined) continue;
    binds.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    sets.push(`${column} = ?${binds.length}`);
  }
  if (sets.length === 0) return getById(userId, db, id);
  return d1Of(db)
    .prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?1 AND user_id = ?2 RETURNING ${COLUMNS}`)
    .bind(...binds)
    .first<Item>();
}

// Зміна статусу. `done` ставить done_at = now (CHECK: done ⇔ done_at); open/released його знімають.
// released — це відпущений, а не видалений запис: він лишається в базі й у пошуку.
export async function setStatus(
  userId: number,
  db: Db,
  id: number,
  status: ItemStatus,
  now: number,
): Promise<Item | null> {
  return d1Of(db)
    .prepare(
      `UPDATE items SET status = ?3, done_at = CASE WHEN ?3 = 'done' THEN ?4 ELSE NULL END
       WHERE id = ?1 AND user_id = ?2 RETURNING ${COLUMNS}`,
    )
    .bind(id, userId, status, now)
    .first<Item>();
}

// Пошук за title і body, включно з released. Найкращий збіг першим.
export async function search(userId: number, db: Db, query: string, limit = 20): Promise<Item[]> {
  const match = toMatchQuery(query);
  if (match === null) return [];
  const cols = COLUMNS.split(", ")
    .map((c) => `i.${c}`)
    .join(", ");
  const res = await d1Of(db)
    .prepare(
      `SELECT ${cols} FROM items_fts f JOIN items i ON i.id = f.rowid
       WHERE items_fts MATCH ?1 AND i.user_id = ?2
       ORDER BY f.rank, i.id LIMIT ?3`,
    )
    .bind(match, userId, Math.min(Math.max(Math.trunc(limit), 1), 100))
    .all<Item>();
  return res.results;
}
