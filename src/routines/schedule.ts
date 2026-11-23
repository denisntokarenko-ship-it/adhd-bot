// Розклад рутин (docs/spec/phase-4.md, «Константи», S4.4): чисті функції, без БД.
// Час — лише через `localToUtc` / `localIso` (НФ-1): ні Date#getHours(), ні UTC-дата як «сьогодні».
import { LATE_MS, MAX_ATTEMPTS_ESCALATING } from "../reminders/plan";
import { localIso, localToUtc } from "../time";

export const ROUTINES_MAX = 20; // рутин на користувача (з паузою включно)
export const TIMES_MAX = 6; // часів на рутину
export const TITLE_MAX = 64; // символів у назві, один рядок
export const ALL_DAYS = 127; // days_mask: біт 0 = понеділок … біт 6 = неділя
export const WEEKDAYS = 31; // Пн–Пт
export const MISSED_AFTER_MS = 30 * 60_000; // після останньої відправки вичерпаного ланцюга без відповіді — `missed`
export const WIZARD_TTL_MS = 15 * 60_000; // чернетка майстра мертва після цього; текст — звичайний запис (S4.3)
export const ROUTINE_TTL_MS = 3 * 3_600_000; // рядок рутини, що не пішов за 3 год після `fire_at`, мовчки `cancelled` (S4.5.h)
export const ROUTINE_SNOOZE_MIN = 15; // кнопка «+15 хв» (4.5.e)
export const MORNING_ROUTINES = 5; // рутин у рядку ранку, далі «…ще N» (4.8.b)

export type RoutineKind = "med" | "habit";

export interface RoutineSchedule {
  times: readonly string[]; // "HH:MM", відсортовані, без повторів
  days_mask: number;
}

const DAY_MS = 86_400_000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const pad = (n: number) => String(n).padStart(2, "0");
// Календарна дата "YYYY-MM-DD" як UTC-північ — лише для арифметики дат без пояса.
const dateMs = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const dateKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
// ISO-день тижня календарної дати: 1 = понеділок … 7 = неділя.
const isoDow = (dayMs: number) => new Date(dayMs).getUTCDay() || 7;

export const dayBit = (isoDowValue: number) => 1 << (isoDowValue - 1);

// Назва рутини: 1..64 символи (кодові точки, як `length()` у SQLite), без переносу рядка. Обрізання — справа майстра.
export function validTitle(title: string): boolean {
  const n = [...title].length;
  return n >= 1 && n <= TITLE_MAX && !/[\r\n]/.test(title);
}

// Часи → відсортовані без повторів; null — порожньо, понад 6 або хоч один не "HH:MM".
export function normalizeTimes(times: readonly string[]): string[] | null {
  if (!times.every((t) => TIME_RE.test(t))) return null;
  const out = [...new Set(times)].sort();
  return out.length >= 1 && out.length <= TIMES_MAX ? out : null;
}

// Спроб у ланцюгу слота: ліки (escalate) — 5→15→30 до відповіді, звичка — одна.
export const maxAttemptsFor = (escalate: boolean) => (escalate ? MAX_ATTEMPTS_ESCALATING : 1);

// Слоти рутини на локальну дату `date` ("YYYY-MM-DD") у `tz`, за зростанням. День не в `days_mask` → [].
// Неіснуюча година (весняний перехід) зсувається вперед, подвійна — перше входження (`localToUtc`, НФ-1);
// два часи, що зійшлись в одну мить (03:30 і 04:30 на 2026-03-29), — один слот.
export function slotsOfDay(r: RoutineSchedule, date: string, tz: string): number[] {
  if ((r.days_mask & dayBit(isoDow(dateMs(date)))) === 0) return [];
  const out = new Set<number>();
  for (const t of r.times) {
    const at = localToUtc(`${date}T${t}`, tz);
    if (at !== null) out.add(at);
  }
  return [...out].sort((a, b) => a - b);
}

// Найближчий слот `slot_at ≥ now − LATE_MS` (S4.4): слот, що настав щойно (≤ 5 хв), ще планується (4.4.d).
// 8 локальних дат вистачає завжди: у будь-якому тижні є кожен день маски.
export function nextRoutineSlot(r: RoutineSchedule, tz: string, now: number): number {
  const from = now - LATE_MS;
  let day = dateMs(localIso(from, tz).slice(0, 10));
  for (let i = 0; i < 8; i++, day += DAY_MS) {
    for (const at of slotsOfDay(r, dateKey(day), tz)) if (at >= from) return at;
  }
  throw new Error("nextRoutineSlot: no slot within 8 days"); // недосяжно при days_mask 1..127 і непорожніх times
}
