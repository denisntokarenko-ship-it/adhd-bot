// Показ квитанції: «іконка + заголовок — людська дата» (S1.4.d). Час — лише на краю, через tz (НФ-1).
import type { ParsedItem } from "./ai/parse";
import type { Item } from "./db/items";
import { localIso } from "./time";
import { BTN_CLARIFY, HEARD_PREFIX, POINT_LINE, BTN_WRONG, CLARIFY_QUESTION_HEAD, CLARIFY_QUESTION_TAIL, MORE_PREFIX, NO_DATE, clarifyReason } from "./texts";

export const TG_LIMIT = 4096;
const HEARD_MAX = 500;
const clip = (t: string, max: number) => (Array.from(t).length > max ? `${Array.from(t).slice(0, max - 1).join("")}…` : t);
const ICON = { task: "☑️", note: "📝", event: "📅" } as const;

// НФ-9: увесь текст користувача й ШІ екранується перед вставкою в HTML.
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const dayNum = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

// «сьогодні, сб 21.11, 10:00» / «завтра, …» / «післязавтра, …» / «сб 21.11, 10:00»; інший рік — «21.11.2027».
export function formatDue(dueAt: number, allDay: boolean, tz: string, now: number): string {
  const due = localIso(dueAt, tz);
  const cur = localIso(now, tz);
  const diff = Math.round((dayNum(due) - dayNum(cur)) / 86_400_000);
  const rel = diff === 0 ? "сьогодні, " : diff === 1 ? "завтра, " : diff === 2 ? "післязавтра, " : "";
  const wd = new Intl.DateTimeFormat("uk-UA", { timeZone: tz, weekday: "short" }).format(new Date(dueAt)).replace(".", "");
  const date = `${due.slice(8, 10)}.${due.slice(5, 7)}${due.slice(0, 4) === cur.slice(0, 4) ? "" : `.${due.slice(0, 4)}`}`;
  return `${rel}${wd} ${date}${allDay ? "" : `, ${due.slice(11, 16)}`}`;
}

// «пт 20.11» — коротка дата для заголовка /today; рік не показується, це завжди «сьогодні» (НФ-1: через tz, не UTC).
export function shortDate(instant: number, tz: string): string {
  const iso = localIso(instant, tz);
  const wd = new Intl.DateTimeFormat("uk-UA", { timeZone: tz, weekday: "short" }).format(new Date(instant)).replace(".", "");
  return `${wd} ${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

export interface ReceiptEntry {
  kind: Item["kind"];
  title: string;
  dueAt: number | null;
  allDay: boolean;
  clarify: ParsedItem["clarify"];
}

export interface Receipt {
  text: string; // HTML
  buttons: { text: string; data: string }[];
}

// Квитанція одним повідомленням (НФ-9: ≤ 4096, довший перелік — «…ще N»). Питання про дату — один рядок на захоплення
// (S1.3.g): перелічує, до чого саме питає. Дані кнопок — `fix:<id>`, `clar:<id>` (≤ 64 байти).
export function buildReceipt(
  intro: string,
  entries: ReceiptEntry[],
  captureId: number,
  tz: string,
  now: number,
  heard?: string, // розпізнаний голос: показуємо курсивом, щоб помилку STT було видно (S1.7)
  points = 0, // очки за це захоплення: «+1 ✨» окремим рядком після переліку (S1.9)
): Receipt {
  const lines = entries.map((e) => {
    const when = e.dueAt === null ? NO_DATE : formatDue(e.dueAt, e.allDay, tz, now);
    return `${ICON[e.kind]} ${escapeHtml(e.title)} — ${when}`;
  });
  const asked = entries.filter((e) => e.clarify !== null);
  const tail: string[] = [];
  if (asked.length > 0) {
    const short = (t: string) => escapeHtml(Array.from(t).length > 40 ? `${Array.from(t).slice(0, 39).join("")}…` : t);
    const what = asked
      .slice(0, 5)
      .map((e) => `${short(e.title)} (${clarifyReason(e.clarify!)})`)
      .join("; ");
    tail.push(`${CLARIFY_QUESTION_HEAD} ${what}. ${CLARIFY_QUESTION_TAIL}`);
  }
  const head = escapeHtml(intro);
  const heardLine = heard === undefined ? [] : [`${HEARD_PREFIX} <i>${escapeHtml(clip(heard, HEARD_MAX))}</i>`];
  const pointLine = points > 0 ? [POINT_LINE] : [];
  const reserve = head.length + heardLine.join("").length + tail.join("\n").length + pointLine.join("").length + 40;
  const shown: string[] = [];
  let used = reserve;
  for (const line of lines) {
    if (used + line.length + 1 > TG_LIMIT) break;
    shown.push(line);
    used += line.length + 1;
  }
  if (shown.length < lines.length) shown.push(`${MORE_PREFIX} ${lines.length - shown.length}`);
  const buttons = [{ text: BTN_WRONG, data: `fix:${captureId}` }];
  if (asked.length > 0) buttons.push({ text: BTN_CLARIFY, data: `clar:${captureId}` });
  return { text: [head, ...heardLine, ...shown, ...pointLine, ...tail].join("\n"), buttons };
}
