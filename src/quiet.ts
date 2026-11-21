// /pause, /resume, /quiet (docs/spec/phase-2-dates-texts.md, S2.9.e–g і S2.11). Без ШІ. Тиша — мовчання без боргу:
// `fire_at` рядків не переписується, відправка просто не бере користувача в тиші (`listQuietUserIds` у cron), а після
// тиші все назбирене йде одним зведенням (S2.6 п.1). Callback-и без стану: `pz:<хв>|m`, `qt:f:<хв>`, `qt:t:<від>:<до>`, `qt:n`.
import type { Context } from "grammy";
import type { Clock } from "./clock";
import type { Db } from "./db/index";
import { getQuiet, setPause, setQuiet, type User } from "./db/users";
import { formatDue } from "./format";
import { PAUSE_MAX_H, nextLocalMinute, shiftForQuiet } from "./reminders/plan";
import { edit, pickAck } from "./reminders/buttons";
import { hhmm, type Keyboard } from "./reminders/render";
import {
  ACK_PAUSE_POOL,
  ACK_RESUME_POOL,
  BTN_PAUSE_1H,
  BTN_PAUSE_2H,
  BTN_PAUSE_4H,
  BTN_PAUSE_MORNING,
  BTN_QUIET_NONE,
  NO_PAUSE,
  PAUSE_ASK,
  PAUSE_HINT,
  QUIET_FROM_ASK,
  QUIET_NONE,
  QUIET_SET,
  QUIET_TO_ASK,
} from "./texts";
import { localIso } from "./time";

export interface QuietDeps {
  db: Db;
  user: User;
  clock: Clock;
  rand: () => number;
}

const HOUR = 3_600_000;
export const QUIET_FROM_CHOICES = [1320, 1380, 0] as const; // 22:00 · 23:00 · 00:00
export const QUIET_TO_CHOICES = [420, 480, 540] as const; // 07:00 · 08:00 · 09:00
const PZ_RE = /^pz:(60|120|240|m)$/;
const QT_RE = /^qt:(?:f:(1320|1380|0)|t:(1320|1380|0):(420|480|540)|(n))$/;

export const isQuietCallback = (data: string | undefined) => data !== undefined && (PZ_RE.test(data) || QT_RE.test(data));

// «16:00» — якщо та сама локальна доба; «завтра 08:00» — наступна; далі — повна форма.
function untilLabel(at: number, now: number, tz: string): string {
  const t = localIso(at, tz);
  const c = localIso(now, tz);
  if (t.slice(0, 10) === c.slice(0, 10)) return t.slice(11, 16);
  return formatDue(at, false, tz, now).replace(/, \S+ \d\d\.\d\d, /, " ");
}

const pauseKeyboard = (): Keyboard => [
  [
    { text: BTN_PAUSE_1H, callback_data: "pz:60" },
    { text: BTN_PAUSE_2H, callback_data: "pz:120" },
    { text: BTN_PAUSE_4H, callback_data: "pz:240" },
    { text: BTN_PAUSE_MORNING, callback_data: "pz:m" },
  ],
];

// Ставить паузу й будує відповідь. Час у відповіді — коли бот справді заговорить: якщо пауза закінчується в тихі
// години, діє довша з двох (S2.9.g), тож показуємо кінець тихих годин, а не `pause_until`.
async function applyPause(d: QuietDeps, until: number): Promise<string> {
  const q = await getQuiet(d.user.id, d.db);
  await setPause(d.user.id, until, d.db);
  const now = d.clock.now();
  const tz = q?.tz ?? d.user.tz;
  const effective = q === null ? until : shiftForQuiet(until, { ...q, pause_until: null });
  const head = await pickAck(d, "pause", ACK_PAUSE_POOL);
  return head.replace("{t}", untilLabel(effective, now, tz));
}

// /pause: без аргументів — кнопки; `/pause N` (ціле 1–24 год) — одразу. Поза діапазоном чи не число — підказка без змін.
export async function handlePause(ctx: Context, d: QuietDeps): Promise<void> {
  const arg = (ctx.message?.text ?? "").replace(/^\/pause(@\w+)?/, "").trim();
  if (arg === "") {
    await ctx.reply(PAUSE_ASK, { reply_markup: { inline_keyboard: pauseKeyboard() } });
    return;
  }
  const n = /^\d{1,3}$/.test(arg) ? Number(arg) : 0;
  if (n < 1 || n > PAUSE_MAX_H) {
    await ctx.reply(PAUSE_HINT);
    return;
  }
  await ctx.reply(await applyPause(d, d.clock.now() + n * HOUR));
}

// /resume: знімає паузу. Накопичене піде найближчим тиком — одним зведенням, якщо запізнілих ≥ 2 (S2.6 п.1).
export async function handleResume(ctx: Context, d: QuietDeps): Promise<void> {
  const q = await getQuiet(d.user.id, d.db);
  if (q === null || q.pause_until === null || q.pause_until <= d.clock.now()) {
    await ctx.reply(NO_PAUSE);
    return;
  }
  await setPause(d.user.id, null, d.db);
  await ctx.reply(await pickAck(d, "resume", ACK_RESUME_POOL));
}

export async function handleQuiet(ctx: Context): Promise<void> {
  const row = [...QUIET_FROM_CHOICES].map((m) => ({ text: hhmm(m), callback_data: `qt:f:${m}` }));
  await ctx.reply(QUIET_FROM_ASK, { reply_markup: { inline_keyboard: [row, [{ text: BTN_QUIET_NONE, callback_data: "qt:n" }]] } });
}

// Відповідь на callback змінює те саме повідомлення (кнопки зникають): повторний тап по старій клавіатурі безпечний —
// `pz:` ставить паузу наново, `qt:` лише переписує два числа.
export async function handleQuietCallback(ctx: Context, d: QuietDeps): Promise<string | undefined> {
  const data = ctx.callbackQuery?.data ?? "";
  const pz = PZ_RE.exec(data);
  if (pz !== null) {
    const now = d.clock.now();
    let until = now + Number(pz[1]) * 60_000;
    if (pz[1] === "m") {
      const q = await getQuiet(d.user.id, d.db);
      until = nextLocalMinute(now, q?.quiet_to ?? 480, q?.tz ?? d.user.tz);
    }
    await edit(ctx, await applyPause(d, until));
    return undefined;
  }
  const qt = QT_RE.exec(data);
  if (qt === null) return undefined;
  if (qt[1] !== undefined) {
    const from = Number(qt[1]);
    const row = [...QUIET_TO_CHOICES].map((m) => ({ text: hhmm(m), callback_data: `qt:t:${from}:${m}` }));
    await edit(ctx, QUIET_TO_ASK, [row]);
    return undefined;
  }
  if (qt[2] !== undefined && qt[3] !== undefined) {
    const [from, to] = [Number(qt[2]), Number(qt[3])];
    await setQuiet(d.user.id, from, to, d.db);
    await edit(ctx, QUIET_SET.replace("{w}", `${hhmm(from)}–${hhmm(to)}`));
    return undefined;
  }
  // «без тихих годин»: `quiet_from = quiet_to` (рівні — тихих годин немає)
  const q = await getQuiet(d.user.id, d.db);
  await setQuiet(d.user.id, q?.quiet_to ?? 480, q?.quiet_to ?? 480, d.db);
  await edit(ctx, QUIET_NONE);
  return undefined;
}
