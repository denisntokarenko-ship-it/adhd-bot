// Черга нагадувань (docs/spec/phase-2.md, S2.1). Кожна функція — з `userId` першим (НФ-3); cron-вибірки без
// власника (`claimDueReminders`, `listUnplannedItems`) живуть у `system.ts` — закритий список винятків.
import type { PlannedRow, RootKind } from "../reminders/plan";
import { d1Of, type Db } from "./index";

export type ReminderKind = RootKind | "repeat" | "timer" | "digest_morning" | "digest_evening" | "digest_weekly";
export type ReminderStatus = "pending" | "sent" | "answered" | "cancelled";

export interface Reminder {
  id: number;
  user_id: number;
  item_id: number | null;
  kind: ReminderKind;
  fire_at: number;
  attempt: number;
  max_attempts: number;
  status: ReminderStatus;
  parent_id: number | null;
  root_id: number | null;
  lease_until: number | null;
  sent_at: number | null;
  sent_as: "single" | "summary" | null;
  tg_message_id: number | null;
  variant_idx: number | null;
  created_at: number;
}

export const REMINDER_COLUMNS =
  "id, user_id, item_id, kind, fire_at, attempt, max_attempts, status, parent_id, root_id, lease_until, sent_at, sent_as, tg_message_id, variant_idx, created_at";

// Корінь ланцюга з `INSERT … SELECT` із власного відкритого запису: чужий чи закритий `item_id` → 0 рядків.
// Ідемпотентність тримає БД (`ux_rem_root`), а не `if` у коді: дубль (item, kind, fire_at) мовчки не вставляється.
// `newKindOnly` — правило планувальника: корінь цього kind для запису ще не існує (у будь-якому статусі), 2.1.j.
function rootInsert(userId: number, db: Db, itemId: number, row: PlannedRow, now: number, newKindOnly: boolean) {
  const guard = newKindOnly
    ? "AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.item_id = i.id AND r.kind = ?3 AND r.parent_id IS NULL)"
    : "";
  return d1Of(db)
    .prepare(
      `INSERT INTO reminders (user_id, item_id, kind, fire_at, attempt, max_attempts, created_at)
       SELECT i.user_id, i.id, ?3, ?4, 1, ?5, ?6 FROM items i
       WHERE i.id = ?2 AND i.user_id = ?1 AND i.status = 'open' ${guard}
       ON CONFLICT DO NOTHING`,
    )
    .bind(userId, itemId, row.kind, row.fireAt, row.maxAttempts, now);
}

// Поставити корені в чергу (для ⏰, відповіді про дорогу — кроки 2.2–2.3). Повертає, скільки рядків реально додано.
export async function schedule(userId: number, db: Db, itemId: number, rows: PlannedRow[], now: number): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await d1Of(db).batch(rows.map((r) => rootInsert(userId, db, itemId, r, now, false)));
  return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

// Тик планувальника для одного запису: корені нових kind + `planned_at` одним batch — навіть коли рядків 0
// (мить позаду): опрацьований запис більше не повертається з вибірки й не витісняє нових (S2.1.i, рев'ю 2.0 Б1).
export async function planItem(userId: number, db: Db, itemId: number, rows: PlannedRow[], now: number): Promise<number> {
  const d1 = d1Of(db);
  const res = await d1.batch([
    ...rows.map((r) => rootInsert(userId, db, itemId, r, now, true)),
    d1.prepare("UPDATE items SET planned_at = ?3 WHERE id = ?2 AND user_id = ?1 AND planned_at IS NULL").bind(userId, itemId, now),
  ]);
  return res.slice(0, rows.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

// Відповідь на запис: усі ще не відправлені рядки запису → cancelled (оренда знімається). Відправлені не чіпає.
export async function answer(userId: number, db: Db, itemId: number): Promise<number> {
  const res = await d1Of(db)
    .prepare(
      "UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE user_id = ?1 AND item_id = ?2 AND status = 'pending'",
    )
    .bind(userId, itemId)
    .run();
  return res.meta.changes ?? 0;
}

export async function listForItem(userId: number, db: Db, itemId: number): Promise<Reminder[]> {
  const res = await d1Of(db)
    .prepare(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE user_id = ?1 AND item_id = ?2 ORDER BY fire_at, id`)
    .bind(userId, itemId)
    .all<Reminder>();
  return res.results;
}
