// Команди без ШІ: /today (S1.10) і /export (S1.11). Усе — з БД, ШІ тут не викликається.
import { InputFile, type Context } from "grammy";
import type { Clock } from "./clock";
import { listForExport as listCaptures } from "./db/captures";
import type { Db } from "./db/index";
import { listAll as listItems, listToday, type TodayItem } from "./db/items";
import { balance, listForExport as listLedger } from "./db/points";
import { setVariantIdx, type User } from "./db/users";
import { TG_LIMIT, escapeHtml, shortDate } from "./format";
import {
  ALL_DAY_LABEL,
  EMPTY_TODAY_POOL,
  EXPORT_CAPTION,
  MORE_PREFIX,
  PENDING_NOTE,
  TODAY_SECTION,
  UNDATED_SECTION,
  VOICE_PENDING_TITLE,
  pickVariant,
} from "./texts";
import { dayBounds, localIso } from "./time";

export interface CommandDeps {
  db: Db;
  user: User;
  clock: Clock;
  rand: () => number;
}

export const UNDATED_LIMIT = 5; // «Без дати» — до 5 найновіших, решта «…ще N» (S1.10.a)
const ICON = { task: "☑️", note: "📝", event: "📅" } as const;

function line(it: TodayItem, tz: string): string {
  const title = escapeHtml(it.title);
  const pending = it.pending === 1 && it.title !== VOICE_PENDING_TITLE ? ` <i>(${PENDING_NOTE})</i>` : "";
  if (it.due_at === null) return `${ICON[it.kind]} ${title}${pending}`;
  const when = it.all_day === 1 ? ALL_DAY_LABEL : localIso(it.due_at, tz).slice(11, 16);
  return `${ICON[it.kind]} ${title} — ${when}${pending}`;
}

// Рядки секції, що вміщаються в `room` символів; решта — «…ще N» (НФ-9: цілими рядками, тег не розрізається).
function fit(lines: string[], room: number, extra: number): { shown: string[]; hidden: number } {
  const shown: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > room) break;
    shown.push(l);
    used += l.length + 1;
  }
  return { shown, hidden: lines.length - shown.length + extra };
}

// /today: заголовок з датою й балансом → «Сьогодні» → «Без дати». Жодного слова чи числа про прострочене (НФ-4).
export async function handleToday(ctx: Context, d: CommandDeps): Promise<void> {
  const now = d.clock.now();
  const tz = d.user.tz;
  const [from, to] = dayBounds(tz, now); // доба в tz користувача, не UTC (НФ-1)
  const today = await listToday(d.user.id, d.db, from, to, UNDATED_LIMIT);
  const head = `<b>${escapeHtml(shortDate(now, tz))}</b> · ⭐ ${await balance(d.user.id, d.db)}`;

  if (today.dated.length === 0 && today.undated.length === 0) {
    const idx = pickVariant(EMPTY_TODAY_POOL.length, d.user.today_variant_idx, d.rand);
    await setVariantIdx(d.user.id, "today", idx, d.db);
    await ctx.reply(`${head}\n\n${EMPTY_TODAY_POOL[idx] ?? ""}`, { parse_mode: "HTML" });
    return;
  }

  const sections: string[] = [];
  let room = TG_LIMIT - head.length - 200; // запас на заголовки секцій і рядки «…ще N»
  const add = (title: string, lines: string[], extra: number) => {
    if (lines.length === 0 && extra === 0) return;
    const { shown, hidden } = fit(lines, room, extra);
    room -= shown.join("\n").length + shown.length;
    sections.push([`<b>${title}</b>`, ...shown, ...(hidden > 0 ? [`${MORE_PREFIX} ${hidden}`] : [])].join("\n"));
  };
  add(TODAY_SECTION, today.dated.map((i) => line(i, tz)), 0);
  add(UNDATED_SECTION, today.undated.map((i) => line(i, tz)), today.undatedTotal - today.undated.length);
  await ctx.reply([head, ...sections].join("\n\n"), { parse_mode: "HTML" });
}

// /export: усі записи, захоплення й очки ЦЬОГО користувача одним JSON-документом (S1.11). Без tg_id, токенів і ai_calls.
export async function buildExport(d: CommandDeps, now: number): Promise<string> {
  const id = d.user.id;
  const [items, captures, points] = await Promise.all([listItems(id, d.db), listCaptures(id, d.db), listLedger(id, d.db)]);
  return JSON.stringify({ version: 1, exported_at: now, tz: d.user.tz, items, captures, points_ledger: points }, null, 2);
}

export async function handleExport(ctx: Context, d: CommandDeps): Promise<void> {
  const now = d.clock.now();
  const json = await buildExport(d, now);
  const name = `adhd-export-${localIso(now, d.user.tz).slice(0, 10)}.json`;
  await ctx.replyWithDocument(new InputFile(new TextEncoder().encode(json), name), { caption: EXPORT_CAPTION });
}
