// Рутини: ліки й звички (docs/spec/phase-4.md, S4.1, S4.4–S4.7). НФ-3: кожна функція бере `userId` першим і
// кожен запит має `WHERE user_id = ?`; чужий `routine_id` нічого не читає й не змінює (4.1.d).
// Дані звідси НІКОЛИ не йдуть у промпт ШІ (правило 4 CLAUDE.md, НФ-2): `src/ai/**` цей модуль не імпортує (тест-межа).
import { LATE_MS } from "../reminders/plan";
import { maxAttemptsFor, nextRoutineSlot, ROUTINES_MAX, validTitle, WIZARD_TTL_MS, type RoutineKind } from "../routines/schedule";
import { d1Of, type Db } from "./index";
import { routineDoneStatement } from "./points";
import type { Reminder } from "./reminders";

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

// Створення й зміна рутини — ЛИШЕ через чернетку майстра (рев'ю R-4, В3: другої реалізації немає):
// нова — `startDraft` → … → `saveDraft` (ліміт `ROUTINES_MAX` у тому ж операторі); назва — `takeTitleInput`;
// час і дні — `saveDraft` з `routine_id`. Часи й дні приходять лише кнопками (`normalizeTimes`, regex `RW_RE`
// у handler), назва — через `checkedTitle`; CHECK `0006` — друга лінія.

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

// ▶️ (S4.7.d): `active = 1` і в тому ж batch корінь найближчого слота `≥ now` — не `≥ now − LATE_MS`, як у тику:
// слот, що минув під час паузи (навіть щойно), не нагадується; планувальник бачить корінь і його не чіпає.
export async function resumeRoutine(userId: number, db: Db, routineId: number, now: number): Promise<boolean> {
  const d1 = d1Of(db);
  const r = await d1
    .prepare("SELECT r.times AS times, r.days_mask AS days_mask, u.tz AS tz FROM routines r JOIN users u ON u.id = r.user_id WHERE r.id = ?2 AND r.user_id = ?1")
    .bind(userId, routineId)
    .first<{ times: string; days_mask: number; tz: string }>();
  if (r === null) return false;
  const slot = nextRoutineSlot({ times: JSON.parse(r.times) as string[], days_mask: r.days_mask }, r.tz, now + LATE_MS);
  const [upd] = await d1.batch([
    d1.prepare("UPDATE routines SET active = 1, updated_at = ?3 WHERE id = ?2 AND user_id = ?1").bind(userId, routineId, now),
    rootStatement(userId, db, routineId, slot, now),
  ]);
  return (upd!.meta.changes ?? 0) === 1;
}

// `missed` (S4.6, cron) — лише новий рядок; наявний (і `missed`, і відповідь) не змінює: тримає
// `UNIQUE(routine_id, scheduled_for)`, а не `if`. Відповідь кнопкою (`taken`/`skipped`, і `missed` → відповідь,
// 4.6.b) — лише `answerSlot` (рев'ю R-4, В3: другої реалізації немає). `null` — рядок уже був або рутина чужа.
export async function logMissed(userId: number, db: Db, routineId: number, scheduledFor: number, now: number): Promise<number | null> {
  const row = await d1Of(db)
    .prepare(
      `INSERT INTO routine_logs (user_id, routine_id, scheduled_for, status, answered_at, created_at)
       SELECT ?1, id, ?3, 'missed', NULL, ?4 FROM routines WHERE id = ?2 AND user_id = ?1
       ON CONFLICT (routine_id, scheduled_for) DO NOTHING
       RETURNING id`,
    )
    .bind(userId, routineId, scheduledFor, now)
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
  const res = await rootStatement(userId, db, routineId, slotAt, now).run();
  return (res.meta.changes ?? 0) === 1;
}

function rootStatement(userId: number, db: Db, routineId: number, slotAt: number, now: number): D1PreparedStatement {
  return d1Of(db)
    .prepare(
      `INSERT INTO reminders (user_id, kind, fire_at, attempt, max_attempts, status, created_at, routine_id, slot_at)
       SELECT ?1, 'routine', ?3, 1, CASE WHEN escalate = 1 THEN ?5 ELSE ?6 END, 'pending', ?4, id, ?3
       FROM routines
       WHERE id = ?2 AND user_id = ?1 AND active = 1
         AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.user_id = ?1 AND r.routine_id = ?2 AND r.slot_at = ?3 AND r.parent_id IS NULL)
       ON CONFLICT DO NOTHING`,
    )
    .bind(userId, routineId, slotAt, now, maxAttemptsFor(true), maxAttemptsFor(false));
}

// Зміна поясу (4.7.e): у ТОМУ Ж batch, що й `UPDATE users SET tz`, — невідправлені корені рутин `DELETE` і нові корені
// найближчого слота за НОВИМ `tz` (як корені записів у S3.8; `DELETE` замість `cancelled` — S4.4).
export async function retimeRootsStatements(userId: number, db: Db, newTz: string, now: number): Promise<D1PreparedStatement[]> {
  const d1 = d1Of(db);
  const res = await d1
    .prepare("SELECT id, times, days_mask FROM routines WHERE user_id = ?1 AND active = 1 ORDER BY id")
    .bind(userId)
    .all<{ id: number; times: string; days_mask: number }>();
  return res.results.flatMap((r) => [
    d1.prepare(DELETE_UNSENT_ROOTS).bind(userId, r.id),
    rootStatement(userId, db, r.id, nextRoutineSlot({ times: JSON.parse(r.times) as string[], days_mask: r.days_mask }, newTz, now), now),
  ]);
}

export async function countRoutines(userId: number, db: Db): Promise<number> {
  const row = await d1Of(db).prepare("SELECT COUNT(*) AS n FROM routines WHERE user_id = ?1").bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

// ── Чернетка майстра (S4.2, S4.3, S4.7; Р4.2) ────────────────────────────────────────────────────────────────

export type DraftStep = "kind" | "title" | "times" | "days" | "confirm";

export interface Draft {
  routine_id: number | null; // не NULL — редагування наявної рутини (S4.7)
  step: DraftStep;
  kind: RoutineKind | null;
  title: string | null;
  times: string[];
  days_mask: number | null;
  expires_at: number;
}

interface DraftRow extends Omit<Draft, "times"> {
  times: string | null;
}
const DRAFT_COLUMNS = "routine_id, step, kind, title, times, days_mask, expires_at";
const toDraft = (r: DraftRow): Draft => ({ ...r, times: r.times === null ? [] : (JSON.parse(r.times) as string[]) });

// Чернетка людини, жива чи ні: мертва відрізняє «майстер закрився» від «уже збережено» (4.2.f–g).
export async function getDraft(userId: number, db: Db): Promise<Draft | null> {
  const row = await d1Of(db).prepare(`SELECT ${DRAFT_COLUMNS} FROM routine_drafts WHERE user_id = ?1`).bind(userId).first<DraftRow>();
  return row === null ? null : toDraft(row);
}

// Жива — `expires_at > now` (4.3.d: о `expires_at − 1 с` жива, о `expires_at + 1 с` — ні).
export async function getLiveDraft(userId: number, db: Db, now: number): Promise<Draft | null> {
  const d = await getDraft(userId, db);
  return d !== null && d.expires_at > now ? d : null;
}

export interface NewDraft {
  routineId: number | null;
  step: DraftStep;
  kind: RoutineKind;
  title: string | null;
  times: readonly string[];
  daysMask: number | null;
}

// Нова чернетка (одна на користувача — друга замінює першу, 4.2.a). Крок `title` скидає відкрите вікно «Не так»
// (4.3.f: виграє останній намір) — тим самим batch. Редагування — лише своєї рутини.
export async function startDraft(userId: number, db: Db, d: NewDraft, now: number): Promise<boolean> {
  const d1 = d1Of(db);
  const stmts = [
    d1
      .prepare(
        `INSERT INTO routine_drafts (user_id, routine_id, step, kind, title, times, days_mask, expires_at, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
         WHERE ?2 IS NULL OR EXISTS (SELECT 1 FROM routines WHERE id = ?2 AND user_id = ?1)
         ON CONFLICT (user_id) DO UPDATE SET routine_id = excluded.routine_id, step = excluded.step, kind = excluded.kind,
           title = excluded.title, times = excluded.times, days_mask = excluded.days_mask, expires_at = excluded.expires_at,
           created_at = excluded.created_at`,
      )
      .bind(userId, d.routineId, d.step, d.kind, d.title, JSON.stringify(d.times), d.daysMask, now + WIZARD_TTL_MS, now),
  ];
  if (d.step === "title") stmts.push(d1.prepare("UPDATE captures SET fix_requested_at = NULL WHERE user_id = ?1 AND fix_requested_at IS NOT NULL").bind(userId));
  const [ins] = await d1.batch(stmts);
  return (ins!.meta.changes ?? 0) === 1;
}

export interface DraftPatch {
  step?: DraftStep;
  times?: readonly string[];
  daysMask?: number;
}

// Крок майстра кнопкою: лише жива чернетка на очікуваному кроці; кожна кнопка продовжує `expires_at` (S4.2).
// `null` — чернетки немає, вона мертва чи вже на іншому кроці (подвійний тап, стара кнопка).
export async function patchDraft(userId: number, db: Db, expectStep: DraftStep, patch: DraftPatch, now: number): Promise<Draft | null> {
  const row = await d1Of(db)
    .prepare(
      `UPDATE routine_drafts SET step = COALESCE(?4, step), times = COALESCE(?5, times), days_mask = COALESCE(?6, days_mask), expires_at = ?7
       WHERE user_id = ?1 AND step = ?2 AND expires_at > ?3
       RETURNING ${DRAFT_COLUMNS}`,
    )
    .bind(userId, expectStep, now, patch.step ?? null, patch.times === undefined ? null : JSON.stringify(patch.times), patch.daysMask ?? null, now + WIZARD_TTL_MS)
    .first<DraftRow>();
  return row === null ? null : toDraft(row);
}

// ✖ (4.2.g) і «Не так» (4.3.f): `true` — жива чернетка була й видалена. Мертву теж прибираємо (без наслідків).
export async function deleteDraft(userId: number, db: Db, now: number): Promise<boolean> {
  const row = await d1Of(db).prepare("DELETE FROM routine_drafts WHERE user_id = ?1 RETURNING expires_at").bind(userId).first<{ expires_at: number }>();
  return row !== null && row.expires_at > now;
}

// Повідомлення, яке забрав крок `title` (4.3.a): ОДИН batch — `routine_inputs` + (назву прийнято) зміна чернетки, а при
// редагуванні (S4.7.b) — `UPDATE routines.title` і кінець чернетки. Повтор доставки того самого `update_id` нічого не
// змінює: зміни прив'язані до рядка `routine_inputs`, створеного саме цією миттю. `true` — update забрано вперше.
export async function takeTitleInput(userId: number, db: Db, tgUpdateId: number, title: string | null, now: number): Promise<boolean> {
  const d1 = d1Of(db);
  const fresh = "EXISTS (SELECT 1 FROM routine_inputs i WHERE i.user_id = ?1 AND i.tg_update_id = ?2 AND i.created_at = ?3)";
  const live = "user_id = ?1 AND step = 'title' AND expires_at > ?3";
  const stmts = [d1.prepare("INSERT INTO routine_inputs (user_id, tg_update_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING").bind(userId, tgUpdateId, now)];
  if (title !== null) {
    const t = checkedTitle(title);
    stmts.push(
      d1
        .prepare(`UPDATE routines SET title = ?4, updated_at = ?3 WHERE user_id = ?1 AND id = (SELECT routine_id FROM routine_drafts WHERE ${live}) AND ${fresh}`)
        .bind(userId, tgUpdateId, now, t),
      d1.prepare(`DELETE FROM routine_drafts WHERE ${live} AND routine_id IS NOT NULL AND ${fresh}`).bind(userId, tgUpdateId, now),
      d1
        .prepare(`UPDATE routine_drafts SET title = ?4, step = 'times', times = '[]', expires_at = ?5 WHERE ${live} AND routine_id IS NULL AND ${fresh}`)
        .bind(userId, tgUpdateId, now, t, now + WIZARD_TTL_MS),
    );
  }
  const [ins] = await d1.batch(stmts);
  return (ins!.meta.changes ?? 0) === 1;
}

export type SaveOutcome = { kind: "created" | "updated"; id: number } | { kind: "limit" } | { kind: "none" };

// «✅ Зберегти» (4.2.f, 4.7.c) — один batch з живої чернетки на кроці `confirm`:
// - нова: `INSERT routines` (`escalate` = `kind='med'`, ліміт 20 у тому ж операторі) + `DELETE` чернетки;
// - редагування: `UPDATE routines` (час/дні з чернетки) + `DELETE` невідправлених коренів (S4.4) + `DELETE` чернетки.
// Подвійний тап: другий не знаходить чернетки → `none`.
export async function saveDraft(userId: number, db: Db, now: number): Promise<SaveOutcome> {
  const d1 = d1Of(db);
  const draft = await getLiveDraft(userId, db, now);
  if (draft === null || draft.step !== "confirm") return { kind: "none" };
  if (draft.routine_id === null) {
    const live = "d.user_id = ?1 AND d.step = 'confirm' AND d.expires_at > ?2 AND d.routine_id IS NULL";
    const [ins] = await d1.batch([
      d1
        .prepare(
          `INSERT INTO routines (user_id, kind, title, times, days_mask, escalate, active, created_at, updated_at)
           SELECT ?1, d.kind, d.title, d.times, d.days_mask, d.kind = 'med', 1, ?2, ?2 FROM routine_drafts d
           WHERE ${live} AND (SELECT COUNT(*) FROM routines WHERE user_id = ?1) < ?3
           RETURNING id`,
        )
        .bind(userId, now, ROUTINES_MAX),
      d1.prepare(`DELETE FROM routine_drafts AS d WHERE ${live}`).bind(userId, now),
    ]);
    const id = (ins!.results[0] as { id: number } | undefined)?.id;
    return id === undefined ? { kind: "limit" } : { kind: "created", id };
  }
  const live = "d.user_id = ?1 AND d.step = 'confirm' AND d.expires_at > ?3 AND d.routine_id = ?2";
  const [upd] = await d1.batch([
    d1
      .prepare(
        `UPDATE routines SET times = d.times, days_mask = d.days_mask, updated_at = ?3
         FROM routine_drafts d WHERE routines.id = ?2 AND routines.user_id = ?1 AND ${live}`,
      )
      .bind(userId, draft.routine_id, now),
    d1.prepare(`${DELETE_UNSENT_ROOTS} AND EXISTS (SELECT 1 FROM routine_drafts d WHERE ${live})`).bind(userId, draft.routine_id, now),
    d1.prepare(`DELETE FROM routine_drafts AS d WHERE ${live}`).bind(userId, draft.routine_id, now),
  ]);
  return (upd!.meta.changes ?? 0) === 1 ? { kind: "updated", id: draft.routine_id } : { kind: "none" };
}

// ── Відповідь на слот кнопкою (S4.5.b–f, 4.6.b) ────────────────────────────────────────────────────────────────

const ANSWERED_SLOT =
  "EXISTS (SELECT 1 FROM routine_logs g WHERE g.user_id = ?1 AND g.routine_id = ?2 AND g.scheduled_for = ?3 AND g.status IN ('taken','skipped'))";

// Слот уже має `taken`/`skipped` (назавжди): будь-яка кнопка — «уже записав» (4.5.f), рядок рутини не йде (4.5.g).
export async function slotAnswered(userId: number, db: Db, routineId: number, slotAt: number): Promise<boolean> {
  const row = await d1Of(db).prepare(`SELECT ${ANSWERED_SLOT} AS x`).bind(userId, routineId, slotAt).first<{ x: number }>();
  return row?.x === 1;
}

// «✅» / «пропущу» (4.5.b, 4.5.d, 4.6.b) — ОДИН batch: `routine_logs` (новий або `missed` → відповідь), `pending` слота →
// `cancelled`, натиснутий `sent` → `answered`, (✅) +10 з `routine_log_id`. Решта операторів спрацьовує, лише якщо
// відповідь записана саме цією миттю. `false` — слот уже мав відповідь (подвійний тап, друге повідомлення слота).
export async function answerSlot(
  userId: number,
  db: Db,
  pressedId: number,
  routineId: number,
  slotAt: number,
  status: "taken" | "skipped",
  now: number,
): Promise<boolean> {
  const d1 = d1Of(db);
  const mine = "EXISTS (SELECT 1 FROM routine_logs g WHERE g.user_id = ?1 AND g.routine_id = ?2 AND g.scheduled_for = ?3 AND g.status = ?4 AND g.answered_at = ?5)";
  const stmts = [
    d1
      .prepare(
        `INSERT INTO routine_logs (user_id, routine_id, scheduled_for, status, answered_at, created_at)
         SELECT ?1, id, ?3, ?4, ?5, ?5 FROM routines WHERE id = ?2 AND user_id = ?1
         ON CONFLICT (routine_id, scheduled_for) DO UPDATE SET status = excluded.status, answered_at = excluded.answered_at
           WHERE routine_logs.status = 'missed'
         RETURNING id`,
      )
      .bind(userId, routineId, slotAt, status, now),
    d1
      .prepare(`UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE user_id = ?1 AND routine_id = ?2 AND slot_at = ?3 AND status = 'pending' AND ${mine}`)
      .bind(userId, routineId, slotAt, status, now),
    d1
      .prepare(`UPDATE reminders SET status = 'answered', lease_until = NULL WHERE id = ?6 AND user_id = ?1 AND status = 'sent' AND ${mine}`)
      .bind(userId, routineId, slotAt, status, now, pressedId),
  ];
  if (status === "taken") stmts.push(routineDoneStatement(userId, db, routineId, slotAt, now));
  const [log] = await d1.batch(stmts);
  return log!.results.length > 0;
}

export type SnoozeSlotOutcome = "snoozed" | "answered" | "gone";

// «+15 хв» (4.5.e) — ОДИН batch: `pending` слота → `cancelled`, новий корінь того ж `slot_at` з `fire_at` і `attempt = 1`,
// натиснутий `sent` → `answered`. Усе — лише поки натиснутий рядок `sent` і слот без відповіді: подвійний тап не
// множить корені й не скасовує щойно відкладений. `answered` — слот уже записано; `gone` — повідомлення вже відпрацьоване.
export async function snoozeSlot(
  userId: number,
  db: Db,
  pressedId: number,
  routineId: number,
  slotAt: number,
  fireAt: number,
  now: number,
): Promise<SnoozeSlotOutcome> {
  if (await slotAnswered(userId, db, routineId, slotAt)) return "answered";
  const d1 = d1Of(db);
  const guard = `EXISTS (SELECT 1 FROM reminders p WHERE p.id = ?4 AND p.user_id = ?1 AND p.status = 'sent') AND NOT ${ANSWERED_SLOT}`;
  const res = await d1.batch([
    d1
      .prepare(`UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE user_id = ?1 AND routine_id = ?2 AND slot_at = ?3 AND status = 'pending' AND ${guard}`)
      .bind(userId, routineId, slotAt, pressedId),
    d1
      .prepare(
        `INSERT INTO reminders (user_id, kind, fire_at, attempt, max_attempts, status, created_at, routine_id, slot_at)
         SELECT ?1, 'routine', ?5, 1, CASE WHEN escalate = 1 THEN ?7 ELSE ?8 END, 'pending', ?6, id, ?3
         FROM routines WHERE id = ?2 AND user_id = ?1 AND ${guard}
         ON CONFLICT DO NOTHING`,
      )
      .bind(userId, routineId, slotAt, pressedId, fireAt, now, maxAttemptsFor(true), maxAttemptsFor(false)),
    d1
      .prepare(`UPDATE reminders SET status = 'answered', lease_until = NULL WHERE id = ?4 AND user_id = ?1 AND status = 'sent' AND NOT ${ANSWERED_SLOT}`)
      .bind(userId, routineId, slotAt, pressedId),
  ]);
  return (res[2]!.meta.changes ?? 0) === 1 ? "snoozed" : "gone";
}

// ── Відправка рядка рутини (S4.5) ────────────────────────────────────────────────────────────────────────────

// Варіант тексту останньої відправки рутини цього користувача: окремо корені й повтори (НФ-4, пам'ять у БД).
export async function lastRoutineVariantIdx(userId: number, db: Db, repeat: boolean): Promise<number | null> {
  const row = await d1Of(db)
    .prepare(
      `SELECT variant_idx FROM reminders
       WHERE user_id = ?1 AND routine_id IS NOT NULL AND sent_at IS NOT NULL AND variant_idx IS NOT NULL AND (attempt > 1) = ?2
       ORDER BY sent_at DESC, id DESC LIMIT 1`,
    )
    .bind(userId, repeat ? 1 : 0)
    .first<{ variant_idx: number }>();
  return row?.variant_idx ?? null;
}

// Закриття ПІСЛЯ відправки (S2.3.b) і повтор ланцюга (`med`: 5→15→30 від фактичного `sent_at`) — один batch.
// Повтор — лише поки рутина `active` і слот без відповіді. `false` — рядок закрив хтось раніше (повідомлення прибрати).
export async function closeRoutineSent(
  userId: number,
  db: Db,
  r: Reminder,
  f: { sentAt: number; tgMessageId: number; variantIdx: number },
  next: { attempt: number; fireAt: number } | null,
  now: number,
): Promise<boolean> {
  const d1 = d1Of(db);
  const stmts = [
    d1
      .prepare(
        `UPDATE reminders SET status = 'sent', sent_at = ?3, sent_as = 'single', tg_message_id = ?4, variant_idx = ?5, lease_until = NULL
         WHERE id = ?1 AND user_id = ?2 AND status = 'pending'`,
      )
      .bind(r.id, userId, f.sentAt, f.tgMessageId, f.variantIdx),
  ];
  if (next !== null) {
    stmts.push(
      d1
        .prepare(
          `INSERT INTO reminders (user_id, kind, fire_at, attempt, max_attempts, parent_id, root_id, created_at, routine_id, slot_at)
           SELECT r.user_id, 'repeat', ?3, ?4, r.max_attempts, r.id, COALESCE(r.root_id, r.id), ?5, r.routine_id, r.slot_at
           FROM reminders r JOIN routines t ON t.id = r.routine_id AND t.user_id = r.user_id
           WHERE r.id = ?1 AND r.user_id = ?2 AND r.status = 'sent' AND t.active = 1
             AND NOT EXISTS (SELECT 1 FROM routine_logs g WHERE g.user_id = r.user_id AND g.routine_id = r.routine_id
                               AND g.scheduled_for = r.slot_at AND g.status IN ('taken','skipped'))
           ON CONFLICT DO NOTHING`,
        )
        .bind(r.id, userId, next.fireAt, next.attempt, now),
    );
  }
  const [upd] = await d1.batch(stmts);
  return (upd!.meta.changes ?? 0) === 1;
}
