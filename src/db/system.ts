import { inQuietHours, minutesOfDay } from "../time";
import { CAPTURE_COLUMNS, LEASE_MS, type Capture } from "./captures";
import { LEASE_MS as REMINDER_LEASE_MS, type PlanItem } from "../reminders/plan";
import { d1Of, type Db } from "./index";
import { REMINDER_COLUMNS, type Reminder } from "./reminders";

// Виняток №2 (спека 0.4.d): функції над таблицями без власника: серце cron (Фаза 0), cron-підбір pending (S1.5),
// планувальник і оренда нагадувань (Фаза 2, НФ-3).
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

// ── Фаза 2: черга нагадувань (S2.1, S2.3) ───────────────────────────────────────────────────────────────

export interface UnplannedItem extends PlanItem {
  id: number;
  user_id: number;
  tz: string;
  morning_at: number;
}

// Вибірка планувальника по ВСІХ користувачах (S2.1): відкриті записи з датою, яких планувальник ще не опрацював.
// `ORDER BY id DESC`: нові записи першими — «мертві» старі не витісняють їх із LIMIT (2.1.i).
export async function listUnplannedItems(db: Db, limit: number): Promise<UnplannedItem[]> {
  const res = await d1Of(db)
    .prepare(
      `SELECT i.id AS id, i.user_id AS user_id, i.kind AS kind, i.due_at AS due_at, i.all_day AS all_day,
              i.priority AS priority, i.status AS status, i.travel_min AS travel_min, u.tz AS tz, u.morning_at AS morning_at
       FROM items i JOIN users u ON u.id = i.user_id
       WHERE i.status = 'open' AND i.due_at IS NOT NULL AND i.planned_at IS NULL
       ORDER BY i.id DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<UnplannedItem>();
  return res.results;
}

// Оренда рядків до відправки (S2.3 крок 3; «claim = sent» спека відкинула: збій між claim і відправкою губив би
// нагадування). ОДИН `UPDATE … RETURNING`: `pending` з `fire_at ≤ now`, чия оренда вільна, отримують
// `lease_until = now + LEASE_MS`; статус лишається `pending` — рядок закриває відправка (2.2). Оператор атомарний
// (D1 виконує запити до бази послідовно), тож два паралельні прогони не візьмуть той самий рядок
// (перевірено живцем на D1 preview — «Рішення» 2.1). `excludeUserIds` — користувачі в режимі тиші (S2.9).
export async function claimDueReminders(db: Db, now: number, limit: number, excludeUserIds: number[] = []): Promise<Reminder[]> {
  const res = await d1Of(db)
    .prepare(
      `UPDATE reminders SET lease_until = ?4
       WHERE id IN (SELECT id FROM reminders
                    WHERE status = 'pending' AND fire_at <= ?1 AND (lease_until IS NULL OR lease_until <= ?1)
                      AND user_id NOT IN (SELECT value FROM json_each(?3))
                    ORDER BY fire_at, id LIMIT ?2)
         AND status = 'pending' AND (lease_until IS NULL OR lease_until <= ?1)
       RETURNING ${REMINDER_COLUMNS}`,
    )
    .bind(now, limit, JSON.stringify(excludeUserIds), now + REMINDER_LEASE_MS)
    .all<Reminder>();
  return res.results.sort((a, b) => a.fire_at - b.fire_at || a.id - b.id);
}

// Старі рядки (S2.3 крок 0): `pending` з `fire_at` старшим за STALE_MS — мовчки `cancelled`, без повідомлень.
export async function cancelStaleReminders(db: Db, now: number, staleMs: number): Promise<number> {
  const res = await d1Of(db)
    .prepare("UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE status = 'pending' AND fire_at < ?1")
    .bind(now - staleMs)
    .run();
  return res.meta.changes ?? 0;
}

// Користувачі в режимі тиші (S2.9): пауза активна або локальна хвилина в тихих годинах. Їхніх рядків `claim` не бере.
export async function listQuietUserIds(db: Db, now: number): Promise<number[]> {
  const res = await d1Of(db)
    .prepare("SELECT id, tz, quiet_from, quiet_to, pause_until FROM users")
    .all<{ id: number; tz: string; quiet_from: number; quiet_to: number; pause_until: number | null }>();
  return res.results
    .filter((u) => (u.pause_until !== null && u.pause_until > now) || inQuietHours(u.quiet_from, u.quiet_to, minutesOfDay(now, u.tz)))
    .map((u) => u.id);
}

// Нерозіслані рядки (бюджет прогону вичерпано): оренда знімається, наступний тик їх підбере (S2.3 крок 5).
export async function releaseLeases(db: Db, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await d1Of(db)
    .prepare("UPDATE reminders SET lease_until = NULL WHERE status = 'pending' AND id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(ids))
    .run();
}

// `/health.reminders.due` (S2.3.g): скільки `pending` уже варто було відправити. Без персональних даних.
export async function countDueReminders(db: Db, now: number): Promise<number> {
  const row = await d1Of(db)
    .prepare("SELECT COUNT(*) AS n FROM reminders WHERE status = 'pending' AND fire_at <= ?1")
    .bind(now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ── Фаза 3: огляди (S3.1, НФ-3: виняток для вибірки по всіх користувачах) ───────────────────────────────────

export interface MissingDigest {
  user_id: number;
  kind: "digest_morning" | "digest_evening" | "digest_weekly";
  tz: string;
  morning_at: number;
  evening_at: number;
  weekly_dow: number;
  last_sent_fire_at: number | null; // `fire_at` останнього `sent` цього виду — для межі доби в `nextDigestAt`
}

// Користувачі, яким бракує `pending` огляду якогось виду (S3.1: ланцюг самовідновлюється). Один запит на тик; далі кожна
// дія — вже з `user_id` рядка. Ідемпотентність — `ux_rem_digest_pending`: паралельний прогін нічого не задвоїть.
export async function listUsersMissingDigests(db: Db): Promise<MissingDigest[]> {
  const res = await d1Of(db)
    .prepare(
      `SELECT u.id AS user_id, k.kind AS kind, u.tz AS tz, u.morning_at AS morning_at, u.evening_at AS evening_at, u.weekly_dow AS weekly_dow,
              (SELECT MAX(r.fire_at) FROM reminders r WHERE r.user_id = u.id AND r.kind = k.kind AND r.status IN ('sent','answered')) AS last_sent_fire_at
       FROM users u
       CROSS JOIN (SELECT 'digest_morning' AS kind UNION ALL SELECT 'digest_evening' UNION ALL SELECT 'digest_weekly') k
       WHERE NOT EXISTS (SELECT 1 FROM reminders r WHERE r.user_id = u.id AND r.kind = k.kind AND r.status = 'pending')
       ORDER BY u.id, k.kind`,
    )
    .all<MissingDigest>();
  return res.results;
}
