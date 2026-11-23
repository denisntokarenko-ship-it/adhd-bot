// Тексти й кнопки рутин (docs/spec/phase-4.md, S4.2, S4.5, S4.7, S4.8–S4.9). Чисті функції, без БД.
// Назва людини екранується й обрізається (НФ-9). callback_data ≤ 64 байти: `rt:<reminderId>:ok|skip|s15` (пуш),
// `rw:…` (крок майстра), `rl:…:<routineId>` (список і картка). Власника бере handler з того, хто натиснув.
import { clipTitle, type Keyboard } from "../reminders/render";
import {
  BTN_RL_DAYS,
  BTN_RL_LIST,
  BTN_RL_PAUSE,
  BTN_RL_RESUME,
  BTN_RL_TIME,
  BTN_RL_TITLE,
  BTN_RT_DONE,
  BTN_RT_LATER,
  BTN_RT_SKIP,
  BTN_RT_TAKEN,
  BTN_RW_CANCEL,
  BTN_RW_EVERY,
  BTN_RW_HABIT,
  BTN_RW_MED,
  BTN_RW_MORE_TIME,
  BTN_RW_NEXT,
  BTN_RW_SAVE,
  BTN_RW_WEEKDAYS,
  DIGEST_ROUTINES_ALL,
  DIGEST_ROUTINES_EVENING,
  DIGEST_ROUTINES_TODAY,
  MORE_PREFIX,
  ROUTINE_HABIT_POOL,
  ROUTINE_MED_POOL,
  ROUTINE_REPEAT_POOL,
  RW_DAY_NAMES,
  RW_EVERY_DAY,
  RW_WEEKDAYS_LABEL,
} from "../texts";
import { ALL_DAYS, MORNING_ROUTINES, TIMES_MAX, WEEKDAYS, type RoutineKind } from "./schedule";

export const emojiOf = (kind: RoutineKind) => (kind === "med" ? "💊" : "🔁");

// Пул пушу: корінь — свій для `med`/`habit`; повтор — м'якший спільний пул (4.5, без «ти не відповів»).
export const pushPool = (kind: RoutineKind, attempt: number): readonly string[] =>
  attempt > 1 ? ROUTINE_REPEAT_POOL : kind === "med" ? ROUTINE_MED_POOL : ROUTINE_HABIT_POOL;

export function pushMessage(kind: RoutineKind, title: string, reminderId: number, attempt: number, variantIdx: number): { text: string; keyboard: Keyboard } {
  const pool = pushPool(kind, attempt);
  const head = pool[variantIdx] ?? pool[0] ?? "";
  return {
    text: head.replace("{e}", emojiOf(kind)).replace("{t}", clipTitle(title)),
    keyboard: [
      [
        { text: kind === "med" ? BTN_RT_TAKEN : BTN_RT_DONE, callback_data: `rt:${reminderId}:ok` },
        { text: BTN_RT_SKIP, callback_data: `rt:${reminderId}:skip` },
        { text: BTN_RT_LATER, callback_data: `rt:${reminderId}:s15` },
      ],
    ],
  };
}

// «щодня» / «будні» / «Пн, Ср, Пт».
export function daysLabel(mask: number): string {
  if (mask === ALL_DAYS) return RW_EVERY_DAY;
  if (mask === WEEKDAYS) return RW_WEEKDAYS_LABEL;
  return RW_DAY_NAMES.filter((_, i) => (mask & (1 << i)) !== 0).join(", ");
}

export interface RoutineView {
  kind: RoutineKind;
  title: string;
  times: readonly string[];
  days_mask: number;
  active: boolean;
}

// «💊 Вітамін D · 08:00, 20:00 · щодня» (4.2.e, 4.7.a); на паузі — «⏸ …».
export const routineLine = (r: RoutineView) =>
  `${r.active ? "" : "⏸ "}${emojiOf(r.kind)} ${clipTitle(r.title)} · ${r.times.join(", ")} · ${daysLabel(r.days_mask)}`;

const cancelRow = (): Keyboard[number] => [{ text: BTN_RW_CANCEL, callback_data: "rw:x" }];
const z2 = (n: number) => String(n).padStart(2, "0");

export const kindRow = (): Keyboard[number] => [
  { text: BTN_RW_MED, callback_data: "rw:new:med" },
  { text: BTN_RW_HABIT, callback_data: "rw:new:habit" },
];

// Список `/routines` (4.7.a): кнопка на кожну рутину → картка; знизу ➕ ліки / звичка.
export const listKeyboard = (rs: { id: number; kind: RoutineKind; title: string; active: boolean }[]): Keyboard => [
  ...rs.map((r) => [{ text: `${r.active ? "" : "⏸ "}${emojiOf(r.kind)} ${Array.from(r.title).slice(0, 30).join("")}`, callback_data: `rl:o:${r.id}` }]),
  kindRow(),
];

export const cardKeyboard = (id: number, active: boolean): Keyboard => [
  [
    { text: BTN_RL_TIME, callback_data: `rl:t:${id}` },
    { text: BTN_RL_DAYS, callback_data: `rl:d:${id}` },
    { text: BTN_RL_TITLE, callback_data: `rl:n:${id}` },
  ],
  [active ? { text: BTN_RL_PAUSE, callback_data: `rl:p:${id}` } : { text: BTN_RL_RESUME, callback_data: `rl:r:${id}` }, { text: BTN_RL_LIST, callback_data: "rl:l" }],
];

export const titleKeyboard = (): Keyboard => [cancelRow()];

// Сітка годин 00–23: 6 × 4 (4.2.b).
export const hoursKeyboard = (): Keyboard => [
  ...Array.from({ length: 4 }, (_, row) => Array.from({ length: 6 }, (_, col) => ({ text: z2(row * 6 + col), callback_data: `rw:h:${z2(row * 6 + col)}` }))),
  cancelRow(),
];

// Рядок хвилин :00 :15 :30 :45 (4.2.c).
export const minutesKeyboard = (hour: string): Keyboard => [
  ["00", "15", "30", "45"].map((m) => ({ text: `${hour}:${m}`, callback_data: `rw:m:${hour}${m}` })),
  cancelRow(),
];

// «Час: 08:00, 20:00 · [➕ ще час] [Далі →]»; на 6-му часі ➕ зникає.
export const timesKeyboard = (count: number): Keyboard => [
  [...(count < TIMES_MAX ? [{ text: BTN_RW_MORE_TIME, callback_data: "rw:more" }] : []), ...(count > 0 ? [{ text: BTN_RW_NEXT, callback_data: "rw:next" }] : [])],
  cancelRow(),
];

// 7 перемикачів Пн…Нд + [Щодня] [Будні] + [Далі →] (4.2.d).
export const daysKeyboard = (mask: number): Keyboard => [
  RW_DAY_NAMES.slice(0, 4).map((n, i) => ({ text: (mask & (1 << i)) !== 0 ? `✓ ${n}` : n, callback_data: `rw:d:${i}` })),
  RW_DAY_NAMES.slice(4).map((n, j) => ({ text: (mask & (1 << (j + 4))) !== 0 ? `✓ ${n}` : n, callback_data: `rw:d:${j + 4}` })),
  [
    { text: BTN_RW_EVERY, callback_data: "rw:dall" },
    { text: BTN_RW_WEEKDAYS, callback_data: "rw:dwk" },
  ],
  [{ text: BTN_RW_NEXT, callback_data: "rw:next" }],
  cancelRow(),
];

export const confirmKeyboard = (): Keyboard => [
  [
    { text: BTN_RW_SAVE, callback_data: "rw:save" },
    { text: "✖", callback_data: "rw:x" },
  ],
];

export interface MorningRoutine {
  kind: RoutineKind;
  title: string;
  slots: { at: string; taken: boolean }[]; // локальний "HH:MM" слота; `✓` — лише `taken` (4.8.a)
}

// Ранок (S4.8): один рядок «💊 Сьогодні: Вітамін D 08:00 ✓, 20:00 · 🔁 Прогулянка 19:00»; понад 5 — «…ще N».
// `missed`/`skipped` не позначаються ніяк. Порядок — за першим часом (сортує викликач). Без рутин — null.
export function morningRoutinesLine(rs: readonly MorningRoutine[]): string | null {
  if (rs.length === 0) return null;
  const parts = rs.slice(0, MORNING_ROUTINES).map((r, i) => {
    const at = r.slots.map((s) => (s.taken ? `${s.at} ✓` : s.at)).join(", ");
    return `${emojiOf(r.kind)} ${i === 0 ? `${DIGEST_ROUTINES_TODAY} ` : ""}${clipTitle(r.title)} ${at}`;
  });
  if (rs.length > MORNING_ROUTINES) parts.push(`${MORE_PREFIX} ${rs.length - MORNING_ROUTINES}`);
  return parts.join(" · ");
}

// Вечір (S4.9): «💊 рутини: N з M ✅» / «усі ✅»; N = 0 → null (жодного «0 з 3»). Назви не перелічуються.
export function eveningRoutinesLine(taken: number, total: number): string | null {
  if (taken <= 0) return null;
  if (taken >= total) return DIGEST_ROUTINES_ALL;
  return DIGEST_ROUTINES_EVENING.replace("{n}", String(taken)).replace("{m}", String(total));
}
