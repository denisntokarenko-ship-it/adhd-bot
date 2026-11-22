// Варіанти й чисті правила /settings (docs/spec/phase-3-settings-prod.md, S3.7). Без БД і без «зараз».
import { DIGEST_TTL_MS } from "../digests/schedule";
import { QUIET_FROM_CHOICES, QUIET_TO_CHOICES } from "../quiet";
import { inQuietHours } from "../time";

export { parseTz } from "./tz";

export { QUIET_FROM_CHOICES, QUIET_TO_CHOICES };

const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let m = from; m <= to; m += step) out.push(m);
  return out;
};

export const MORNING_CHOICES: readonly number[] = range(6 * 60, 11 * 60 + 30, 30); // 06:00…11:30, 12 кнопок
export const EVENING_CHOICES: readonly number[] = range(18 * 60, 23 * 60 + 30, 30); // 18:00…23:30, 12 кнопок

// Пояси в кнопках: Київ + 4 найчастіші (`open-questions.md`, «Фаза 3»: припущення, чекає підтвердження людини).
// Решта — `/tz <IANA>`. Callback несе індекс, а не назву: `st:z:<i>` коротший за 64 байти за будь-якої назви.
export const TZ_CHOICES: readonly { tz: string; label: string }[] = [
  { tz: "Europe/Kyiv", label: "Київ" },
  { tz: "Europe/Warsaw", label: "Варшава" },
  { tz: "Europe/Berlin", label: "Берлін" },
  { tz: "Europe/London", label: "Лондон" },
  { tz: "America/New_York", label: "Нью-Йорк" },
];

export const tzLabel = (tz: string): string => {
  const c = TZ_CHOICES.find((x) => x.tz === tz);
  return c === undefined ? tz : `${c.label} (${tz})`;
};

export interface Quiet {
  quiet_from: number;
  quiet_to: number;
}

// Години, що не потрапляють у тихі години: у тих, що потрапляють, огляд не показується взагалі (рев'ю 3.1 В1, S3.7).
export const visibleChoices = (choices: readonly number[], q: Quiet): number[] => choices.filter((m) => !inQuietHours(q.quiet_from, q.quiet_to, m));

const TTL_MIN = DIGEST_TTL_MS / 60_000;

// Що буде з оглядом о `minute`, коли тиха ніч зачепила його годину. `undefined` — поза тишею, усе гаразд;
// `{ comes }` — прийде о кінці тиші (затримка менша за TTL); `{ comes: null }` — не прийде: о кінці тиші
// `now − fire_at ≥ TTL` і рядок мовчки скасується (S3.1). Рахуємо тим самим числом, що й диспетчер, — не вгадуємо (Д1 рев'ю 3.0).
export function digestPromise(minute: number, q: Quiet): { comes: number | null } | undefined {
  if (!inQuietHours(q.quiet_from, q.quiet_to, minute)) return undefined;
  const delay = (((q.quiet_to - minute) % 1440) + 1440) % 1440;
  return { comes: delay < TTL_MIN ? q.quiet_to : null };
}
