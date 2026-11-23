// Рутини: ліки й звички (docs/spec/phase-4.md, S4.1, S4.4–S4.7). НФ-3: кожна функція бере `userId` першим і
// кожен запит має `WHERE user_id = ?`; чужий `routine_id` нічого не читає й не змінює (4.1.d).
// Дані звідси НІКОЛИ не йдуть у промпт ШІ (правило 4 CLAUDE.md, НФ-2): `src/ai/**` цей модуль не імпортує (тест-межа).
import { maxAttemptsFor, normalizeTimes, ROUTINES_MAX, validDaysMask, validTitle, type RoutineKind } from "../routines/schedule";
import { d1Of, type Db } from "./index";

export interface Routine {
  id: number;
  user_id: number;
  kind: RoutineKind;
  title: string;
  times: string[];
  days_mask: number;
  escalate: boolean;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export type RoutineAnswer = "taken" | "skipped" | "missed";

interface RoutineRow extends Omit<Routine, "times" | "escalate" | "active"> {
  times: string;
  escalate: number;
  active: number;
}

const COLUMNS = "id, user_id, kind, title, times, days_mask, escalate, active, created_at, updated_at";
const toRoutine = (r: RoutineRow): Routine => ({ ...r, times: JSON.parse(r.times) as string[], escalate: r.escalate === 1, active: r.active === 1 });

function checkedTitle(title: string): string {
  if (!validTitle(title)) throw new RangeError("routine title: 1..64 chars, one line");
  return title;
}
function checkedTimes(times: readonly string[]): string {
  const t = normalizeTimes(times);
  if (t === null) throw new RangeError("routine times: 1..6 × HH:MM");
  return JSON.stringify(t);
}
function checkedMask(mask: number): number {
  if (!validDaysMask(mask)) throw new RangeError("routine days_mask: 1..127");
  return mask;
}

export interface NewRoutine {
  kind: RoutineKind;
  title: string;
  times: readonly string[];
  daysMask: number;
  escalate?: boolean; // за замовчуванням — `kind = 'med'` (S4.2.f)
}

// Нова рутина (4.2.f). Ліміт `ROUTINES_MAX` — у тому ж операторі (а не окремим COUNT), тож два паралельні збереження
// не перескочать 20. `null` — ліміт вичерпано.
export async function createRoutine(userId: number, db: Db, r: NewRoutine, now: number): Promise<number | null> {
  const row = await d1Of(db)
    .prepare(
      `INSERT INTO routines (user_id, kind, title, times, days_mask, escalate, active, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7
       WHERE (SELECT COUNT(*) FROM routines WHERE user_id = ?1) < ?8
       RETURNING id`,
    )
    .bind(userId, r.kind, checkedTitle(r.title), checkedTimes(r.times), checkedMask(r.daysMask), (r.escalate ?? r.kind === "med") ? 1 : 0, now, ROUTINES_MAX)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function getRoutine(userId: number, db: Db, routineId: number): Promise<Routine | null> {
  const row = await d1Of(db).prepare(`SELECT ${COLUMNS} FROM routines WHERE id = ?1 AND user_id = ?2`).bind(routineId, userId).first<RoutineRow>();
  return row === null ? null : toRoutine(row);
}

// Список `/routines` (S4.7.a): усі рутини людини, і на паузі теж.
export async function listRoutines(userId: number, db: Db): Promise<Routine[]> {
  const res = await d1Of(db).prepare(`SELECT ${COLUMNS} FROM routines WHERE user_id = ?1 ORDER BY id`).bind(userId).all<RoutineRow>();
  return res.results.map(toRoutine);
}

// Невідправлені корені рутини (S4.4): `pending`-корінь слота, у якого ще немає жодної відправки. На них нічого не
// посилається (немає `sent`, нащадків, `tg_message_id`) — тому `DELETE`, а не `cancelled`: слот, що лишився в розкладі,
// наступний тик планує знову. Ланцюг, що вже йде (у слоті є `sent`), — не чіпається.
const DELETE_UNSENT_ROOTS = `DELETE FROM reminders
  WHERE user_id = ?1 AND routine_id = ?2 AND kind = 'routine' AND parent_id IS NULL AND status = 'pending'
    AND NOT EXISTS (SELECT 1 FROM reminders s WHERE s.user_id = ?1 AND s.routine_id = reminders.routine_id
                      AND s.slot_at = reminders.slot_at AND s.sent_at IS NOT NULL)`;

export interface RoutinePatch {
  title?: string;
  times?: readonly string[];
  daysMask?: number;
}

// Зміна назви / часу / днів (S4.7.b–c) одним batch. Час чи дні змінились → невідправлені корені `DELETE` (S4.4).
// `false` — рутини немає або вона чужа (нічого не змінено).
export async function updateRoutine(userId: number, db: Db, routineId: number, patch: RoutinePatch, now: number): Promise<boolean> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.title !== undefined) (sets.push(`title = ?${args.length + 4}`), args.push(checkedTitle(patch.title)));
  if (patch.times !== undefined) (sets.push(`times = ?${args.length + 4}`), args.push(checkedTimes(patch.times)));
  if (patch.daysMask !== undefined) (sets.push(`days_mask = ?${args.length + 4}`), args.push(checkedMask(patch.daysMask)));
  if (sets.length === 0) return (await getRoutine(userId, db, routineId)) !== null;
  const d1 = d1Of(db);
  const stmts = [
    d1.prepare(`UPDATE routines SET ${sets.join(", ")}, updated_at = ?3 WHERE id = ?2 AND user_id = ?1`).bind(userId, routineId, now, ...args),
  ];
  if (patch.times !== undefined || patch.daysMask !== undefined) stmts.push(d1.prepare(DELETE_UNSENT_ROOTS).bind(userId, routineId));
  const [upd] = await d1.batch(stmts);
  return (upd!.meta.changes ?? 0) === 1;
}

// ⏸ Пауза (S4.7.d): `active = 0`, невідправлені корені → `DELETE`, решта `pending` слота (повтори, «+15 хв» уже
// розпочатого ланцюга) → `cancelled`. Одним batch. `false` — рутини немає або вона чужа.
export async function pauseRoutine(userId: number, db: Db, routineId: number, now: number): Promise<boolean> {
  const d1 = d1Of(db);
  const [upd] = await d1.batch([
    d1.prepare("UPDATE routines SET active = 0, updated_at = ?3 WHERE id = ?2 AND user_id = ?1").bind(userId, routineId, now),
    d1.prepare(DELETE_UNSENT_ROOTS).bind(userId, routineId),
    d1.prepare("UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE user_id = ?1 AND routine_id = ?2 AND status = 'pending'").bind(userId, routineId),
  ]);
  return (upd!.meta.changes ?? 0) === 1;
}

// ▶️ (S4.7.d): `active = 1`; найближчий слот планує наступний тик (S4.4).
export async function resumeRoutine(userId: number, db: Db, routineId: number, now: number): Promise<boolean> {
  const res = await d1Of(db).prepare("UPDATE routines SET active = 1, updated_at = ?3 WHERE id = ?2 AND user_id = ?1").bind(userId, routineId, now).run();
  return (res.meta.changes ?? 0) === 1;
}

// Відповідь на слот (S4.5, S4.6) — ідемпотентно, тримає `UNIQUE(routine_id, scheduled_for)`, а не `if`:
// - `taken` / `skipped`: новий рядок, або `missed` → відповідь (4.6.b, `answered_at = now`); `taken`/`skipped` — назавжди;
// - `missed` (cron): лише новий рядок, наявний не змінює (`answered_at NULL`).
// Повертає id рядка, якщо його створено чи змінено цим викликом; `null` — слот уже мав відповідь або рутина чужа.
export async function logAnswer(userId: number, db: Db, routineId: number, scheduledFor: number, status: RoutineAnswer, now: number): Promise<number | null> {
  const row = await d1Of(db)
    .prepare(
      `INSERT INTO routine_logs (user_id, routine_id, scheduled_for, status, answered_at, created_at)
       SELECT ?1, id, ?3, ?4, ?5, ?6 FROM routines WHERE id = ?2 AND user_id = ?1
       ON CONFLICT (routine_id, scheduled_for) DO UPDATE SET status = excluded.status, answered_at = excluded.answered_at
         WHERE routine_logs.status = 'missed' AND excluded.status <> 'missed'
       RETURNING id`,
    )
    .bind(userId, routineId, scheduledFor, status, status === "missed" ? null : now, now)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export interface RoutineLog {
  id: number;
  routine_id: number;
  scheduled_for: number;
  status: RoutineAnswer;
  answered_at: number | null;
}

// Журнал слотів за `[from, to)` за `scheduled_for` (огляди S4.8–S4.9: доба — за слотом, не за відповіддю, 4.9.d).
export async function listLogs(userId: number, db: Db, from: number, to: number): Promise<RoutineLog[]> {
  const res = await d1Of(db)
    .prepare("SELECT id, routine_id, scheduled_for, status, answered_at FROM routine_logs WHERE user_id = ?1 AND scheduled_for >= ?2 AND scheduled_for < ?3 ORDER BY scheduled_for, id")
    .bind(userId, from, to)
    .all<RoutineLog>();
  return res.results;
}

// Корінь слота (S4.4): `fire_at = slot_at`, `attempt = 1`, `max_attempts` — 4 для `escalate`, інакше 1.
// Лише якщо рутина своя й `active` і для `(routine_id, slot_at)` ще немає ЖОДНОГО кореня — і `cancelled` теж
// (4.5.g, 4.5.k: інакше відмова Telegram давала б новий корінь щотику). Два одночасні тики тримає
// `ux_rem_routine_pending` (ON CONFLICT DO NOTHING). `true` — корінь створено.
export async function insertRoutineRoot(userId: number, db: Db, routineId: number, slotAt: number, now: number): Promise<boolean> {
  const res = await d1Of(db)
    .prepare(
      `INSERT INTO reminders (user_id, kind, fire_at, attempt, max_attempts, status, created_at, routine_id, slot_at)
       SELECT ?1, 'routine', ?3, 1, CASE WHEN escalate = 1 THEN ?5 ELSE ?6 END, 'pending', ?4, id, ?3
       FROM routines
       WHERE id = ?2 AND user_id = ?1 AND active = 1
         AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.user_id = ?1 AND r.routine_id = ?2 AND r.slot_at = ?3 AND r.parent_id IS NULL)
       ON CONFLICT DO NOTHING`,
    )
    .bind(userId, routineId, slotAt, now, maxAttemptsFor(true), maxAttemptsFor(false))
    .run();
  return (res.meta.changes ?? 0) === 1;
}
