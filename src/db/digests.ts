// Дані оглядів (docs/spec/phase-3.md, S3.1–S3.6). Кожна функція — з `userId` першим (НФ-3); огляди читають лише
// `items`, `points_ledger` і `reminders`, ніколи `routines` (правило 4). Вибірка «кому бракує огляду» — `system.ts`.
import type { DigestKind } from "../digests/schedule";
import { d1Of, type Db } from "./index";
import type { Reminder } from "./reminders";

export interface DigestItem {
  id: number;
  title: string;
  due_at: number | null;
  all_day: number;
  priority: "normal" | "important";
  created_at: number;
}

const COLS = "i.id AS id, i.title AS title, i.due_at AS due_at, i.all_day AS all_day, i.priority AS priority, i.created_at AS created_at";
const OPEN_LIMIT = 200;

// `fire_at` останнього відправленого огляду цього виду: від нього рахується межа доби в `nextDigestAt` (S3.1, В1).
export async function lastSentFireAt(userId: number, db: Db, kind: DigestKind): Promise<number | null> {
  const row = await d1Of(db)
    .prepare("SELECT MAX(fire_at) AS t FROM reminders WHERE user_id = ?1 AND kind = ?2 AND status IN ('sent','answered')")
    .bind(userId, kind)
    .first<{ t: number | null }>();
  return row?.t ?? null;
}

// Варіант заголовка — останнього `sent` рядка того ж виду (NULL у теплої фрази: її пам'ять — `users.warm_variant_idx`).
export async function lastDigestVariantIdx(userId: number, db: Db, kind: DigestKind): Promise<number | null> {
  const row = await d1Of(db)
    .prepare(
      `SELECT variant_idx FROM reminders WHERE user_id = ?1 AND kind = ?2 AND status = 'sent' AND variant_idx IS NOT NULL
       ORDER BY sent_at DESC, id DESC LIMIT 1`,
    )
    .bind(userId, kind)
    .first<{ variant_idx: number }>();
  return row?.variant_idx ?? null;
}

export interface MorningContent {
  events: DigestItem[];
  tasks: DigestItem[];
}

// Ранок (S3.2): доба `[start, end)`, лише `open`. Події: з часом — лише ті, що ще попереду, `all_day` — першими.
// Справи: з датою `due_at < end` (сьогоднішні й давніші — «тихий перенос») та без дати; майбутні й нотатки не беруться.
// Порядок: (1) important — за датою (без дати в кінці групи), (2) normal з датою, (3) normal без дати — найстаріші.
export async function morningContent(userId: number, db: Db, start: number, end: number, now: number, limit = OPEN_LIMIT): Promise<MorningContent> {
  const d1 = d1Of(db);
  const [events, tasks] = await Promise.all([
    d1
      .prepare(
        `SELECT ${COLS} FROM items i
         WHERE i.user_id = ?1 AND i.status = 'open' AND i.kind = 'event' AND i.due_at >= ?2 AND i.due_at < ?3
           AND (i.all_day = 1 OR i.due_at > ?4)
         ORDER BY i.all_day DESC, i.due_at, i.id`,
      )
      .bind(userId, start, end, now)
      .all<DigestItem>(),
    d1
      .prepare(
        `SELECT ${COLS} FROM items i
         WHERE i.user_id = ?1 AND i.status = 'open' AND i.kind = 'task' AND (i.due_at IS NULL OR i.due_at < ?2)
         ORDER BY CASE WHEN i.priority = 'important' THEN 0 WHEN i.due_at IS NOT NULL THEN 1 ELSE 2 END,
                  i.due_at IS NULL, i.due_at, i.created_at, i.id
         LIMIT ?3`,
      )
      .bind(userId, end, limit)
      .all<DigestItem>(),
  ]);
  return { events: events.results, tasks: tasks.results };
}

// Вечір (S3.5): зроблене за добу огляду до миті відправки.
export async function doneBetween(userId: number, db: Db, from: number, to: number): Promise<DigestItem[]> {
  const res = await d1Of(db)
    .prepare(
      `SELECT ${COLS} FROM items i WHERE i.user_id = ?1 AND i.status = 'done' AND i.done_at >= ?2 AND i.done_at < ?3
       ORDER BY i.done_at, i.id LIMIT ?4`,
    )
    .bind(userId, from, to, OPEN_LIMIT)
    .all<DigestItem>();
  return res.results;
}

// Очки дня: лише додатні `delta` (redeem — витрата, а не «мінус дня»).
export async function pointsBetween(userId: number, db: Db, from: number, to: number): Promise<number> {
  const row = await d1Of(db)
    .prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM points_ledger WHERE user_id = ?1 AND delta > 0 AND created_at >= ?2 AND created_at < ?3")
    .bind(userId, from, to)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// «Ще висить» (S3.5): справи `open`, чий ланцюг нагадувань ВИЧЕРПАНО в цю добу — останній рядок ланцюга `sent` без
// нащадка, відправлений у `[from, to)`. Не `eve_before`, не огляд; події не беруться (минула подія — докір).
export async function hangingBetween(userId: number, db: Db, from: number, to: number): Promise<DigestItem[]> {
  const res = await d1Of(db)
    .prepare(
      `SELECT ${COLS} FROM items i
       WHERE i.user_id = ?1 AND i.kind = 'task' AND i.status = 'open'
         AND EXISTS (SELECT 1 FROM reminders r
                     WHERE r.item_id = i.id AND r.user_id = i.user_id AND r.status = 'sent'
                       AND r.sent_at >= ?2 AND r.sent_at < ?3 AND r.kind IN ('due','repeat','leave_now')
                       AND NOT EXISTS (SELECT 1 FROM reminders c WHERE c.parent_id = r.id))
       ORDER BY (SELECT MAX(r.sent_at) FROM reminders r WHERE r.item_id = i.id AND r.user_id = i.user_id), i.id LIMIT ?4`,
    )
    .bind(userId, from, to, OPEN_LIMIT)
    .all<DigestItem>();
  return res.results;
}

// Зависле (S3.6): справа `open`, `created_at ≤ cutoff`, без дати або з датою до початку доби огляду. Найстаріші першими.
export async function stuckTasks(userId: number, db: Db, dayStart: number, cutoff: number, limit: number): Promise<DigestItem[]> {
  const res = await d1Of(db)
    .prepare(
      `SELECT ${COLS} FROM items i
       WHERE i.user_id = ?1 AND i.kind = 'task' AND i.status = 'open' AND i.created_at <= ?3 AND (i.due_at IS NULL OR i.due_at < ?2)
       ORDER BY i.created_at, i.id LIMIT ?4`,
    )
    .bind(userId, dayStart, cutoff, limit)
    .all<DigestItem>();
  return res.results;
}

// Записи користувача за id (чужі не повертаються) — для перерахунку рядків тижневого огляду з розмітки (3.6.c).
export async function titlesByIds(userId: number, db: Db, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const res = await d1Of(db)
    .prepare("SELECT id, title FROM items WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))")
    .bind(userId, JSON.stringify(ids))
    .all<{ id: number; title: string }>();
  return new Map(res.results.map((r) => [r.id, r.title]));
}

// ── Рядки огляду в черзі ───────────────────────────────────────────────────────────────────────────────

// `ON CONFLICT DO NOTHING`: паралельне доплановування чи другий прогін не додають другого `pending` (ux_rem_digest_pending).
function insertStatement(userId: number, db: Db, kind: DigestKind, fireAt: number, now: number): D1PreparedStatement {
  return d1Of(db)
    .prepare(
      `INSERT INTO reminders (user_id, item_id, kind, fire_at, attempt, max_attempts, created_at)
       VALUES (?1, NULL, ?2, ?3, 1, 1, ?4) ON CONFLICT DO NOTHING`,
    )
    .bind(userId, kind, fireAt, now);
}

// Повертає, чи рядок справді додано (0 — майбутній огляд цього виду вже є).
export async function insertDigest(userId: number, db: Db, kind: DigestKind, fireAt: number, now: number): Promise<boolean> {
  const res = await insertStatement(userId, db, kind, fireAt, now).run();
  return (res.meta.changes ?? 0) === 1;
}

export interface DigestSent {
  sentAt: number;
  tgMessageId: number;
  variantIdx: number | null;
  warmIdx: number | null; // тепла фраза порожнього ранку: `users.warm_at` = sentAt, `warm_variant_idx` = цей варіант
  cancelDueIds: number[]; // S3.4: `due`-рядки відрендерених у ранку записів `all_day`, орендовані в цьому ж тику
  dayStart: number;
  dayEnd: number;
}

// Закриття ПІСЛЯ відправки й наступний огляд — один batch (S3.1.c). Рядок вже закритий іншим прогоном (дубль) →
// `false`, але наступний уже є (ON CONFLICT), а скасування `due` усе одно виконується: повідомлення пішло.
export async function closeDigestSent(userId: number, db: Db, r: Reminder, f: DigestSent, nextFireAt: number, now: number): Promise<boolean> {
  const d1 = d1Of(db);
  const stmts: D1PreparedStatement[] = [
    d1
      .prepare(
        `UPDATE reminders SET status = 'sent', sent_at = ?3, sent_as = 'single', tg_message_id = ?4, variant_idx = ?5, lease_until = NULL
         WHERE id = ?1 AND user_id = ?2 AND status = 'pending'`,
      )
      .bind(r.id, userId, f.sentAt, f.tgMessageId, f.variantIdx),
    insertStatement(userId, db, r.kind as DigestKind, nextFireAt, now),
  ];
  if (f.warmIdx !== null) stmts.push(d1.prepare("UPDATE users SET warm_at = ?2, warm_variant_idx = ?3 WHERE id = ?1").bind(userId, f.sentAt, f.warmIdx));
  if (f.cancelDueIds.length > 0) {
    // Лише кореневі `due` з однією спробою, що ще `pending`, записів `all_day` цієї доби. `important` (4 спроби) не чіпаємо.
    stmts.push(
      d1
        .prepare(
          `UPDATE reminders SET status = 'cancelled', lease_until = NULL
           WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2)) AND status = 'pending'
             AND kind = 'due' AND attempt = 1 AND max_attempts = 1 AND parent_id IS NULL
             AND item_id IN (SELECT id FROM items WHERE user_id = ?1 AND all_day = 1 AND due_at >= ?3 AND due_at < ?4)`,
        )
        .bind(userId, JSON.stringify(f.cancelDueIds), f.dayStart, f.dayEnd),
    );
  }
  const res = await d1.batch(stmts);
  return (res[0]?.meta.changes ?? 0) === 1;
}

// Огляд закрито без повідомлення (порожній, TTL, чат недоступний) і наступний — один batch. Доби не забирає (рахується лише `sent`).
export async function cancelDigest(userId: number, db: Db, r: Reminder, nextFireAt: number, now: number): Promise<void> {
  const d1 = d1Of(db);
  await d1.batch([
    d1
      .prepare("UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE id = ?1 AND user_id = ?2 AND status = 'pending'")
      .bind(r.id, userId),
    insertStatement(userId, db, r.kind as DigestKind, nextFireAt, now),
  ]);
}

// ── Кнопки тижневого огляду (S3.6) ──────────────────────────────────────────────────────────────────────

export type WeeklyOutcome = "done" | "already" | "not_actual" | "unknown";

const ITEM_OPEN = "EXISTS (SELECT 1 FROM items WHERE id = ?2 AND user_id = ?1 AND status = 'open')";

async function whyNot(userId: number, db: Db, itemId: number): Promise<{ status: string; due_at: number | null; all_day: number } | null> {
  return d1Of(db)
    .prepare("SELECT status, due_at, all_day FROM items WHERE id = ?1 AND user_id = ?2")
    .bind(itemId, userId)
    .first<{ status: string; due_at: number | null; all_day: number }>();
}

// «✅ сьогодні» (S3.6): один batch з умовою `status='open' AND user_id=?`. `due_at` = початок сьогоднішньої доби,
// `all_day = 1`, `planned_at = now` (планувальник запис не перепланує: пуша нема, завтра запис у ранку, сьогодні — у /today),
// `pending` нагадування запису → `cancelled`. Очок немає. Двічі тапнути безпечно: другий UPDATE умову не справджує.
export async function moveToToday(userId: number, db: Db, itemId: number, dayStart: number, now: number): Promise<WeeklyOutcome> {
  const d1 = d1Of(db);
  const res = await d1.batch([
    d1
      .prepare(
        `UPDATE items SET due_at = ?3, all_day = 1, planned_at = ?4
         WHERE id = ?2 AND user_id = ?1 AND status = 'open' AND NOT (all_day = 1 AND due_at = ?3)`,
      )
      .bind(userId, itemId, dayStart, now),
    d1
      .prepare(`UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE user_id = ?1 AND item_id = ?2 AND status = 'pending' AND ${ITEM_OPEN}`)
      .bind(userId, itemId),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 1) return "done";
  const it = await whyNot(userId, db, itemId);
  if (it === null) return "unknown";
  return it.status === "open" ? "already" : "not_actual";
}

// «🗑 відпустити» — та сама семантика, що 🗑 нагадування (S2.4): `released`, `pending` запису скасовано, запис у пошуку.
export async function releaseItem(userId: number, db: Db, itemId: number): Promise<WeeklyOutcome> {
  const d1 = d1Of(db);
  const res = await d1.batch([
    d1
      .prepare(`UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE user_id = ?1 AND item_id = ?2 AND status = 'pending' AND ${ITEM_OPEN}`)
      .bind(userId, itemId),
    d1.prepare("UPDATE items SET status = 'released', done_at = NULL WHERE id = ?2 AND user_id = ?1 AND status = 'open'").bind(userId, itemId),
  ]);
  if ((res[1]?.meta.changes ?? 0) === 1) return "done";
  const it = await whyNot(userId, db, itemId);
  return it === null ? "unknown" : "not_actual";
}

// Чи існує запис у цього користувача (для 🧩-заглушки: чужий id → нейтральний тост без змін).
export async function itemExists(userId: number, db: Db, itemId: number): Promise<boolean> {
  return (await whyNot(userId, db, itemId)) !== null;
}
