// Межі доби в часовому поясі користувача (НФ-1). Єдине місце, де «доба» перетворюється на UTC-діапазон:
// код не рахує добу через Date#getHours() Worker-а й не бере UTC-дату.

const MS_PER_DAY = 86_400_000;

interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function localParts(ms: number, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { y: out.year!, m: out.month!, d: out.day!, h: out.hour!, mi: out.minute!, s: out.second! };
}

// Зсув пояса від UTC в мс у даний момент (Київ: +2 год взимку, +3 влітку).
function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// UTC-момент локальної півночі дати y-m-d: два наближення, бо зсув залежить від самого моменту.
function localMidnight(y: number, m: number, d: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - offsetAt(wall, tz);
  return wall - offsetAt(first, tz);
}

// [startMs, endMs) локальної доби, що містить `instant`. Доба може мати 23 або 25 годин.
export function dayBounds(tz: string, instant: number): [number, number] {
  const p = localParts(instant, tz);
  const start = localMidnight(p.y, p.m, p.d, tz);
  // «Наступна дата» — календарна арифметика на UTC-полі (без пояса), потім назад у момент.
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d) + MS_PER_DAY);
  const end = localMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz);
  return [start, end];
}

// Локальна «стінна» година `instant` у `tz` як "YYYY-MM-DDTHH:mm" — формат `due_local` (НФ-1, 1.3.f).
// Береться з Intl, а не з Date#getHours() і не з UTC-дати: о 00:30 за Києвом UTC-дата ще вчорашня.
export function localIso(instant: number, tz: string): string {
  const p = localParts(instant, tz);
  const z = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${z(p.y, 4)}-${z(p.m)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
}

// День тижня українською («субота») за годинником `tz`.
export function weekdayName(instant: number, tz: string): string {
  return new Intl.DateTimeFormat("uk-UA", { timeZone: tz, weekday: "long" }).format(new Date(instant));
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

// "YYYY-MM-DDTHH:mm" або "YYYY-MM-DD" (тоді — початок локальної доби) → UTC мс; усе інше → null.
// Літній час (НФ-1): неіснуюча година (весняний «стрибок») зсувається вперед — береться зсув ДО переходу;
// подвійна година (осіння) — перше, раніше входження. Зсув у рядку («…Z», «+02:00») — не локальний час → null.
export function localToUtc(local: string, tz: string): number | null {
  const m = LOCAL_RE.exec(local);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = m[4] === undefined ? 0 : Number(m[4]);
  const mi = m[5] === undefined ? 0 : Number(m[5]);
  if (h > 23 || mi > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  // Date.UTC «перекручує» неіснуючі дати (30 лютого → 2 березня): звіряємо поля.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const before = offsetAt(wall - MS_PER_DAY, tz);
  const after = offsetAt(wall + MS_PER_DAY, tz);
  const candidates = [...new Set([before, after])].map((o) => wall - o).filter((c) => offsetAt(c, tz) === wall - c);
  if (candidates.length === 0) return wall - before; // «діра» весняного переходу
  return Math.min(...candidates); // подвійна година → раніше входження
}
