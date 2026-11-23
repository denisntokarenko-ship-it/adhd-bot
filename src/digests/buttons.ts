// Кнопки оглядів (docs/spec/phase-3.md, S3.2.d, S3.6): `dg:all` (ранок) і `wk:t|s|r:<itemId>` (тиждень).
// Лише приватний чат і лише власник: кожен запит несе `user.id` (НФ-3); callback несе дію й id запису, а записи
// handler бере з `userId` того, хто натиснув, — чужий id нічого не змінює й не показується (IDOR, як 1.6.e).
import type { Context } from "grammy";
import { itemExists, lastDigestVariantIdx, moveToToday, morningContent, releaseItem, titlesByIds } from "../db/digests";
import { getDigestUser, setVariantIdx } from "../db/users";
import { clipTitle, type Keyboard } from "../reminders/render";
import { edit, pickAck, type ButtonDeps } from "../reminders/buttons";
import { ACK_REL_POOL, DIGEST_MORNING_POOL, DIGEST_WEEKLY_POOL, SOON_POOL, UNKNOWN_REMINDER, WK_ALREADY_TODAY, WK_NOT_ACTUAL, WK_RELEASED_MARK, WK_TODAY_MARK, WK_TODAY_POOL, pickVariant } from "../texts";
import { escapeHtml } from "../format";
import { dayBounds } from "../time";
import { morningMessage, weeklyRow } from "./render";
import { morningRoutines } from "../routines/digest";

const WK_RE = /^wk:(t|s|r):(\d{1,15})$/;

export const isDigestCallback = (data: string | undefined) => data !== undefined && (data === "dg:all" || WK_RE.test(data));

export async function handleDigestCallback(ctx: Context, d: ButtonDeps): Promise<string | undefined> {
  const data = ctx.callbackQuery?.data;
  if (data === "dg:all") return handleAll(ctx, d);
  const wk = data === undefined ? null : WK_RE.exec(data);
  return wk === null ? undefined : handleWeekly(ctx, d, wk[1] as "t" | "s" | "r", Number(wk[2]));
}

// «показати все» (S3.2.d): те саме повідомлення — повний список кандидатів на мить натискання, кнопка зникає.
async function handleAll(ctx: Context, d: ButtonDeps): Promise<string | undefined> {
  const userId = d.user.id;
  const u = await getDigestUser(userId, d.db);
  if (u === null) return UNKNOWN_REMINDER;
  const now = d.clock.now();
  const [start, end] = dayBounds(u.tz, now);
  const content = await morningContent(userId, d.db, start, end, now);
  const idx = (await lastDigestVariantIdx(userId, d.db, "digest_morning")) ?? 0;
  const routines = await morningRoutines(userId, d.db, u.tz, start, end);
  const m = morningMessage({ head: DIGEST_MORNING_POOL[idx] ?? DIGEST_MORNING_POOL[0] ?? "", events: content.events, tasks: content.tasks, all: true, tz: u.tz, dayStart: start, dayEnd: end, routines });
  await edit(ctx, m.text, m.keyboard);
  return undefined;
}

async function handleWeekly(ctx: Context, d: ButtonDeps, act: "t" | "s" | "r", itemId: number): Promise<string | undefined> {
  const userId = d.user.id;
  if (!(await itemExists(userId, d.db, itemId))) return UNKNOWN_REMINDER; // чужий чи неіснуючий: без змін
  if (act === "s") {
    // 🧩 розбити — заглушка до Фази 5: лише тост із пулу «навчуся скоро», дані не змінюються.
    const idx = pickVariant(SOON_POOL.length, d.user.soon_variant_idx, d.rand);
    await setVariantIdx(userId, "soon", idx, d.db);
    return SOON_POOL[idx] ?? SOON_POOL[0];
  }
  const now = d.clock.now();
  if (act === "t") {
    const u = await getDigestUser(userId, d.db);
    if (u === null) return UNKNOWN_REMINDER;
    const out = await moveToToday(userId, d.db, itemId, dayBounds(u.tz, now)[0], now);
    if (out === "already") return WK_ALREADY_TODAY;
    if (out === "not_actual") return WK_NOT_ACTUAL;
    if (out !== "done") return UNKNOWN_REMINDER;
    await rewrite(ctx, d, itemId, WK_TODAY_MARK);
    return pickAck(d, "today", WK_TODAY_POOL);
  }
  const out = await releaseItem(userId, d.db, itemId);
  if (out === "not_actual") return WK_NOT_ACTUAL;
  if (out !== "done") return UNKNOWN_REMINDER;
  await rewrite(ctx, d, itemId, WK_RELEASED_MARK);
  return pickAck(d, "rel", ACK_REL_POOL);
}

// Перелік рядків — з `reply_markup` натиснутого повідомлення (id у `wk:*:<id>`), без перерахунку вибірки: вона дала б
// інший список (запис уже не завислий, на його місце прийшов би 6-й). Рядок натиснутого замінюється міткою, його кнопки
// зникають, решта лишається; раніше закриті рядки переносяться з тексту. Назви — лише записи цього користувача.
async function rewrite(ctx: Context, d: ButtonDeps, pressedId: number, mark: string): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  const rows: { n: number; id: number }[] = [];
  for (const row of msg?.reply_markup?.inline_keyboard ?? []) {
    const first = row[0];
    const m = first === undefined || !("callback_data" in first) ? null : /^wk:t:(\d+)$/.exec(first.callback_data);
    const n = first === undefined ? null : /^(\d+)\./.exec(first.text);
    if (m !== null && n !== null) rows.push({ n: Number(n[1]), id: Number(m[1]) });
  }
  const titles = await titlesByIds(d.user.id, d.db, rows.map((r) => r.id)); // чужий id у розмітці не рендериться
  const active = rows.filter((r) => titles.has(r.id));
  const lines = new Map<number, string>();
  for (const l of (msg !== undefined && "text" in msg && typeof msg.text === "string" ? msg.text : "").split("\n")) {
    const n = /^(\d+)\. /.exec(l);
    if (n !== null) lines.set(Number(n[1]), escapeHtml(l)); // раніше закриті рядки (їхніх кнопок уже немає)
  }
  const keyboard: Keyboard = [];
  for (const r of active) {
    const title = clipTitle(titles.get(r.id) ?? "");
    if (r.id === pressedId) lines.set(r.n, `${r.n}. ${mark} — ${title}`);
    else {
      lines.set(r.n, `${r.n}. ${title}`);
      keyboard.push(weeklyRow(r.n, r.id));
    }
  }
  const head = DIGEST_WEEKLY_POOL[(await lastDigestVariantIdx(d.user.id, d.db, "digest_weekly")) ?? 0] ?? DIGEST_WEEKLY_POOL[0] ?? "";
  const body = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
  await edit(ctx, [head, ...body].join("\n"), keyboard);
}
