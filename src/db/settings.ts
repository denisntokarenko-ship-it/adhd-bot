// Зміна налаштувань /settings (docs/spec/phase-3-settings-prod.md, S3.7–S3.8). Кожна зміна — ОДИН `DB.batch`: збій
// посеред нічого не застосовує (3.8.e). Читання (користувач, записи, корені) — до batch, усі оператори готуються
// наперед; умови в SQL (`status='pending'`, `due_at = старе`) стережуть гонку між читанням і записом.
// Кожна функція — з `userId` першим (НФ-3): чужі записи й рядки не чіпаються.
import { retimeRootsStatements } from "./routines";
import { lastSentFireAt } from "./digests";
import { d1Of, type Db } from "./index";
import { affectedDigests, nextDigestAt } from "../digests/schedule";
import { plannedFor, plannerMoment, type PlanItem, type RootKind } from "../reminders/plan";
import { dayBounds, localIso, localToUtc } from "../time";

export type SettingChange =
  | { field: "morning_at"; value: number }
  | { field: "evening_at"; value: number }
  | { field: "weekly_dow"; value: number }
  | { field: "tz"; value: string };

interface Settings {
  tz: string;
  morning_at: number;
  evening_at: number;
  weekly_dow: number;
}

export type SettingsView = Settings & { quiet_from: number; quiet_to: number };

export async function getSettings(userId: number, db: Db): Promise<SettingsView | null> {
  return d1Of(db)
    .prepare("SELECT tz, morning_at, evening_at, weekly_dow, quiet_from, quiet_to FROM users WHERE id = ?1")
    .bind(userId)
    .first<SettingsView>();
}

interface OpenItem extends PlanItem {
  id: number;
}
interface PendingRoot {
  id: number;
  item_id: number;
  kind: RootKind;
  fire_at: number;
}

// Календарна дата «YYYY-MM-DD» мить у tz.
const dateOf = (ms: number, tz: string) => localIso(ms, tz).slice(0, 10);

// Записи `all_day` зберігають локальну ДАТУ: та сама дата, північ нового поясу (S3.8 п. 2).
function shiftedAllDay(dueAt: number, oldTz: string, newTz: string): number {
  const date = dateOf(dueAt, oldTz);
  return localToUtc(date, newTz) ?? dayBounds(newTz, dueAt)[0];
}

interface Transfer {
  oldId: number;
  itemId: number;
  kind: RootKind;
  fireAt: number;
  maxAttempts: number;
}

// Корені ПЛАНУВАЛЬНИКА, що переносяться (S3.7, рев'ю 3.0 В3): `pending` корінь, чий `fire_at` збігається з
// миттю формули планувальника на СТАРИХ налаштуваннях і для якого `plannedFor` на нових дає рядок того ж `kind`.
// Корені ⏰ (інша мить) і корені, для яких нова мить уже позаду, лишаються як є.
function planTransfers(
  items: Map<number, OpenItem>,
  roots: PendingRoot[],
  oldS: Settings,
  newS: Settings,
  newDueOf: (it: OpenItem) => number | null,
  now: number,
): Transfer[] {
  const out: Transfer[] = [];
  for (const r of roots) {
    const it = items.get(r.item_id);
    if (it === undefined || (r.kind !== "due" && r.kind !== "eve_before")) continue;
    const oldMoment = plannerMoment(r.kind, it, oldS);
    if (oldMoment === null || oldMoment !== r.fire_at) continue; // не корінь планувальника (⏰ тощо)
    const newItem: OpenItem = { ...it, due_at: newDueOf(it) };
    const next = plannedFor(newItem, now, newS).find((p) => p.kind === r.kind);
    if (next === undefined) continue; // нова мить позаду — лишаємо стару: пуш о старій годині краще за тишу
    if (next.fireAt === r.fire_at) continue; // нічого не змінилось
    out.push({ oldId: r.id, itemId: it.id, kind: r.kind, fireAt: next.fireAt, maxAttempts: next.maxAttempts });
  }
  return out;
}

// Застосовує зміну. Повертає `false`, якщо значення вже таке саме (подвійний тап — нічого не чіпаємо).
export async function applySetting(userId: number, db: Db, change: SettingChange, now: number): Promise<boolean> {
  const old = await getSettings(userId, db);
  if (old === null || old[change.field] === change.value) return false;
  const oldS: Settings = { tz: old.tz, morning_at: old.morning_at, evening_at: old.evening_at, weekly_dow: old.weekly_dow };
  const newS: Settings = { ...oldS, [change.field]: change.value } as Settings;
  const d1 = d1Of(db);
  const stmts: D1PreparedStatement[] = [];

  stmts.push(d1.prepare(`UPDATE users SET ${change.field} = ?2 WHERE id = ?1`).bind(userId, change.value));
  // Рутини (4.7.e): невідправлені корені → DELETE і нові за новим `tz` — тим самим batch.
  if (change.field === "tz") stmts.push(...(await retimeRootsStatements(userId, db, newS.tz, now)));

  // ── Записи й корені: лише для зміни `tz` та `morning_at` ───────────────────────────────────────────────
  if (change.field === "tz" || change.field === "morning_at") {
    const itemsRes = await d1
      .prepare(
        `SELECT id, kind, due_at, all_day, priority, status, travel_min FROM items
         WHERE user_id = ?1 AND status = 'open' AND due_at IS NOT NULL`,
      )
      .bind(userId)
      .all<OpenItem>();
    const items = new Map(itemsRes.results.map((i) => [i.id, i]));
    const rootsRes = await d1
      .prepare(
        `SELECT id, item_id, kind, fire_at FROM reminders
         WHERE user_id = ?1 AND status = 'pending' AND parent_id IS NULL AND kind IN ('due','eve_before') AND item_id IS NOT NULL`,
      )
      .bind(userId)
      .all<PendingRoot>();

    const tzChanged = change.field === "tz";
    const newDueOf = (it: OpenItem): number | null =>
      tzChanged && it.all_day === 1 && it.due_at !== null ? shiftedAllDay(it.due_at, oldS.tz, newS.tz) : it.due_at;

    if (tzChanged) {
      // S3.8 п. 2: `all_day` — та сама локальна дата в новому поясі; з часом — та сама мить (не чіпаємо).
      const moves = itemsRes.results
        .filter((i) => i.all_day === 1 && i.due_at !== null)
        .map((i) => [i.id, newDueOf(i), i.due_at] as const)
        .filter(([, nd, od]) => nd !== od);
      if (moves.length > 0) {
        stmts.push(
          d1
            .prepare(
              `UPDATE items SET due_at = j.nd
               FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS nd, json_extract(value, '$[2]') AS od
                     FROM json_each(?2)) j
               WHERE items.id = j.id AND items.user_id = ?1 AND items.status = 'open' AND items.due_at = j.od`,
            )
            .bind(userId, JSON.stringify(moves)),
        );
      }
    }

    const transfers = planTransfers(items, rootsRes.results, oldS, newS, newDueOf, now);
    if (transfers.length > 0) {
      const ids = JSON.stringify(transfers.map((t) => t.oldId));
      const tuples = JSON.stringify(transfers.map((t) => [t.itemId, t.kind, t.fireAt, t.maxAttempts, t.oldId]));
      stmts.push(
        // старі корені планувальника → cancelled — лише `pending` без активної оренди (її бере відправка; тоді новий корінь
        // нижче не вставиться, бо старий не `cancelled`, а `planned_at` не скинеться)
        d1
          .prepare(
            `UPDATE reminders SET status = 'cancelled', lease_until = NULL
             WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2)) AND status = 'pending' AND (lease_until IS NULL OR lease_until <= ?3)`,
          )
          .bind(userId, ids, now),
        // нові корені — одразу тут: `rootInsert(newKindOnly)` не створює корінь `kind`, якщо будь-який (і скасований) уже є.
        // Вставляємо лише там, де старий справді скасовано цим batch.
        d1
          .prepare(
            `INSERT INTO reminders (user_id, item_id, kind, fire_at, attempt, max_attempts, created_at)
             SELECT ?1, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), 1,
                    json_extract(j.value, '$[3]'), ?3
             FROM json_each(?2) j
             WHERE EXISTS (SELECT 1 FROM reminders o WHERE o.id = json_extract(j.value, '$[4]') AND o.user_id = ?1 AND o.status = 'cancelled')
               AND EXISTS (SELECT 1 FROM items i WHERE i.id = json_extract(j.value, '$[0]') AND i.user_id = ?1 AND i.status = 'open')
             ON CONFLICT DO NOTHING`,
          )
          .bind(userId, tuples, now),
        // `planned_at = NULL` (спека): планувальник перерахує запис — нові корені він уже бачить, дублів не буде
        d1
          .prepare(
            `UPDATE items SET planned_at = NULL
             WHERE user_id = ?1 AND id IN (SELECT json_extract(value, '$[0]') FROM json_each(?2))
               AND EXISTS (SELECT 1 FROM reminders o WHERE o.item_id = items.id AND o.user_id = ?1 AND o.status = 'cancelled' AND o.id IN (SELECT value FROM json_each(?3)))`,
          )
          .bind(userId, tuples, ids),
      );
    }
  }

  // ── Огляди: cancelled + нові на `nextDigestAt` (межа доби — в НОВИХ налаштуваннях) ─────────────────────
  for (const kind of affectedDigests(change.field)) {
    const last = await lastSentFireAt(userId, db, kind);
    const fireAt = nextDigestAt(kind, newS, now, last);
    stmts.push(
      d1.prepare("UPDATE reminders SET status = 'cancelled', lease_until = NULL WHERE user_id = ?1 AND kind = ?2 AND status = 'pending'").bind(userId, kind),
      d1
        .prepare(
          `INSERT INTO reminders (user_id, item_id, kind, fire_at, attempt, max_attempts, created_at)
           VALUES (?1, NULL, ?2, ?3, 1, 1, ?4) ON CONFLICT DO NOTHING`,
        )
        .bind(userId, kind, fireAt, now),
    );
  }

  await d1.batch(stmts);
  return true;
}
