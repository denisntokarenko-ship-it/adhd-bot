import type { Db } from "./index";

// Виняток №2 (спека 0.4.d): функції над таблицями без власника. У Фазі 0 — читання серця cron.
// Запис серця (`heartbeat`) додає крок 0.5.
export interface HeartbeatRow {
  last_run_at: number;
  last_ping_ok_at: number | null;
}

export async function readHeartbeat(db: Db, key: string): Promise<HeartbeatRow | null> {
  return db.d1
    .prepare("SELECT last_run_at, last_ping_ok_at FROM heartbeat WHERE key = ?1")
    .bind(key)
    .first<HeartbeatRow>();
}

// Форма /health стабільна: у Фазі 0 черги ще немає, Фаза 1 підставить реальне число.
export async function queueSize(_db: Db): Promise<number> {
  return 0;
}
