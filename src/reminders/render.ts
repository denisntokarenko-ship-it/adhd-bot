// Показ нагадувань: тексти й клавіатури (S2.3.a, S2.4.d, S2.6.b). Чисті функції, без БД. Назва записів екранується
// (НФ-9) і обрізається до 80 символів; callback-дані — `rm:<id>:<дія>` / `sm:<message_id>:<дія>` (≤ 64 байти).
import { escapeHtml, formatDue, TG_LIMIT } from "../format";
import {
  BTN_ACK,
  BTN_ALL_S60,
  BTN_ALL_TOM,
  BTN_BACK,
  BTN_DONE,
  BTN_MORE_PREFIX,
  BTN_RELEASE,
  BTN_S15,
  BTN_S60,
  BTN_TRAVEL_SUFFIX,
  BTN_SNOOZE,
  BTN_TOMORROW_PREFIX,
  MORE_PREFIX,
  REMIND_DUE_POOL,
  REMIND_EVE_POOL,
  REMIND_LEAVE_POOL,
  REMIND_REPEAT2_POOL,
  REMIND_REPEAT3_POOL,
  REMIND_REPEAT4_POOL,
} from "../texts";
import { SUMMARY_LINES, TRAVEL_CHOICES } from "./plan";

export const TITLE_MAX = 80;
export interface Button {
  text: string;
  callback_data: string;
}
export type Keyboard = Button[][];

export const clipTitle = (t: string) => escapeHtml(Array.from(t).length > TITLE_MAX ? `${Array.from(t).slice(0, TITLE_MAX - 1).join("")}…` : t);

const z2 = (n: number) => String(n).padStart(2, "0");
export const hhmm = (minutes: number) => `${z2(Math.floor(minutes / 60))}:${z2(minutes % 60)}`;

export interface PoolChoice {
  pool: readonly string[];
  kinds: string[]; // за якими `kind` шукати попередній варіант цього пулу
  attempt: number | null;
}

// Пул тексту за видом нагадування й спробою: `repeat` — наростаюча наполегливість за номером спроби (S2.10.a).
export function poolFor(kind: string, attempt: number): PoolChoice {
  if (kind === "repeat") {
    const pool = attempt >= 4 ? REMIND_REPEAT4_POOL : attempt === 3 ? REMIND_REPEAT3_POOL : REMIND_REPEAT2_POOL;
    return { pool, kinds: ["repeat"], attempt: Math.min(Math.max(attempt, 2), 4) };
  }
  if (kind === "eve_before") return { pool: REMIND_EVE_POOL, kinds: ["eve_before"], attempt: null };
  if (kind === "leave_now") return { pool: REMIND_LEAVE_POOL, kinds: ["leave_now"], attempt: null };
  return { pool: REMIND_DUE_POOL, kinds: ["due"], attempt: null };
}

export function mainKeyboard(id: number, kind: string): Keyboard {
  const first = kind === "eve_before" ? { text: BTN_ACK, callback_data: `rm:${id}:ack` } : { text: BTN_DONE, callback_data: `rm:${id}:ok` };
  return [[first, { text: BTN_SNOOZE, callback_data: `rm:${id}:later` }, { text: BTN_RELEASE, callback_data: `rm:${id}:rel` }]];
}

// Підменю ⏰ замінює клавіатуру того самого повідомлення (S2.4.d); час «завтра» — з `users.morning_at`.
export function snoozeKeyboard(id: number, morningAt: number): Keyboard {
  return [
    [
      { text: BTN_S15, callback_data: `rm:${id}:s15` },
      { text: BTN_S60, callback_data: `rm:${id}:s60` },
    ],
    [
      { text: `${BTN_TOMORROW_PREFIX} ${hhmm(morningAt)}`, callback_data: `rm:${id}:tom` },
      { text: BTN_BACK, callback_data: `rm:${id}:back` },
    ],
  ];
}

export function singleMessage(head: string, title: string, id: number, kind: string, when?: string): { text: string; keyboard: Keyboard } {
  return { text: `${head}\n<b>${clipTitle(title)}</b>${when === undefined ? "" : ` — ${when}`}`, keyboard: mainKeyboard(id, kind) };
}

export interface SummaryLine {
  id: number;
  kind: string;
  title: string;
  dueAt: number | null;
  allDay: boolean;
  open: boolean; // рядок ще можна закрити (status = 'sent')
}

// Зведення (S2.6.b): заголовок + до SUMMARY_LINES рядків `• <b>назва</b> — час`, «…ще N» і «Показати ще N»; під
// показаними — кнопки «✅ N» (для eve_before «👍 N»), унизу — «⏰ Усе на +1 год / завтра» (потребують id повідомлення:
// `mid` відомий лише після відправки, тож першу клавіатуру збираємо без них). 🗑 у зведенні немає.
export function summaryMessage(head: string, lines: SummaryLine[], offset: number, tz: string, now: number, mid: number | null): { text: string; keyboard: Keyboard } {
  const shown = lines.slice(offset, offset + SUMMARY_LINES);
  const left = lines.length - offset - shown.length;
  const body = shown.map((l) => `• <b>${clipTitle(l.title)}</b>${l.dueAt === null ? "" : ` — ${formatDue(l.dueAt, l.allDay, tz, now)}`}`);
  if (left > 0) body.push(`${MORE_PREFIX} ${left}`);
  const text = [head, ...body].join("\n").slice(0, TG_LIMIT);
  const row: Button[] = shown.flatMap((l, i) =>
    l.open ? [{ text: `${l.kind === "eve_before" ? BTN_ACK : BTN_DONE} ${i + 1}`, callback_data: `rm:${l.id}:${l.kind === "eve_before" ? "ack" : "ok"}` }] : [],
  );
  const keyboard: Keyboard = row.length > 0 ? [row] : [];
  if (mid !== null) {
    keyboard.push([
      { text: BTN_ALL_S60, callback_data: `sm:${mid}:s60` },
      { text: BTN_ALL_TOM, callback_data: `sm:${mid}:tom` },
    ]);
    if (left > 0) keyboard.push([{ text: `${BTN_MORE_PREFIX} ${Math.min(left, SUMMARY_LINES)}`, callback_data: `sm:${mid}:more:${offset + SUMMARY_LINES}` }]);
  }
  return { text, keyboard };
}

// Питання про дорогу (S2.7.a): голова з пулу + `<b>назва</b> — день, час`; кнопки 0 / 15 / 30 / 60 хв (`tr:<item>:<хв>`).
export function travelMessage(head: string, title: string, dueAt: number, tz: string, now: number, itemId: number): { text: string; keyboard: Keyboard } {
  return {
    text: `${head}\n<b>${clipTitle(title)}</b> — ${formatDue(dueAt, false, tz, now)}`,
    keyboard: travelKeyboard(itemId),
  };
}

// Кнопки лишаються й після відповіді: інший N перепланує `leave_now` без дублів (S2.7.b), тож змінити можна з того ж повідомлення.
export const travelKeyboard = (itemId: number): Keyboard => [
  TRAVEL_CHOICES.map((m) => ({ text: `${m} ${BTN_TRAVEL_SUFFIX}`, callback_data: `tr:${itemId}:${m}` })),
];
