// Межі доби в часовому поясі користувача (НФ-1). Єдине місце, де «доба» перетворюється на UTC-діапазон:
// код не рахує добу через Date#getHours() Worker-а й не бере UTC-дату. `localToUtc` додасть крок 1.3.

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
