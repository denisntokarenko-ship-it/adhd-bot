// Черга нагадувань (docs/spec/phase-2.md, S2.1). Кожна функція — з `userId` першим (НФ-3); cron-вибірки без
// власника (`claimDueReminders`, `listUnplannedItems`) живуть у `system.ts` — закритий список винятків.
import { HOUR_MS, MAX_ATTEMPTS_ESCALATING, leaveAfterAnswer, type PlannedRow, type RootKind } from "../reminders/plan";
import { d1Of, type Db } from "./index";
import { getById as getItem, type Item } from "./items";
import { doneStatement } from "./points";

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

// ── Крок 2.2: відправка й кнопки (S2.3–S2.6) ────────────────────────────────────────────────────────────

export async function getReminder(userId: number, db: Db, id: number): Promise<Reminder | null> {
  return d1Of(db).prepare(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE id = ?1 AND user_id = ?2`).bind(id, userId).first<Reminder>();
}

// Скільки пушів уже пішло за ковзну годину (S2.6): окремі — рядки `single`, зведення — різні `tg_message_id`.
export async function sentCounts(userId: number, db: Db, now: number): Promise<{ singles: number; summaries: number }> {
  const row = await d1Of(db)
    .prepare(
      `SELECT SUM(sent_as = 'single') AS singles, COUNT(DISTINCT CASE WHEN sent_as = 'summary' THEN tg_message_id END) AS summaries
       FROM reminders WHERE user_id = ?1 AND sent_at > ?2`,
    )
    .bind(userId, now - HOUR_MS)
    .first<{ singles: number | null; summaries: number }>();
  return { singles: row?.singles ?? 0, summaries: row?.summaries ?? 0 };
}

// Варіант тексту останньої відправки цього користувача в тому ж пулі (НФ-4): пам'ять — у БД, не в isolate.
export async function lastVariantIdx(userId: number, db: Db, kinds: string[], attempt: number | null): Promise<number | null> {
  const row = await d1Of(db)
    .prepare(
      `SELECT variant_idx FROM reminders
       WHERE user_id = ?1 AND sent_at IS NOT NULL AND variant_idx IS NOT NULL AND kind IN (SELECT value FROM json_each(?2))
         AND (?3 IS NULL OR attempt = ?3)
       ORDER BY sent_at DESC, id DESC LIMIT 1`,
    )
    .bind(userId, JSON.stringify(kinds), attempt)
    .first<{ variant_idx: number }>();
  return row?.variant_idx ?? null;
}

// Збій Telegram, спроба не витрачена (S2.3.c): рядок лишається `pending` з тим самим `fire_at`; `until` — коли
// його можна брати знову (429: `retry_after`), null — одразу на наступному тику.
export async function releaseLease(userId: number, db: Db, id: number, until: number | null): Promise<void> {
  await d1Of(db)
    .prepare("UPDATE reminders SET lease_until = ?3 WHERE id = ?1 AND user_id = ?2 AND status = 'pending'")
    .bind(id, userId, until)
    .run();
}

// Запис не `open` чи чат недоступний (S2.3.c–d): рядок закрито без повідомлення.
export async function cancelOne(userId: number, db: Db, id: number): Promise<void> {
  await d1Of(db)
    .prepare("UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE id = ?1 AND user_id = ?2 AND status = 'pending'")
    .bind(id, userId)
    .run();
}

export interface SentFields {
  sentAt: number;
  sentAs: "single" | "summary";
  tgMessageId: number;
  variantIdx: number | null;
}

export interface NextAttempt {
  attempt: number;
  fireAt: number;
}

// Закриття ПІСЛЯ відправки (S2.3.b) і нащадок повтору — один batch (S2.2.a, S2.5.c). `UPDATE … WHERE status='pending'`
// зачепив 0 рядків (✅ закрив запис між `sendMessage` і закриттям) → нащадка немає: `INSERT … SELECT` вимагає
// `status='sent'` і запис `open`. `ux_rem_child` + ON CONFLICT: рядок, відправлений двічі (дубль оренди), нащадка не множить.
function closeStatements(userId: number, db: Db, r: Reminder, f: SentFields, next: NextAttempt | null, now: number): D1PreparedStatement[] {
  const d1 = d1Of(db);
  const stmts = [
    d1
      .prepare(
        `UPDATE reminders SET status = 'sent', sent_at = ?3, sent_as = ?4, tg_message_id = ?5, variant_idx = ?6, lease_until = NULL
         WHERE id = ?1 AND user_id = ?2 AND status = 'pending'`,
      )
      .bind(r.id, userId, f.sentAt, f.sentAs, f.tgMessageId, f.variantIdx),
  ];
  if (next !== null) {
    stmts.push(
      d1
        .prepare(
          `INSERT INTO reminders (user_id, item_id, kind, fire_at, attempt, max_attempts, parent_id, root_id, created_at)
           SELECT r.user_id, r.item_id, 'repeat', ?3, ?4, r.max_attempts, r.id, COALESCE(r.root_id, r.id), ?5
           FROM reminders r JOIN items i ON i.id = r.item_id AND i.user_id = r.user_id
           WHERE r.id = ?1 AND r.user_id = ?2 AND r.status = 'sent' AND i.status = 'open'
           ON CONFLICT DO NOTHING`,
        )
        .bind(r.id, userId, next.fireAt, next.attempt, now),
    );
  }
  return stmts;
}

// Повертає, чи ЦЕЙ виклик закрив рядок (false — ✅ чи інший прогін випередив: відправлене повідомлення треба прибрати).
export async function closeSent(userId: number, db: Db, r: Reminder, f: SentFields, next: NextAttempt | null, now: number): Promise<boolean> {
  const res = await d1Of(db).batch(closeStatements(userId, db, r, f, next, now));
  return (res[0]?.meta.changes ?? 0) === 1;
}

// Зведення: усі рядки одним batch; результат — які з них закрито цим викликом.
export async function closeSummary(
  userId: number,
  db: Db,
  rows: { r: Reminder; next: NextAttempt | null }[],
  tgMessageId: number,
  sentAt: number,
  now: number,
  variantIdx: number | null,
): Promise<boolean[]> {
  const stmts: D1PreparedStatement[] = [];
  const at: number[] = [];
  for (const { r, next } of rows) {
    at.push(stmts.length);
    stmts.push(...closeStatements(userId, db, r, { sentAt, sentAs: "summary", tgMessageId, variantIdx }, next, now));
  }
  const res = await d1Of(db).batch(stmts);
  return at.map((i) => (res[i]?.meta.changes ?? 0) === 1);
}

// Рядки зведення (за `tg_message_id` у межах користувача: id повідомлення унікальний лише в межах чату, S2.4.m)
// разом з назвою й датою запису — для показу й «Показати ще».
export interface SummaryRow extends Reminder {
  title: string;
  due_at: number | null;
  all_day: number;
}

export async function listSummaryRows(userId: number, db: Db, tgMessageId: number): Promise<SummaryRow[]> {
  const cols = REMINDER_COLUMNS.split(", ").map((c) => `r.${c}`).join(", ");
  const res = await d1Of(db)
    .prepare(
      `SELECT ${cols}, i.title AS title, i.due_at AS due_at, i.all_day AS all_day
       FROM reminders r JOIN items i ON i.id = r.item_id AND i.user_id = r.user_id
       WHERE r.user_id = ?1 AND r.tg_message_id = ?2 AND r.sent_as = 'summary' ORDER BY r.fire_at, r.id`,
    )
    .bind(userId, tgMessageId)
    .all<SummaryRow>();
  return res.results;
}

export type PressOutcome = "done" | "was_done" | "was_released" | "unknown";

// Чому «закрити» нічого не змінило: за станом запису.
async function whyNot(userId: number, db: Db, itemId: number): Promise<"was_done" | "was_released" | "unknown"> {
  const it: Item | null = await getItem(userId, db, itemId);
  return it === null ? "unknown" : it.status === "done" ? "was_done" : it.status === "released" ? "was_released" : "unknown";
}

const ITEM_OPEN = "EXISTS (SELECT 1 FROM items WHERE id = ?2 AND user_id = ?1 AND status = 'open')";

// ✅ (S2.4.a–c): один `DB.batch` — очко (поки запис `open`) → решта `pending` запису скасована → натиснутий
// `answered` → запис `done` (останнім, бо попередні умови читають «ще open»). Відповідь за `changes` останнього
// оператора, а не за попередньою перевіркою: два паралельні ✅ — виграє перша транзакція, друга бачить `done`.
export async function pressDone(userId: number, db: Db, r: Reminder, now: number): Promise<PressOutcome> {
  const d1 = d1Of(db);
  const itemId = r.item_id!;
  const res = await d1.batch([
    doneStatement(userId, db, itemId, now),
    d1
      .prepare(`UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE user_id = ?1 AND item_id = ?2 AND status = 'pending' AND ${ITEM_OPEN}`)
      .bind(userId, itemId),
    d1
      .prepare(`UPDATE reminders SET status = 'answered' WHERE id = ?3 AND user_id = ?1 AND status = 'sent' AND ${ITEM_OPEN}`)
      .bind(userId, itemId, r.id),
    d1
      .prepare("UPDATE items SET status = 'done', done_at = ?3 WHERE id = ?2 AND user_id = ?1 AND status = 'open'")
      .bind(userId, itemId, now),
  ]);
  return (res[3]?.meta.changes ?? 0) === 1 ? "done" : whyNot(userId, db, itemId);
}

// 🗑 (S2.4.h): запис `released` (не видалений), `pending` запису скасовано, натиснутий `answered`; очок немає.
export async function pressRelease(userId: number, db: Db, r: Reminder): Promise<PressOutcome> {
  const d1 = d1Of(db);
  const itemId = r.item_id!;
  const res = await d1.batch([
    d1
      .prepare(`UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE user_id = ?1 AND item_id = ?2 AND status = 'pending' AND ${ITEM_OPEN}`)
      .bind(userId, itemId),
    d1
      .prepare(`UPDATE reminders SET status = 'answered' WHERE id = ?3 AND user_id = ?1 AND status = 'sent' AND ${ITEM_OPEN}`)
      .bind(userId, itemId, r.id),
    d1
      .prepare("UPDATE items SET status = 'released', done_at = NULL WHERE id = ?2 AND user_id = ?1 AND status = 'open'")
      .bind(userId, itemId),
  ]);
  return (res[2]?.meta.changes ?? 0) === 1 ? "done" : whyNot(userId, db, itemId);
}

// 👍 на `eve_before` (S2.4.l): лише натиснутий рядок → `answered`; запис, інші ланцюги й очки не чіпаємо.
export async function pressAck(userId: number, db: Db, r: Reminder): Promise<boolean> {
  const res = await d1Of(db)
    .prepare("UPDATE reminders SET status = 'answered' WHERE id = ?1 AND user_id = ?2 AND status = 'sent'")
    .bind(r.id, userId)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export interface SnoozeTarget {
  kind: RootKind; // kind КОРЕНЯ ланцюга (для `repeat` — kind кореня)
  maxAttempts: number;
  fireAt: number;
}

export type SnoozeOutcome = "snoozed" | "already" | "was_done" | "was_released" | "unknown";

// ⏰ s15/s60/tom (S2.4.e–f): новий корінь + `snooze_count + 1` + `pending` ЦЬОГО ланцюга скасовано + натиснутий
// `answered` — один batch. Попередні оператори читають «натиснутий ще `sent`», тож подвійний тап (натиснутий уже
// `answered`) не створює другого кореня й не множить лічильник; останній оператор `answered` дає відповідь.
// Інші ланцюги запису не зачеплені (`COALESCE(root_id, id)`).
export async function pressSnooze(userId: number, db: Db, p: Reminder, t: SnoozeTarget, now: number): Promise<SnoozeOutcome> {
  const d1 = d1Of(db);
  const itemId = p.item_id!;
  const chain = p.root_id ?? p.id;
  const pressedSent = "EXISTS (SELECT 1 FROM reminders WHERE id = ?3 AND user_id = ?1 AND status = 'sent')";
  const res = await d1.batch([
    d1
      .prepare(
        `INSERT INTO reminders (user_id, item_id, kind, fire_at, attempt, max_attempts, created_at)
         SELECT ?1, ?2, ?4, ?5, 1, ?6, ?7 FROM items i
         WHERE i.id = ?2 AND i.user_id = ?1 AND i.status = 'open' AND ${pressedSent}
         ON CONFLICT DO NOTHING`,
      )
      .bind(userId, itemId, p.id, t.kind, t.fireAt, t.maxAttempts, now),
    d1
      .prepare(`UPDATE items SET snooze_count = snooze_count + 1 WHERE id = ?2 AND user_id = ?1 AND status = 'open' AND ${pressedSent}`)
      .bind(userId, itemId, p.id),
    d1
      .prepare(
        `UPDATE reminders SET status = 'cancelled', lease_until = NULL
         WHERE user_id = ?1 AND item_id = ?2 AND status = 'pending' AND COALESCE(root_id, id) = ?4 AND ${pressedSent}`,
      )
      .bind(userId, itemId, p.id, chain),
    d1
      .prepare(`UPDATE reminders SET status = 'answered' WHERE id = ?3 AND user_id = ?1 AND status = 'sent' AND ${ITEM_OPEN}`)
      .bind(userId, itemId, p.id),
  ]);
  if ((res[3]?.meta.changes ?? 0) === 1) return "snoozed";
  const why = await whyNot(userId, db, itemId);
  return why === "unknown" ? "already" : why;
}

// Як пішли батьки повторів (S2.6 п.1: повтори групи не розсипаються на окремі пуші).
export async function parentSentAs(userId: number, db: Db, parentIds: number[]): Promise<Map<number, "single" | "summary" | null>> {
  if (parentIds.length === 0) return new Map();
  const res = await d1Of(db)
    .prepare("SELECT id, sent_as FROM reminders WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))")
    .bind(userId, JSON.stringify(parentIds))
    .all<{ id: number; sent_as: "single" | "summary" | null }>();
  return new Map(res.results.map((r) => [r.id, r.sent_as]));
}

// ── Крок 2.3: дорога до події (S2.7) ─────────────────────────────────────────────────────────────────────

// Питання «скільки добиратись?» — раз на подію (S2.7.a): захоплення `travel_asked_at IS NULL` в самому операторі, тож
// повтор доставки чи другий шлях квитанції (повтор розбору) другого питання не дає. true — питання задаєш ти.
export async function claimTravelAsk(userId: number, db: Db, itemId: number, now: number): Promise<boolean> {
  const res = await d1Of(db)
    .prepare(
      "UPDATE items SET travel_asked_at = ?3 WHERE id = ?2 AND user_id = ?1 AND status = 'open' AND kind = 'event' AND travel_asked_at IS NULL",
    )
    .bind(userId, itemId, now)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

export type TravelOutcome =
  | { kind: "set"; fireAt: number; changed: boolean } // fireAt: коли піде «час виходити»; changed=false — те саме N, без змін
  | { kind: "gone" } // немає такого запису / не подія з часом / закритий
  | { kind: "started" }; // подія вже почалась: нічого не змінено

// Відповідь `tr:<item>:<хв>` (S2.7.b, S2.7.g): `travel_min = N`, `pending` ланцюги `leave_now` скасовано, новий корінь
// о `due − N − 15 хв` (мить уже позаду, а подія ще попереду → зараз). `NULL` і `0` — те саме N: повтор того самого N
// при наявному не скасованому корені `leave_now` — без змін. Скасування й вставка — один batch (D1 виконує його
// атомарно): рівно один `pending` `leave_now`, хоч би скільки разів тапнули. Скасований корінь не блокує вставку
// (`ux_rem_root` частковий за `status <> 'cancelled'`), тож 30 → 60 → 30 лишає один `pending`.
export async function setTravel(userId: number, db: Db, itemId: number, minutes: number, now: number): Promise<TravelOutcome> {
  const item = await getItem(userId, db, itemId);
  if (item === null || item.kind !== "event" || item.status !== "open" || item.due_at === null || item.all_day === 1) return { kind: "gone" };
  const fireAt = leaveAfterAnswer(item.due_at, minutes, now);
  if (fireAt === null) return { kind: "started" };
  const same = (item.travel_min ?? 0) === minutes;
  if (same) {
    const have = await d1Of(db)
      .prepare("SELECT 1 AS x FROM reminders WHERE user_id = ?1 AND item_id = ?2 AND kind = 'leave_now' AND parent_id IS NULL AND status <> 'cancelled' LIMIT 1")
      .bind(userId, itemId)
      .first<{ x: number }>();
    if (have !== null) return { kind: "set", fireAt, changed: false };
  }
  const d1 = d1Of(db);
  await d1.batch([
    d1.prepare("UPDATE items SET travel_min = ?3 WHERE id = ?2 AND user_id = ?1 AND status = 'open'").bind(userId, itemId, minutes),
    d1
      .prepare(
        "UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE user_id = ?1 AND item_id = ?2 AND status = 'pending' AND kind IN ('leave_now', 'repeat')",
      )
      .bind(userId, itemId),
    rootInsert(userId, db, itemId, { kind: "leave_now", fireAt, maxAttempts: MAX_ATTEMPTS_ESCALATING }, now, false),
  ]);
  return { kind: "set", fireAt, changed: true };
}
