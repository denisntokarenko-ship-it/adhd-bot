// /settings і /tz (docs/spec/phase-3-settings-prod.md, S3.7–S3.8; крок 3.2). Одне повідомлення, що редагується:
// головний екран із поточними значеннями → розділ із кнопками → знову головний екран. Без ШІ й без стану між
// повідомленнями (`/tz <назва>` — команда, а не «чекаю назву»: decisions.md). Callback-и `st:…` (≤ 64 байти):
//   st:h  st:z  st:z:<i>  st:zo  st:q  st:qf:<від>  st:qt:<від>:<до>  st:qn  st:m  st:m:<хв>  st:e  st:e:<хв>  st:d  st:d:<1-7>
import type { Context } from "grammy";
import type { Clock } from "../clock";
import type { Db } from "../db/index";
import { applySetting, getSettings, type SettingsView } from "../db/settings";
import { setQuiet, type User } from "../db/users";
import { edit } from "../reminders/buttons";
import { hhmm, type Keyboard } from "../reminders/render";
import {
  BTN_BACK,
  BTN_QUIET_NONE,
  BTN_ST_DOW,
  BTN_ST_EVENING,
  BTN_ST_MORNING,
  BTN_ST_MOVE_EVENING,
  BTN_ST_MOVE_MORNING,
  BTN_ST_OTHER_TZ,
  BTN_ST_QUIET,
  BTN_ST_TZ,
  QUIET_FROM_ASK,
  QUIET_TO_ASK,
  SETTINGS_TITLE,
  ST_DOW_ASK,
  ST_DOW_NAMES,
  ST_DOW_SHORT,
  ST_EVENING_ASK,
  ST_LABEL_EVENING,
  ST_LABEL_MORNING,
  ST_LABEL_QUIET,
  ST_LABEL_TZ,
  ST_LABEL_WEEKLY,
  ST_MORNING_ASK,
  ST_QUIET_OFF,
  ST_TZ_ASK,
  ST_TZ_HINT,
  ST_TZ_OTHER,
  ST_TZ_SAME,
  ST_TZ_SET,
  ST_TZ_UNKNOWN,
  ST_WARN_COMES,
  ST_WARN_HINT,
  ST_WARN_NOT,
  ST_WHAT_EVENING,
  ST_WHAT_MORNING,
} from "../texts";
import {
  EVENING_CHOICES,
  MORNING_CHOICES,
  QUIET_FROM_CHOICES,
  QUIET_TO_CHOICES,
  TZ_CHOICES,
  digestPromise,
  parseTz,
  tzLabel,
  visibleChoices,
} from "./choices";

export interface SettingsDeps {
  db: Db;
  user: User;
  clock: Clock;
  rand: () => number;
}

const ST_RE =
  /^st:(?:h|z|zo|z:([0-4])|q|qn|qf:(1320|1380|0)|qt:(1320|1380|0):(420|480|540)|m|m:(\d{1,4})|e|e:(\d{1,4})|d|d:([1-7]))$/;

export const isSettingsCallback = (data: string | undefined) => data !== undefined && data.startsWith("st:");

const btn = (text: string, callback_data: string) => ({ text, callback_data });
const rows = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const quietValue = (s: SettingsView) => (s.quiet_from === s.quiet_to ? ST_QUIET_OFF : `${hhmm(s.quiet_from)}–${hhmm(s.quiet_to)}`);

interface Screen {
  text: string;
  keyboard: Keyboard;
}

// Попередження «огляд у тихих годинах» (S3.7, В1): рахується з поточних значень, а не зберігається — зникає саме, щойно
// години й тиша узгоджені. Тон — пропозиція, не докір.
function warnings(s: SettingsView): { lines: string[]; keyboard: Keyboard } {
  const lines: string[] = [];
  const keyboard: Keyboard = [];
  const add = (what: string, minute: number, move: string, cb: string) => {
    const p = digestPromise(minute, s);
    if (p === undefined) return;
    lines.push((p.comes === null ? ST_WARN_NOT : ST_WARN_COMES.replace("{t}", hhmm(p.comes))).replace("{what}", what));
    keyboard.push([btn(move, cb)]);
  };
  add(ST_WHAT_MORNING, s.morning_at, BTN_ST_MOVE_MORNING, "st:m");
  add(ST_WHAT_EVENING, s.evening_at, BTN_ST_MOVE_EVENING, "st:e");
  if (lines.length > 0) lines.push(ST_WARN_HINT);
  return { lines, keyboard };
}

export function homeScreen(s: SettingsView): Screen {
  const w = warnings(s);
  const text = [
    SETTINGS_TITLE,
    "",
    `${ST_LABEL_TZ}: ${tzLabel(s.tz)}`,
    `${ST_LABEL_QUIET}: ${quietValue(s)}`,
    `${ST_LABEL_MORNING}: ${hhmm(s.morning_at)}`,
    `${ST_LABEL_EVENING}: ${hhmm(s.evening_at)}`,
    `${ST_LABEL_WEEKLY}: ${ST_DOW_NAMES[s.weekly_dow - 1] ?? "?"}, ${hhmm(s.morning_at)}`,
    ...(w.lines.length > 0 ? ["", ...w.lines] : []),
  ].join("\n");
  const keyboard: Keyboard = [
    [btn(BTN_ST_TZ, "st:z"), btn(BTN_ST_QUIET, "st:q")],
    [btn(BTN_ST_MORNING, "st:m"), btn(BTN_ST_EVENING, "st:e")],
    [btn(BTN_ST_DOW, "st:d")],
    ...w.keyboard,
  ];
  return { text, keyboard };
}

const back = (): Keyboard[number] => [btn(BTN_BACK, "st:h")];

// Розділи: кожен — своє питання й кнопки; вибір значення повертає головний екран (в обробнику).
function sectionScreen(kind: "z" | "q" | "m" | "e" | "d", s: SettingsView): Screen {
  switch (kind) {
    case "z":
      return {
        text: ST_TZ_ASK,
        keyboard: [
          ...rows(TZ_CHOICES.map((c, i) => btn(c.tz === s.tz ? `✓ ${c.label}` : c.label, `st:z:${i}`)), 3),
          [btn(BTN_ST_OTHER_TZ, "st:zo")],
          back(),
        ],
      };
    case "q":
      return { text: QUIET_FROM_ASK, keyboard: [QUIET_FROM_CHOICES.map((m) => btn(hhmm(m), `st:qf:${m}`)), [btn(BTN_QUIET_NONE, "st:qn")], back()] };
    case "m":
      return { text: ST_MORNING_ASK, keyboard: [...rows(visibleChoices(MORNING_CHOICES, s).map((m) => btn(hhmm(m), `st:m:${m}`)), 4), back()] };
    case "e":
      return { text: ST_EVENING_ASK, keyboard: [...rows(visibleChoices(EVENING_CHOICES, s).map((m) => btn(hhmm(m), `st:e:${m}`)), 4), back()] };
    case "d":
      return { text: ST_DOW_ASK, keyboard: [...rows(ST_DOW_SHORT.map((n, i) => btn(i + 1 === s.weekly_dow ? `✓ ${n}` : n, `st:d:${i + 1}`)), 4), back()] };
  }
}

async function load(d: SettingsDeps): Promise<SettingsView> {
  const s = await getSettings(d.user.id, d.db);
  if (s === null) throw new Error("settings: user row missing");
  return s;
}

export async function handleSettings(ctx: Context, d: SettingsDeps): Promise<void> {
  const home = homeScreen(await load(d));
  await ctx.reply(home.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: home.keyboard } });
}

// /tz <назва>: `Intl` знає назву → зберігаємо й перепланувуємо (S3.8); інакше відмова, нічого не змінюється (3.7.c).
export async function handleTz(ctx: Context, d: SettingsDeps): Promise<void> {
  const arg = (ctx.message?.text ?? "").replace(/^\/tz(@\w+)?/, "").trim();
  const cur = await load(d);
  if (arg === "") {
    await ctx.reply(ST_TZ_HINT.replace("{tz}", tzLabel(cur.tz)));
    return;
  }
  const tz = parseTz(arg);
  if (tz === null) {
    await ctx.reply(ST_TZ_UNKNOWN);
    return;
  }
  const changed = await applySetting(d.user.id, d.db, { field: "tz", value: tz }, d.clock.now());
  await ctx.reply(changed ? ST_TZ_SET.replace("{tz}", tzLabel(tz)) : ST_TZ_SAME);
}

// Callback `st:`: кожна гілка перечитує налаштування натискача (його `user.id`, не з повідомлення — 3.7.e) і редагує те саме
// повідомлення. Невідомий чи застарілий `st:…` — головний екран без змін (3.7.j).
export async function handleSettingsCallback(ctx: Context, d: SettingsDeps): Promise<string | undefined> {
  const m = ST_RE.exec(ctx.callbackQuery?.data ?? "");
  const now = d.clock.now();
  const show = async (screen?: Screen) => {
    const s = screen ?? homeScreen(await load(d));
    await edit(ctx, s.text, s.keyboard);
  };
  if (m === null) {
    await show();
    return undefined;
  }
  const data = m[0];
  const id = d.user.id;
  const section = /^st:([zqmed])$/.exec(data);
  if (section !== null) {
    await show(sectionScreen(section[1] as "z" | "q" | "m" | "e" | "d", await load(d)));
    return undefined;
  }
  if (data === "st:zo") {
    await edit(ctx, ST_TZ_OTHER, [back()]);
    return undefined;
  }
  if (m[1] !== undefined) {
    const c = TZ_CHOICES[Number(m[1])];
    if (c !== undefined) await applySetting(id, d.db, { field: "tz", value: c.tz }, now);
  } else if (m[2] !== undefined) {
    const from = Number(m[2]);
    await edit(ctx, QUIET_TO_ASK, [QUIET_TO_CHOICES.map((t) => btn(hhmm(t), `st:qt:${from}:${t}`)), back()]);
    return undefined;
  } else if (m[3] !== undefined && m[4] !== undefined) {
    await setQuiet(id, Number(m[3]), Number(m[4]), d.db); // тиша не чіпає `pending` огляди (S3.1); попередження покаже головний екран
  } else if (data === "st:qn") {
    const s = await load(d);
    await setQuiet(id, s.quiet_to, s.quiet_to, d.db); // `from = to` — тихих годин немає
  } else if (m[5] !== undefined || m[6] !== undefined) {
    const morning = m[5] !== undefined;
    const minute = Number(morning ? m[5] : m[6]);
    const s = await load(d);
    const allowed = visibleChoices(morning ? MORNING_CHOICES : EVENING_CHOICES, s);
    if (!allowed.includes(minute)) {
      // застаріла кнопка (тиша змінилась після показу): нічого не міняємо, показуємо актуальні варіанти
      await show(sectionScreen(morning ? "m" : "e", s));
      return undefined;
    }
    await applySetting(id, d.db, { field: morning ? "morning_at" : "evening_at", value: minute }, now);
  } else if (m[7] !== undefined) {
    await applySetting(id, d.db, { field: "weekly_dow", value: Number(m[7]) }, now);
  }
  await show();
  return undefined;
}
