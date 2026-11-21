// Чисті функції черги нагадувань (docs/spec/phase-2.md, «Константи», «Звідки береться нагадування», S2.2).
// Без БД і без «зараз» усередині: усе в UTC ms, локальна доба — лише через `localToUtc`/`localIso` у `tz` (НФ-1).
import { inQuietHours, localIso, localToUtc, minutesOfDay } from "../time";

const MIN = 60_000;

export const REPEAT_DELAYS_MIN = [5, 15, 30] as const; // пауза після спроби 1, 2, 3 — від фактичної відправки
export const MAX_ATTEMPTS_ESCALATING = 4; // important і leave_now
export const LATE_MS = 5 * MIN; // «запізніле»: fire_at ≤ now − LATE_MS
export const LEASE_MS = 120_000; // оренда рядка під час відправки
export const CLAIM_LIMIT = 50; // рядків за прогін на всіх
export const STALE_MS = 48 * 3_600_000; // старше — мовчки cancelled (без повідомлень)
export const RUN_BUDGET_MS = 40_000; // після цього прогін нових відправок не починає
export const PUSH_SINGLE_PER_HOUR = 6; // окремих повідомлень на ковзну годину
export const PUSH_SUMMARY_PER_HOUR = 1; // зведень на ковзну годину
export const SUMMARY_LINES = 5; // рядків у зведенні, решта — кнопкою
export const DONE_POINTS = 10; // очки ✅ (S2.4.a)
export const HOUR_MS = 3_600_000;
export const PAUSE_MAX_H = 24; // `/pause N`: ціле 1–24 год (S2.9.e)
export const PLAN_LIMIT = 50; // записів за тик планувальника
export const EVE_AT_MIN = 20 * 60; // «навечір» — 20:00 попереднього дня
export const EVE_MIN_LEAD_MS = 5 * MIN; // eve_before лише якщо ще попереду більш ніж на 5 хв
export const LEAVE_BUFFER_MIN = 15; // leave_now = due − travel − 15 хв
export const TRAVEL_CHOICES = [0, 15, 30, 60] as const; // кнопки питання «скільки добиратись?» (S2.7.a), хв

export type RootKind = "due" | "eve_before" | "leave_now";

export interface PlanItem {
  kind: "task" | "note" | "event";
  due_at: number | null;
  all_day: number;
  priority: "normal" | "important";
  status: "open" | "done" | "released";
  travel_min: number | null;
}

export interface PlanUser {
  tz: string;
  morning_at: number; // хвилини від локальної півночі
}

export interface PlannedRow {
  kind: RootKind;
  fireAt: number;
  maxAttempts: number;
}

const z2 = (n: number) => String(n).padStart(2, "0");
const hhmm = (minutes: number) => `${z2(Math.floor(minutes / 60))}:${z2(minutes % 60)}`;

// Локальна дата «YYYY-MM-DD» моменту `ms` у `tz` (не UTC-дата: о 00:30 Києва UTC-дата ще вчорашня).
const localDate = (ms: number, tz: string) => localIso(ms, tz).slice(0, 10);

// Календарний зсув дати без пояса (арифметика на UTC-полі, лише для «наступна/попередня дата»).
function shiftDate(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${z2(t.getUTCMonth() + 1)}-${z2(t.getUTCDate())}`;
}

// Локальна «стінна» мить дати й хвилини доби → UTC ms (літній час — правила `localToUtc`).
function wallToUtc(ymd: string, minutes: number, tz: string): number {
  const ms = localToUtc(`${ymd}T${hhmm(minutes)}`, tz);
  if (ms === null) throw new Error("plan: bad local time");
  return ms;
}

// Мить кореня ПЛАНУВАЛЬНИКА для запису: `due` запису `all_day` — `morning_at` його локальної дати, `eve_before` події з
// часом — 20:00 напередодні. Для інших пар (`kind`, запис) — null: їхня мить не залежить від `tz`/`morning_at`.
// Єдине місце формули: `plannedFor` і перенос коренів при зміні налаштувань (S3.7, S3.8) рахують однаково.
export function plannerMoment(kind: RootKind, item: PlanItem, user: PlanUser): number | null {
  if (item.due_at === null) return null;
  if (kind === "due" && item.all_day === 1) return wallToUtc(localDate(item.due_at, user.tz), user.morning_at, user.tz);
  if (kind === "eve_before" && item.all_day !== 1 && item.kind === "event") {
    return wallToUtc(shiftDate(localDate(item.due_at, user.tz), -1), EVE_AT_MIN, user.tz);
  }
  return null;
}

// Які корені нагадувань випливають із запису (таблиця «Звідки береться нагадування»). Рядки «у минулому»
// (fire_at < now − LATE_MS) не створюються; eve_before — лише якщо 20:00 напередодні ще попереду (> now + 5 хв).
// Подія не стає important: priority не змінюється, а leave_now ескалюється завжди; eve_before — один раз.
export function plannedFor(item: PlanItem, now: number, user: PlanUser): PlannedRow[] {
  if (item.status !== "open" || item.due_at === null) return [];
  const due = item.due_at;
  const byPriority = item.priority === "important" ? MAX_ATTEMPTS_ESCALATING : 1;
  const rows: PlannedRow[] = [];
  if (item.all_day === 1) {
    rows.push({ kind: "due", fireAt: plannerMoment("due", item, user)!, maxAttempts: byPriority });
  } else if (item.kind === "event") {
    const eve = plannerMoment("eve_before", item, user)!;
    if (eve > now + EVE_MIN_LEAD_MS) rows.push({ kind: "eve_before", fireAt: eve, maxAttempts: 1 });
    rows.push({ kind: "leave_now", fireAt: leaveAt(due, item.travel_min), maxAttempts: MAX_ATTEMPTS_ESCALATING });
  } else {
    rows.push({ kind: "due", fireAt: due, maxAttempts: byPriority });
  }
  return rows.filter((r) => r.fireAt >= now - LATE_MS);
}

// Момент «час виходити» (S2.7.b/e): `due − (дорога + 15 хв)`. Єдине місце цієї формули — планувальник і відповідь `tr`.
export const leaveAt = (dueAt: number, travelMin: number | null): number => dueAt - ((travelMin ?? 0) + LEAVE_BUFFER_MIN) * MIN;

// Куди ставити `leave_now` після відповіді про дорогу (S2.7.b): мить уже позаду, а подія ще попереду → зараз
// (людина щойно сказала, що дорога дальша, і ще встигає); подія вже почалась → null (нічого не створюється).
export function leaveAfterAnswer(dueAt: number, travelMin: number, now: number): number | null {
  if (dueAt <= now) return null;
  return Math.max(leaveAt(dueAt, travelMin), now);
}

export interface RepeatSource {
  attempt: number;
  max_attempts: number;
  sent_at: number; // фактична відправка, не план (S2.2.d)
}

// Наступна спроба ланцюга (S2.2): 1→2 через 5 хв, 2→3 через 15, 3→4 через 30 від sent_at; після
// attempt = max_attempts — null (рівно 4, ніколи 5). Для leave_now (`eventDueAt`) спроба, що випала б після
// початку події, не створюється: повтор «час виходити» після початку — докір, не допомога (S2.2.e).
export function nextRepeat(row: RepeatSource, eventDueAt: number | null = null): { attempt: number; fireAt: number } | null {
  if (row.attempt < row.max_attempts) {
    const fireAt = row.sent_at + REPEAT_DELAYS_MIN[row.attempt - 1]! * MIN;
    if (eventDueAt !== null && fireAt > eventDueAt) return null;
    return { attempt: row.attempt + 1, fireAt };
  }
  return null;
}

// «Подія з часом» (рев'ю R-2, Б1) — ЄДИНА відповідь на це питання для повторів (`nextFor`), «після початку»
// (`leaveMoot`), часу в тексті повтору й анти-шуму (`noWait`). Подія `all_day` — не подія з часом: її `due_at` —
// локальна північ, нагадування — `due` о `morning_at`, і повтори в неї як у задачі (рівно `max_attempts`).
export const timedEvent = (item: { kind: string; all_day: number; due_at: number | null }): boolean =>
  item.kind === "event" && item.all_day === 0 && item.due_at !== null;

// «Час виходити» (leave_now) чи його повтор для події з часом, якщо подія вже почалась: докір, не допомога
// (S2.2.e). Перевіряється ПЕРЕД відправкою, бо тиша, анти-шум чи збій Telegram могли затримати рядок за `due_at`
// (живий прогін 2.2: повтор item 31 пішов о 08:01 при події 08:00). `repeat` події з часом — завжди ланцюг leave_now.
export function leaveMoot(r: { kind: string }, item: { kind: string; all_day: number; due_at: number | null }, now: number): boolean {
  if (r.kind !== "leave_now" && r.kind !== "repeat") return false;
  return timedEvent(item) && now >= item.due_at!;
}

export interface QuietUser {
  tz: string;
  quiet_from: number;
  quiet_to: number;
  pause_until: number | null;
}

// Найраніша мить ≥ fireAt, коли бот може говорити сам: поза паузою й поза тихими годинами за годинником `tz`
// (не UTC). Лише «коли можна слати» — fire_at рядка НЕ переписується (тиша — мовчання без боргу, S2.9).
// Тиша 23:00–08:00: 23:30 → 08:00 наступної локальної доби, 07:59 → 08:00 тієї ж; рівні межі — тиші немає.
export function shiftForQuiet(fireAt: number, user: QuietUser): number {
  const tz = user.tz;
  let t = fireAt;
  for (let i = 0; i < 4; i++) {
    let moved = false;
    if (user.pause_until !== null && user.pause_until > t) {
      t = user.pause_until;
      moved = true;
    }
    const minute = minutesOfDay(t, tz);
    if (inQuietHours(user.quiet_from, user.quiet_to, minute)) {
      const day = localDate(t, tz);
      // вікно через північ і ми в його вечірній частині → кінець тиші завтра; інакше — сьогодні
      const endDay = user.quiet_from > user.quiet_to && minute >= user.quiet_from ? shiftDate(day, 1) : day;
      let end = wallToUtc(endDay, user.quiet_to, tz);
      // осінній перехід: `localToUtc` бере перше входження подвійної години; якщо ми вже в другому — кінець тиші
      // вийшов би раніше за вхід. Тоді береться друге входження (+1 год), але не раніше за поточну мить (Д1 рев'ю 2.1).
      if (end <= t) end = Math.max(end + 3_600_000, t + 1);
      t = end;
      moved = true;
    }
    if (!moved) break;
  }
  return t;
}

// Найближча ЛОКАЛЬНА мить `minute` (хвилини доби) СТРОГО після `now`: «до ранку» = наступне `quiet_to` (S2.9.e).
// Доба — у `tz`, не в UTC; о 08:00:00 рівно «наступне 08:00» — завтра.
export function nextLocalMinute(now: number, minute: number, tz: string): number {
  const today = wallToUtc(localDate(now, tz), minute, tz);
  return today > now ? today : wallToUtc(shiftDate(localDate(now, tz), 1), minute, tz);
}

export type SnoozeAction = "s15" | "s60" | "tom";

// Куди ⏰ переносить нагадування (S2.4.e–g): +15 хв, +1 год або «завтра» = `morning_at` НАСТУПНОЇ ЛОКАЛЬНОЇ доби
// (о 00:30 суботи «завтра» — неділя, а не сьогодні о 09:00). Доба — у `tz`, не в UTC.
export function snoozeAt(action: SnoozeAction, now: number, user: PlanUser): number {
  if (action === "s15") return now + 15 * MIN;
  if (action === "s60") return now + 60 * MIN;
  return wallToUtc(shiftDate(localDate(now, user.tz), 1), user.morning_at, user.tz);
}

export interface BatchRow {
  id: number;
  fireAt: number;
  important: boolean;
  parentSentAs: "single" | "summary" | null; // як пішов батько повтору; null — не повтор
  noWait?: boolean; // ланцюг «час виходити» події з часом: ніколи не чекає (S2.6 п.1, виняток R-2 Б2)
}

export interface BatchCtx {
  now: number;
  singlesLastHour: number; // окремих пушів за ковзну годину
  summariesLastHour: number; // зведень за ковзну годину (різні tg_message_id)
}

export interface BatchPlan {
  singles: BatchRow[];
  summary: BatchRow[]; // порожній — зведення немає
  wait: BatchRow[]; // лишаються pending, спроба не витрачена
}

// Добір для одного користувача (S2.6, чиста функція). Рядки впорядковано: important перед normal, далі fire_at, id.
// 1) ≥ 2 «запізнілих» (fire_at ≤ now − LATE_MS) АБО ≥ 2 повторів, чий батько пішов зведенням → усе, що зараз у черзі,
//    одним зведенням (пуш слідом за зведенням — шум); зведення в останню годину вже було → усе чекає;
// 2) інакше окремо, поки не вичерпано PUSH_SINGLE_PER_HOUR; 3) що не влізло → одне зведення, якщо вікно вільне.
// Виняток (R-2, Б2): `noWait`-рядки замість «чекають» ідуть окремо (і рахуються в ліміт, бо стають `single`) —
// «час виходити», що дочекався початку події, гасне мовчки.
export function selectBatch(rows: BatchRow[], ctx: BatchCtx): BatchPlan {
  const p = selectBatchCore(rows, ctx);
  const go = p.wait.filter((r) => r.noWait === true);
  if (go.length === 0) return p;
  return { singles: [...p.singles, ...go], summary: p.summary, wait: p.wait.filter((r) => r.noWait !== true) };
}

function selectBatchCore(rows: BatchRow[], ctx: BatchCtx): BatchPlan {
  const sorted = [...rows].sort((a, b) => Number(b.important) - Number(a.important) || a.fireAt - b.fireAt || a.id - b.id);
  const summaryFree = ctx.summariesLastHour < PUSH_SUMMARY_PER_HOUR;
  const late = sorted.filter((r) => r.fireAt <= ctx.now - LATE_MS).length;
  const fromSummary = sorted.filter((r) => r.parentSentAs === "summary").length;
  if (late >= 2 || fromSummary >= 2) {
    return summaryFree ? { singles: [], summary: sorted, wait: [] } : { singles: [], summary: [], wait: sorted };
  }
  const room = Math.max(0, PUSH_SINGLE_PER_HOUR - ctx.singlesLastHour);
  const singles = sorted.slice(0, room);
  const rest = sorted.slice(room);
  if (rest.length === 0) return { singles, summary: [], wait: [] };
  return summaryFree ? { singles, summary: rest, wait: [] } : { singles, summary: [], wait: rest };
}
