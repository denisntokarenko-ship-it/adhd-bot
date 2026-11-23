// Тексти й кнопки оглядів (docs/spec/phase-3.md, S3.2–S3.6). Чисті функції, без БД. Назви екрануються й обрізаються
// (НФ-9); callback-дані — `dg:all`, `wk:t|s|r:<itemId>` (≤ 64 байти). Нічого про прострочення: давніша дата не показується.
import type { DigestItem } from "./types";
import { TG_LIMIT } from "../format";
import { clipTitle, type Keyboard } from "../reminders/render";
import {
  BTN_DIGEST_ALL,
  BTN_WK_RELEASE,
  BTN_WK_SPLIT,
  BTN_WK_TODAY,
  DIGEST_BALANCE,
  DIGEST_DONE_LABEL,
  DIGEST_EVENTS_LABEL,
  DIGEST_HANGING,
  DIGEST_POINTS,
  DIGEST_TASKS_LABEL,
  MORE_PREFIX,
} from "../texts";
import { HANGING_TITLES, MORNING_TASKS } from "./schedule";
import { localIso } from "../time";

interface Line {
  text: string;
  item: boolean; // рядок переліку записів: його можна обрізати «…ще N»
}

// Довше за 4096 — перелік обрізається рядком «…ще N» (НФ-9); службові рядки (заголовок, підписи) лишаються.
function fit(lines: Line[]): string {
  const total = (ls: Line[]) => ls.map((l) => l.text).join("\n").length;
  if (total(lines) <= TG_LIMIT) return lines.map((l) => l.text).join("\n");
  const kept = [...lines];
  let cut = 0;
  const reserve = `\n${MORE_PREFIX} 9999`.length;
  while (kept.length > 1 && total(kept) + reserve > TG_LIMIT) {
    const at = kept.map((l) => l.item).lastIndexOf(true);
    if (at < 0) break;
    kept.splice(at, 1);
    cut += 1;
  }
  return [...kept.map((l) => l.text), `${MORE_PREFIX} ${cut}`].join("\n").slice(0, TG_LIMIT);
}

// «HH:MM назва» для запису, що сьогодні й має час; давніша дата не показується (ні «вчора», ні «прострочено»).
function timed(it: DigestItem, tz: string, dayStart: number, dayEnd: number): string {
  const when = it.all_day === 0 && it.due_at !== null && it.due_at >= dayStart && it.due_at < dayEnd ? `${localIso(it.due_at, tz).slice(11, 16)} ` : "";
  return `• ${when}${clipTitle(it.title)}`;
}

export interface MorningInput {
  head: string;
  events: DigestItem[];
  tasks: DigestItem[];
  all: boolean; // «показати все»: усі справи й без кнопки
  tz: string;
  dayStart: number;
  dayEnd: number;
  routines?: string | null; // рядок рутин дня (S4.8) — після подій і справ; сам ранок непорожнім не робить (4.8.c)
}

export interface MorningMessage {
  text: string;
  keyboard: Keyboard;
  shown: DigestItem[]; // що відрендерено: події й справи в тексті (S3.4 скасовує `due` лише їх)
}

export function morningMessage(m: MorningInput): MorningMessage {
  const tasks = m.all ? m.tasks : m.tasks.slice(0, MORNING_TASKS);
  const lines: Line[] = [{ text: m.head, item: false }];
  if (m.events.length > 0) {
    lines.push({ text: DIGEST_EVENTS_LABEL, item: false });
    for (const e of m.events) lines.push({ text: timed(e, m.tz, m.dayStart, m.dayEnd), item: true });
  }
  if (tasks.length > 0) {
    lines.push({ text: DIGEST_TASKS_LABEL, item: false });
    for (const t of tasks) lines.push({ text: timed(t, m.tz, m.dayStart, m.dayEnd), item: true });
  }
  if (m.routines) lines.push({ text: m.routines, item: false });
  const more = !m.all && m.tasks.length > MORNING_TASKS;
  return {
    text: fit(lines),
    keyboard: more ? [[{ text: BTN_DIGEST_ALL, callback_data: "dg:all" }]] : [],
    shown: [...m.events, ...tasks],
  };
}

export interface EveningInput {
  head: string;
  done: DigestItem[];
  pointsToday: number;
  balance: number;
  hanging: DigestItem[];
  routines?: string | null; // «💊 рутини: N з M ✅» (S4.9); N = 0 — рядка немає
}

// Порожньо (нічого не зроблено, 0 очок дня, нічого не висить) → null: огляд не надсилається, без фрази (S3.5).
export function eveningMessage(e: EveningInput): string | null {
  if (e.done.length === 0 && e.pointsToday <= 0 && e.hanging.length === 0 && !e.routines) return null;
  const lines: Line[] = [{ text: e.head, item: false }];
  if (e.done.length > 0) {
    lines.push({ text: DIGEST_DONE_LABEL, item: false });
    for (const d of e.done) lines.push({ text: `• ${clipTitle(d.title)}`, item: true });
  }
  if (e.routines) lines.push({ text: e.routines, item: false });
  const bal = DIGEST_BALANCE.replace("{n}", String(e.balance));
  lines.push({ text: e.pointsToday > 0 ? `${DIGEST_POINTS.replace("{n}", String(e.pointsToday))} · ${bal}` : bal, item: false });
  if (e.hanging.length > 0) {
    const names = e.hanging.slice(0, HANGING_TITLES).map((h) => clipTitle(h.title)).join(", ");
    lines.push({ text: `${DIGEST_HANGING} ${names}${e.hanging.length > HANGING_TITLES ? "…" : ""}`, item: false });
  }
  return fit(lines);
}

// Тиждень (S3.6): нумеровані рядки; під ними по ряду з трьох кнопок на запис. Номер — у тексті першої кнопки, щоб ряди
// відрізнялись; `callback_data` несе лише дію й id запису (власника бере handler з користувача, що натиснув).
export function weeklyRow(n: number, id: number): Keyboard[number] {
  return [
    { text: `${n}. ${BTN_WK_TODAY}`, callback_data: `wk:t:${id}` },
    { text: BTN_WK_SPLIT, callback_data: `wk:s:${id}` },
    { text: BTN_WK_RELEASE, callback_data: `wk:r:${id}` },
  ];
}

export function weeklyMessage(head: string, items: DigestItem[]): { text: string; keyboard: Keyboard } {
  const lines: Line[] = [{ text: head, item: false }, ...items.map((it, i) => ({ text: `${i + 1}. ${clipTitle(it.title)}`, item: true }))];
  return { text: fit(lines), keyboard: items.map((it, i) => weeklyRow(i + 1, it.id)) };
}
