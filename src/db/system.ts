import { inQuietHours, minutesOfDay } from "../time";
import { CAPTURE_COLUMNS, LEASE_MS, type Capture } from "./captures";
import { d1Of, type Db } from "./index";

// Виняток №2 (спека 0.4.d): функції над таблицями без власника: серце cron (Фаза 0) і cron-підбір pending (S1.5).
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

// Скільки захоплень чекає на повтор (S1.5.h): `/health.queue.pending`. Лише `pending`: parsed і gave_up не рахуються.
export async function countPending(db: Db): Promise<number> {
  const row = await d1Of(db).prepare("SELECT COUNT(*) AS n FROM captures WHERE status = 'pending'").first<{ n: number }>();
  return row?.n ?? 0;
}

const CANDIDATES = 50; // скільки найстаріших «прострочених» дивимось за раз: частину може відсіяти режим тиші

// Cron-підбір pending по ВСІХ користувачах (S1.5.c; виняток із `userId`, як `heartbeat`): далі кожна дія над знайденим
// захопленням іде з його `user_id`. «Оренда»: `UPDATE … WHERE next_try_at ≤ now` змінює рівно один рядок, тож два
// паралельні прогони не візьмуть те саме захоплення; процес помер — після оренди (120 с) воно підбереться знову.
// Режим тиші (S1.5.e): `pause_until > now` чи `now` у вікні тихих годин — захоплення не чіпаємо, спроба не витрачається.
export async function claimDuePendingCaptures(db: Db, now: number, limit: number): Promise<Capture[]> {
  const d1 = d1Of(db);
  const due = await d1
    .prepare(
      `SELECT c.id AS id, u.tz AS tz, u.quiet_from AS quiet_from, u.quiet_to AS quiet_to, u.pause_until AS pause_until
       FROM captures c JOIN users u ON u.id = c.user_id
       WHERE c.status = 'pending' AND c.next_try_at IS NOT NULL AND c.next_try_at <= ?1
       ORDER BY c.next_try_at, c.id LIMIT ?2`,
    )
    .bind(now, CANDIDATES)
    .all<{ id: number; tz: string; quiet_from: number; quiet_to: number; pause_until: number | null }>();
  const claimed: Capture[] = [];
  for (const c of due.results) {
    if (claimed.length >= limit) break;
    if (c.pause_until !== null && c.pause_until > now) continue;
    if (inQuietHours(c.quiet_from, c.quiet_to, minutesOfDay(now, c.tz))) continue;
    const row = await d1
      .prepare(
        `UPDATE captures SET next_try_at = ?2
         WHERE id = ?1 AND status = 'pending' AND next_try_at IS NOT NULL AND next_try_at <= ?3
         RETURNING ${CAPTURE_COLUMNS}`,
      )
      .bind(c.id, now + LEASE_MS, now)
      .first<Capture>();
    if (row !== null) claimed.push(row);
  }
  return claimed;
}
