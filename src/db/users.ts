import type { Db } from "./index";

export interface User {
  id: number;
  tg_id: number;
  tz: string;
  greet_variant_idx: number | null;
  soon_variant_idx: number | null;
  created_at: number;
  last_seen_at: number;
}

const COLUMNS = "id, tg_id, tz, greet_variant_idx, soon_variant_idx, created_at, last_seen_at";

// Виняток №1 із правила «userId першим» (спека 0.4.d): користувача ще не існує.
// Один атомарний upsert: паралельні /start одного tg_id дають один рядок (0.1.b).
export async function ensureUser(tgId: number, db: Db, now: number): Promise<User> {
  const row = await db.d1
    .prepare(
      `INSERT INTO users (tg_id, created_at, last_seen_at) VALUES (?1, ?2, ?2)
       ON CONFLICT(tg_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
       RETURNING ${COLUMNS}`,
    )
    .bind(tgId, now)
    .first<User>();
  if (!row) throw new Error("ensureUser: no row returned");
  return row;
}

export async function getById(userId: number, db: Db): Promise<User | null> {
  return db.d1.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?1`).bind(userId).first<User>();
}

export type VariantKind = "greet" | "soon";

// Запам'ятати індекс останнього показаного варіанта репліки (НФ-4): пам'ять isolate між запитами скидається.
export async function setVariantIdx(userId: number, kind: VariantKind, idx: number, db: Db): Promise<void> {
  const sql =
    kind === "greet"
      ? "UPDATE users SET greet_variant_idx = ?2 WHERE id = ?1"
      : "UPDATE users SET soon_variant_idx = ?2 WHERE id = ?1";
  await db.d1.prepare(sql).bind(userId, idx).run();
}
