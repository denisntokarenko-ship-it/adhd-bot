// Розклад оглядів (docs/spec/phase-3.md, S3.1): константи й `nextDigestAt` — чиста функція, без БД.
// Час — лише через `dayBounds` / `localToUtc` / `localIso` (НФ-1): ні Date#getHours(), ні UTC-дата.
import { dayBounds, localIso, localToUtc } from "../time";

export const MORNING_TASKS = 3; // справ у ранковому огляді, решта — «показати все»
export const WARM_EVERY_DAYS = 3; // тепла фраза порожнього ранку — не частіше ніж раз на 3 локальні доби
export const HANGING_TITLES = 3; // назв у «ще висить: …»
export const STUCK_DAYS = 7; // «зависле»: старше 7 діб
export const WEEKLY_ITEMS = 5; // записів у тижневому огляді
export const DIGEST_TTL_MS = 3 * 3_600_000; // огляд, що не пішов за 3 год після fire_at, мовчки cancelled
export const ALL_LIMIT = 200; // стеля запиту «показати все»; довше за 4096 — «…ще N»

export type DigestKind = "digest_morning" | "digest_evening" | "digest_weekly";
// Порядок у тику (S3.1, «Відправка»): ранок → тиждень → вечір.
export const DIGEST_ORDER: readonly DigestKind[] = ["digest_morning", "digest_weekly", "digest_evening"];
export const isDigestKind = (k: string): k is DigestKind => (DIGEST_ORDER as readonly string[]).includes(k);

export interface DigestSettings {
  tz: string;
  morning_at: number;
  evening_at: number;
  weekly_dow: number; // ISO: 1 = понеділок … 7 = неділя
}

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const dateKey = (ms: number) => `${new Date(ms).getUTCFullYear()}-${pad(new Date(ms).getUTCMonth() + 1)}-${pad(new Date(ms).getUTCDate())}`;
const isoDow = (dateMs: number) => new Date(dateMs).getUTCDay() || 7;
// Календарна дата "YYYY-MM-DD" як UTC-північ — лише для арифметики дат без пояса.
const dateMs = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));

// Скільки локальних діб від `from` до `to` у `tz` (за календарними датами, а не за 24-годинними відрізками).
export function localDayDiff(tz: string, from: number, to: number): number {
  return Math.round((dateMs(localIso(to, tz).slice(0, 10)) - dateMs(localIso(from, tz).slice(0, 10))) / DAY_MS);
}

// Найменша мить, чий локальний час у `tz` = година огляду (для тижня — ще й потрібний день тижня), яка
// (а) строго пізніша за `now` і (б) не раніша за межу — кінець локальної доби останнього `sent` того ж виду
// (для тижня — ще 6 локальних дат пізніше). Межа — в ПОТОЧНОМУ `tz` (рев'ю 3.0 В1): зміна години чи поясу
// не дає другого огляду тієї ж доби. `lastSentFireAt` — `fire_at` останнього `sent` рядка цього виду; нема — межі нема.
export function nextDigestAt(kind: DigestKind, u: DigestSettings, now: number, lastSentFireAt: number | null): number {
  const minute = kind === "digest_evening" ? u.evening_at : u.morning_at;
  let limit = Number.NEGATIVE_INFINITY;
  if (lastSentFireAt !== null) {
    const end = dayBounds(u.tz, lastSentFireAt)[1]; // початок наступної локальної доби
    if (kind === "digest_weekly") {
      const next = dateMs(localIso(end, u.tz).slice(0, 10)) + 6 * DAY_MS; // зсув дати, не 6×24 год
      limit = localToUtc(dateKey(next), u.tz) ?? end + 6 * DAY_MS;
    } else limit = end;
  }
  let day = dateMs(localIso(Math.max(now, Number.isFinite(limit) ? limit : now), u.tz).slice(0, 10));
  for (let i = 0; i < 16; i++, day += DAY_MS) {
    if (kind === "digest_weekly" && isoDow(day) !== u.weekly_dow) continue;
    const at = localToUtc(`${dateKey(day)}T${hhmm(minute)}`, u.tz);
    if (at !== null && at > now && at >= limit) return at;
  }
  throw new Error("nextDigestAt: no slot within 16 days"); // недосяжно: у будь-якому 16-добовому вікні є кожен день тижня
}
