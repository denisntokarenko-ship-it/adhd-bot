// Кнопки нагадувань ✅ ⏰ 🗑 👍 і зведення (docs/spec/phase-2.md, S2.4). Лише приватний чат і лише власник: кожен запит
// несе `user.id` (НФ-3); чужий id → «не знаю такого» без змін. Повертає текст для `answerCallbackQuery` (тост).
import type { Context } from "grammy";
import type { Clock } from "../clock";
import type { Db } from "../db/index";
import { getById as getItem, type Item } from "../db/items";
import {
  getReminder,
  listSummaryRows,
  pressAck,
  pressDone,
  pressRelease,
  pressSnooze,
  setTravel,
  type Reminder,
  type SnoozeOutcome,
} from "../db/reminders";
import { getAckIdx, getDelivery, setAckIdx, type AckKind, type Delivery, type User } from "../db/users";
import { formatDue } from "../format";
import {
  ACK_LATER_POOL,
  ACK_OK_POOL,
  ACK_REL_POOL,
  ACK_TRAVEL_POOL,
  ALREADY_DONE_POOL,
  ALREADY_RELEASED,
  ALREADY_SNOOZED,
  DONE_TAIL,
  EVE_ACK_TAIL,
  SUMMARY_HEAD_POOL,
  TRAVEL_NONE,
  TRAVEL_STARTED,
  UNKNOWN_REMINDER,
  pickVariant,
} from "../texts";
import { MAX_ATTEMPTS_ESCALATING, snoozeAt, type RootKind, type SnoozeAction } from "./plan";
import { clipTitle, mainKeyboard, snoozeKeyboard, summaryMessage, travelKeyboard, type SummaryLine } from "./render";

export interface ButtonDeps {
  db: Db;
  user: User;
  clock: Clock;
  rand: () => number;
}

const RM_RE = /^rm:(\d{1,15}):(ok|ack|later|s15|s60|tom|back|rel)$/;
const SM_RE = /^sm:(\d{1,15}):(s60|tom|more:\d{1,3})$/;
const TR_RE = /^tr:(\d{1,15}):(0|15|30|60)$/;
const ROOT_KINDS: string[] = ["due", "eve_before", "leave_now"];

export const isReminderCallback = (data: string | undefined) => data !== undefined && (RM_RE.test(data) || SM_RE.test(data) || TR_RE.test(data));

export async function pickAck(d: ButtonDeps, kind: AckKind, pool: readonly string[]): Promise<string> {
  const idx = pickVariant(pool.length, await getAckIdx(d.user.id, kind, d.db), d.rand);
  await setAckIdx(d.user.id, kind, idx, d.db);
  return pool[idx] ?? pool[0] ?? "";
}

// Редагування повідомлення — best effort: його збій не скасовує зміну стану й не ламає відповідь на callback (S2.4.j).
export async function edit(ctx: Context, text: string, keyboard: { text: string; callback_data: string }[][] = []): Promise<void> {
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
  } catch {
    console.error("buttons: edit failed");
  }
}

// У зведенні закритий рядок лишається в тексті, але його кнопка зникає (решта кнопок живі).
async function dropButton(ctx: Context, id: number): Promise<void> {
  try {
    const kb = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard ?? [];
    const next = kb
      .map((row) => row.filter((b) => !("callback_data" in b && b.callback_data.startsWith(`rm:${id}:`))))
      .filter((row) => row.length > 0);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: next } });
  } catch {
    console.error("buttons: edit markup failed");
  }
}

// Корінь ланцюга: для `repeat` — kind кореня; `max_attempts` за правилами планувальника (S2.4.e).
async function snoozeTarget(d: ButtonDeps, r: Reminder, item: Item, fireAt: number) {
  const rootKind = r.kind === "repeat" ? (r.root_id === null ? null : ((await getReminder(d.user.id, d.db, r.root_id))?.kind ?? null)) : r.kind;
  if (rootKind === null || !ROOT_KINDS.includes(rootKind)) return null;
  const maxAttempts = rootKind === "eve_before" ? 1 : rootKind === "leave_now" ? MAX_ATTEMPTS_ESCALATING : item.priority === "important" ? MAX_ATTEMPTS_ESCALATING : 1;
  return { kind: rootKind as RootKind, maxAttempts, fireAt };
}

async function snoozeOne(d: ButtonDeps, dl: Delivery, r: Reminder, item: Item, action: SnoozeAction, now: number): Promise<{ outcome: SnoozeOutcome; at: number }> {
  const at = snoozeAt(action, now, { tz: dl.tz, morning_at: dl.morning_at });
  const target = await snoozeTarget(d, r, item, at);
  if (target === null) return { outcome: "unknown", at };
  return { outcome: await pressSnooze(d.user.id, d.db, r, target, now), at };
}

const stateToast = (o: "was_done" | "was_released" | "unknown" | "already", d: ButtonDeps, pool = ALREADY_DONE_POOL): string =>
  o === "was_done" ? (pool[pickVariant(pool.length, null, d.rand)] ?? "") : o === "was_released" ? ALREADY_RELEASED : o === "already" ? ALREADY_SNOOZED : UNKNOWN_REMINDER;

export async function handleReminderCallback(ctx: Context, d: ButtonDeps): Promise<string | undefined> {
  const data = ctx.callbackQuery?.data;
  if (data === undefined) return undefined;
  const rm = RM_RE.exec(data);
  if (rm !== null) return handleRm(ctx, d, Number(rm[1]), rm[2]!);
  const sm = SM_RE.exec(data);
  if (sm !== null) return handleSm(ctx, d, Number(sm[1]), sm[2]!);
  const tr = TR_RE.exec(data);
  if (tr !== null) return handleTr(ctx, d, Number(tr[1]), Number(tr[2]));
  return undefined;
}

// Відповідь про дорогу (S2.7.b): питання лишається повідомленням і підтверджується тим самим текстом — повторний
// тап того самого N безпечний (нічого не змінює), інший N перепланує `leave_now` без дублів. Чужий id → «не знаю такого».
async function handleTr(ctx: Context, d: ButtonDeps, itemId: number, minutes: number): Promise<string | undefined> {
  const userId = d.user.id;
  const item = await getItem(userId, d.db, itemId);
  const dl = await getDelivery(userId, d.db);
  if (item === null || dl === null) return UNKNOWN_REMINDER;
  const now = d.clock.now();
  const out = await setTravel(userId, d.db, itemId, minutes, now);
  if (out.kind === "gone") return item.status === "done" ? stateToast("was_done", d) : item.status === "released" ? ALREADY_RELEASED : UNKNOWN_REMINDER;
  if (out.kind === "started") return TRAVEL_STARTED;
  const head = await pickAck(d, "travel", ACK_TRAVEL_POOL);
  const road = minutes === 0 ? TRAVEL_NONE : `${minutes} хв`;
  await edit(ctx, `🚶 <b>${clipTitle(item.title)}</b> — ${road}. ${head}: ${formatDue(out.fireAt, false, dl.tz, now)}`, travelKeyboard(itemId));
  return undefined;
}

async function handleRm(ctx: Context, d: ButtonDeps, id: number, action: string): Promise<string | undefined> {
  const userId = d.user.id;
  const r = await getReminder(userId, d.db, id); // чужий id → null
  if (r === null || r.item_id === null) return UNKNOWN_REMINDER;
  const item = await getItem(userId, d.db, r.item_id);
  if (item === null) return UNKNOWN_REMINDER;
  const dl = await getDelivery(userId, d.db);
  if (dl === null) return UNKNOWN_REMINDER;
  const now = d.clock.now();
  const title = clipTitle(item.title);
  const inSummary = r.sent_as === "summary";

  if (action === "back" || action === "later") {
    if (item.status !== "open") return stateToast(item.status === "done" ? "was_done" : "was_released", d);
    if (action === "later" && r.status !== "sent") return ALREADY_SNOOZED;
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: action === "later" ? snoozeKeyboard(r.id, dl.morning_at) : mainKeyboard(r.id, r.kind) } });
    } catch {
      console.error("buttons: edit markup failed");
    }
    return undefined;
  }

  if (action === "ack" || (action === "ok" && r.kind === "eve_before")) {
    // «ок» на eve_before — лише підтвердження: запис, інші ланцюги й очки не зачеплені (S2.4.l).
    if (r.kind !== "eve_before") return UNKNOWN_REMINDER;
    await pressAck(userId, d.db, r);
    if (inSummary) await dropButton(ctx, r.id);
    else await edit(ctx, `👍 <b>${title}</b> — ${EVE_ACK_TAIL}`);
    return undefined;
  }

  if (action === "ok") {
    const out = await pressDone(userId, d.db, r, now);
    if (out !== "done") return stateToast(out, d);
    if (inSummary) await dropButton(ctx, r.id);
    else await edit(ctx, `✅ <b>${title}</b> — ${DONE_TAIL}`);
    return pickAck(d, "ok", ACK_OK_POOL);
  }

  if (action === "rel") {
    const out = await pressRelease(userId, d.db, r);
    if (out !== "done") return stateToast(out, d);
    const text = await pickAck(d, "rel", ACK_REL_POOL);
    await edit(ctx, `🗑 <b>${title}</b>\n${text}`);
    return undefined;
  }

  // s15 / s60 / tom
  const res = await snoozeOne(d, dl, r, item, action as SnoozeAction, now);
  if (res.outcome !== "snoozed") return stateToast(res.outcome, d);
  const head = await pickAck(d, "later", ACK_LATER_POOL);
  await edit(ctx, `${head} ${formatDue(res.at, false, dl.tz, now)}`);
  return undefined;
}

async function handleSm(ctx: Context, d: ButtonDeps, mid: number, action: string): Promise<string | undefined> {
  const userId = d.user.id;
  const rows = await listSummaryRows(userId, d.db, mid); // за (user_id, tg_message_id): чужий id повідомлення → порожньо
  const dl = await getDelivery(userId, d.db);
  if (rows.length === 0 || dl === null) return UNKNOWN_REMINDER;
  const now = d.clock.now();

  if (action.startsWith("more:")) {
    const offset = Number(action.slice(5));
    const headIdx = rows[0]?.variant_idx ?? 0;
    const lines: SummaryLine[] = rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, dueAt: r.due_at, allDay: r.all_day === 1, open: r.status === "sent" }));
    const m = summaryMessage(SUMMARY_HEAD_POOL[headIdx] ?? SUMMARY_HEAD_POOL[0] ?? "", lines, offset, dl.tz, now, mid);
    await edit(ctx, m.text, m.keyboard);
    return undefined;
  }

  // «⏰ Усе на …»: усі ще не закриті рядки цього повідомлення (S2.6.b).
  let last: number | null = null;
  for (const r of rows) {
    if (r.status !== "sent") continue;
    const item = await getItem(userId, d.db, r.item_id!);
    if (item === null) continue;
    const res = await snoozeOne(d, dl, r, item, action as SnoozeAction, now);
    if (res.outcome === "snoozed") last = res.at;
  }
  if (last === null) return ALREADY_SNOOZED;
  const head = await pickAck(d, "later", ACK_LATER_POOL);
  await edit(ctx, `${head} ${formatDue(last, false, dl.tz, now)}`);
  return undefined;
}
