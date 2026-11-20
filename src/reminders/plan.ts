// Чисті функції черги нагадувань (docs/spec/phase-2.md, «Константи», «Звідки береться нагадування», S2.2).
// Без БД і без «зараз» усередині: усе в UTC ms, локальна доба — лише через `localToUtc`/`localIso` у `tz` (НФ-1).
import { inQuietHours, localIso, localToUtc, minutesOfDay } from "../time";

const MIN = 60_000;

export const REPEAT_DELAYS_MIN = [5, 15, 30] as const; // пауза після спроби 1, 2, 3 — від фактичної відправки
export const MAX_ATTEMPTS_ESCALATING = 4; // important і leave_now
export const LATE_MS = 5 * MIN; // «запізніле»: fire_at ≤ now − LATE_MS
export const LEASE_MS = 120_000; // оренда рядка під час відправки
export const CLAIM_LIMIT = 50; // рядків за прогін на всіх
export const PLAN_LIMIT = 50; // записів за тик планувальника
export const EVE_AT_MIN = 20 * 60; // «навечір» — 20:00 попереднього дня
export const EVE_MIN_LEAD_MS = 5 * MIN; // eve_before лише якщо ще попереду більш ніж на 5 хв
export const LEAVE_BUFFER_MIN = 15; // leave_now = due − travel − 15 хв

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

// Які корені нагадувань випливають із запису (таблиця «Звідки береться нагадування»). Рядки «у минулому»
// (fire_at < now − LATE_MS) не створюються; eve_before — лише якщо 20:00 напередодні ще попереду (> now + 5 хв).
// Подія не стає important: priority не змінюється, а leave_now ескалюється завжди; eve_before — один раз.
export function plannedFor(item: PlanItem, now: number, user: PlanUser): PlannedRow[] {
  if (item.status !== "open" || item.due_at === null) return [];
  const due = item.due_at;
  const byPriority = item.priority === "important" ? MAX_ATTEMPTS_ESCALATING : 1;
  const rows: PlannedRow[] = [];
  if (item.all_day === 1) {
    rows.push({ kind: "due", fireAt: wallToUtc(localDate(due, user.tz), user.morning_at, user.tz), maxAttempts: byPriority });
  } else if (item.kind === "event") {
    const eve = wallToUtc(shiftDate(localDate(due, user.tz), -1), EVE_AT_MIN, user.tz);
    if (eve > now + EVE_MIN_LEAD_MS) rows.push({ kind: "eve_before", fireAt: eve, maxAttempts: 1 });
    const leave = due - ((item.travel_min ?? 0) + LEAVE_BUFFER_MIN) * MIN;
    rows.push({ kind: "leave_now", fireAt: leave, maxAttempts: MAX_ATTEMPTS_ESCALATING });
  } else {
    rows.push({ kind: "due", fireAt: due, maxAttempts: byPriority });
  }
  return rows.filter((r) => r.fireAt >= now - LATE_MS);
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
