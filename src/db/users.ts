import { d1Of, type Db } from "./index";

export interface User {
  id: number;
  tg_id: number;
  tz: string;
  greet_variant_idx: number | null;
  soon_variant_idx: number | null;
  today_variant_idx: number | null;
  created_at: number;
  last_seen_at: number;
}

const COLUMNS = "id, tg_id, tz, greet_variant_idx, soon_variant_idx, today_variant_idx, created_at, last_seen_at";

// Виняток №1 із правила «userId першим» (спека 0.4.d): користувача ще не існує.
// Один атомарний upsert: паралельні /start одного tg_id дають один рядок (0.1.b).
export async function ensureUser(tgId: number, db: Db, now: number): Promise<User> {
  const row = await d1Of(db)
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
  return d1Of(db).prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?1`).bind(userId).first<User>();
}

export type VariantKind = "greet" | "soon" | "today";

// Запам'ятати індекс останнього показаного варіанта репліки (НФ-4): пам'ять isolate між запитами скидається.
export async function setVariantIdx(userId: number, kind: VariantKind, idx: number, db: Db): Promise<void> {
  const sql = {
    greet: "UPDATE users SET greet_variant_idx = ?2 WHERE id = ?1",
    soon: "UPDATE users SET soon_variant_idx = ?2 WHERE id = ?1",
    today: "UPDATE users SET today_variant_idx = ?2 WHERE id = ?1",
  }[kind];
  await d1Of(db).prepare(sql).bind(userId, idx).run();
}

// Параметри доставки нагадувань: чат, пояс і година «завтра» (S2.4.e). Окремо від `User`, щоб не роздувати його.
export interface Delivery {
  tg_id: number;
  tz: string;
  morning_at: number;
}

export async function getDelivery(userId: number, db: Db): Promise<Delivery | null> {
  return d1Of(db).prepare("SELECT tg_id, tz, morning_at FROM users WHERE id = ?1").bind(userId).first<Delivery>();
}

export type AckKind = "ok" | "later" | "rel";

// Пам'ять варіанта підтверджень — колонка на пул (НФ-4, S2.10.b): інакше ✅ → ⏰ → ✅ повторив би текст.
export async function getAckIdx(userId: number, kind: AckKind, db: Db): Promise<number | null> {
  const sql = {
    ok: "SELECT ack_ok_idx AS idx FROM users WHERE id = ?1",
    later: "SELECT ack_later_idx AS idx FROM users WHERE id = ?1",
    rel: "SELECT ack_rel_idx AS idx FROM users WHERE id = ?1",
  }[kind];
  const row = await d1Of(db).prepare(sql).bind(userId).first<{ idx: number | null }>();
  return row?.idx ?? null;
}

export async function setAckIdx(userId: number, kind: AckKind, idx: number, db: Db): Promise<void> {
  const sql = {
    ok: "UPDATE users SET ack_ok_idx = ?2 WHERE id = ?1",
    later: "UPDATE users SET ack_later_idx = ?2 WHERE id = ?1",
    rel: "UPDATE users SET ack_rel_idx = ?2 WHERE id = ?1",
  }[kind];
  await d1Of(db).prepare(sql).bind(userId, idx).run();
}
