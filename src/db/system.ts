import { d1Of, type Db } from "./index";

// Виняток №2 (спека 0.4.d): функції над таблицями без власника. У Фазі 0 — серце cron (читання й запис).
export interface HeartbeatRow {
  last_run_at: number;
  last_ping_ok_at: number | null;
}

export async function readHeartbeat(db: Db, key: string): Promise<HeartbeatRow | null> {
  return d1Of(db)
    .prepare("SELECT last_run_at, last_ping_ok_at FROM heartbeat WHERE key = ?1")
    .bind(key)
    .first<HeartbeatRow>();
}

// Запис серця (0.3.a/b): upsert — два прогони в одну хвилину дають один рядок. `last_ping_ok_at` не чіпаємо.
export async function heartbeat(db: Db, key: string, now: number): Promise<void> {
  await d1Of(db)
    .prepare(
      "INSERT INTO heartbeat (key, last_run_at) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET last_run_at = excluded.last_run_at",
    )
    .bind(key, now)
    .run();
}

// Відмітка про успішний пінг монітора (0.3.a). Лише після того, як монітор відповів 2xx.
export async function markPingOk(db: Db, key: string, now: number): Promise<void> {
  await d1Of(db).prepare("UPDATE heartbeat SET last_ping_ok_at = ?2 WHERE key = ?1").bind(key, now).run();
}

// Форма /health стабільна: у Фазі 0 черги ще немає, Фаза 1 підставить реальне число.
export async function queueSize(_db: Db): Promise<number> {
  return 0;
}
