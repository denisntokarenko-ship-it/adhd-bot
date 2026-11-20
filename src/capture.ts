// Текстове захоплення (крок 1.3): повідомлення → захоплення (pending, до ШІ) → розбір → записи → квитанція.
// «Не так»/«Уточнити» → наступне повідомлення перерозбирає оригінал разом з виправленням (S1.6).
import type { Context } from "grammy";
import type { AiClient } from "./ai/client";
import { parseCapture, type ParseContext, type ParseOutcome, type ParsedItem } from "./ai/parse";
import type { Clock } from "./clock";
import {
  activeFix,
  createPending,
  getById,
  isKnownUpdate,
  lastVariantIdx,
  markParsed,
  replaceItems,
  requestFix,
  saveFallback,
  setReceipt,
  type Capture,
} from "./db/captures";
import type { Db } from "./db/index";
import type { User } from "./db/users";
import { RetryableError } from "./errors";
import { buildReceipt, type ReceiptEntry } from "./format";
import {
  CLARIFY_ASK_POOL,
  FALLBACK_POOL,
  FIX_ASK_POOL,
  FIX_FAILED_POOL,
  LIMIT_POOL,
  RECEIPT_POOL,
  pickVariant,
} from "./texts";
import { dayBounds } from "./time";

// Вікно «Не так»: наступне повідомлення в межах 10 хв — виправлення, пізніше — звичайний новий запис (S1.6.c).
// Стан очікування — у БД (`captures.fix_requested_at`), а не в KV: див. «Рішення» в docs/PROGRESS.md.
export const FIX_WINDOW_MS = 10 * 60_000;

// Затримки повторів після невдалої спроби n (S1.5.b): [n-1]; після 6-ї невдачі — gave_up (S1.5, поза 1.3).
export const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 3_600_000, 6 * 3_600_000] as const;
export function retryDelay(attemptsAfterFailure: number): number {
  const i = Math.min(Math.max(attemptsAfterFailure, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[i] ?? RETRY_DELAYS_MS[0];
}

export interface CaptureDeps {
  db: Db;
  user: User;
  ai: AiClient | null; // null — немає ключа: усе йде запасним шляхом
  clock: Clock;
  rand: () => number;
  model: string;
  dailyLimit: number;
  timeoutMs?: number;
}

const toNew = (p: ParsedItem) => ({
  kind: p.kind,
  title: p.title,
  body: p.body,
  dueAt: p.dueAt,
  allDay: p.allDay,
  priority: p.priority,
});

const entryOf = (p: ParsedItem): ReceiptEntry => ({
  kind: p.kind,
  title: p.title,
  dueAt: p.dueAt,
  allDay: p.allDay,
  clarify: p.clarify,
});

const pick = (pool: readonly string[], last: number | null, rand: () => number) => {
  const idx = pickVariant(pool.length, last, rand);
  return { idx, text: pool[idx] ?? pool[0] ?? "" };
};

// Розбір, що не кидає: будь-який збій (включно з D1 під час підрахунку ліміту) — «недоступний» → запасний шлях.
async function runParse(
  d: CaptureDeps,
  now: number,
  cap: Capture,
  purpose: "parse" | "fix",
  correction?: string,
): Promise<ParseOutcome> {
  if (d.ai === null) return { fallback: true, reason: "unavailable" };
  const ctx: ParseContext = {
    client: d.ai,
    db: d.db,
    userId: d.user.id,
    now,
    tz: d.user.tz,
    model: d.model,
    dailyLimit: d.dailyLimit,
    source: cap.source,
    purpose,
    captureId: cap.id,
    ...(d.timeoutMs === undefined ? {} : { timeoutMs: d.timeoutMs }),
  };
  try {
    return await parseCapture(ctx, cap.raw_text ?? "", correction);
  } catch {
    console.error("parse crashed"); // без тексту й id
    return { fallback: true, reason: "unavailable" };
  }
}

async function sendReceipt(ctx: Context, d: CaptureDeps, cap: Capture, intro: string, items: ParsedItem[], now: number) {
  const r = buildReceipt(intro, items.map(entryOf), cap.id, d.user.tz, now);
  const sent = await ctx.reply(r.text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [r.buttons.map((b) => ({ text: b.text, callback_data: b.data }))] },
  });
  await setReceipt(d.user.id, d.db, cap.id, sent.message_id);
}

// Запасна нотатка + коротка відповідь (S1.5.a, НФ-5). Запис не губиться ніколи.
async function fallbackReply(
  ctx: Context,
  d: CaptureDeps,
  cap: Capture,
  reason: "unavailable" | "limit",
  last: number | null,
  now: number,
) {
  const v = pick(reason === "limit" ? LIMIT_POOL : FALLBACK_POOL, last, d.rand);
  const retryAt = reason === "limit" ? dayBounds(d.user.tz, now)[1] : now + retryDelay(cap.parse_attempts + 1);
  await saveFallback(d.user.id, d.db, cap, reason, retryAt, v.idx, now);
  await ctx.reply(v.text);
}

async function captureNew(ctx: Context, d: CaptureDeps, text: string, updateId: number): Promise<void> {
  const now = d.clock.now();
  let cap: Capture | null;
  try {
    cap = await createPending(d.user.id, d.db, { tgUpdateId: updateId, source: "text", rawText: text }, now);
  } catch (err) {
    throw new RetryableError(err); // нічого не збережено → 500, Telegram повторить
  }
  if (cap === null) return; // той самий update_id вдруге (НФ-7)

  const last = await lastVariantIdx(d.user.id, d.db, cap.id);
  const out = await runParse(d, now, cap, "parse");
  if (out.fallback) return fallbackReply(ctx, d, cap, out.reason, last, now);

  const v = pick(RECEIPT_POOL, last, d.rand);
  try {
    await markParsed(d.user.id, d.db, cap, out.items.map(toNew), v.idx, now);
  } catch {
    console.error("markParsed failed"); // розбір є, а зберегти не вдалося: тримаємо хоча б сирий текст
    return fallbackReply(ctx, d, cap, "unavailable", last, now);
  }
  await sendReceipt(ctx, d, cap, v.text, out.items, now);
}

async function applyFix(ctx: Context, d: CaptureDeps, cap: Capture, fixText: string, updateId: number): Promise<void> {
  const now = d.clock.now();
  const failed = () => ctx.reply(pick(FIX_FAILED_POOL, null, d.rand).text);
  const out = await runParse(d, now, cap, "fix", fixText);
  if (out.fallback) return void (await failed()); // старі записи цілі, fix_requested_at діє до кінця вікна

  const v = pick(RECEIPT_POOL, cap.variant_idx, d.rand);
  try {
    await replaceItems(d.user.id, d.db, cap, updateId, out.items.map(toNew), v.idx, now);
  } catch {
    console.error("replaceItems failed");
    return void (await failed());
  }
  if (cap.receipt_message_id !== null && ctx.chat) {
    try {
      await ctx.api.editMessageReplyMarkup(ctx.chat.id, cap.receipt_message_id, { reply_markup: { inline_keyboard: [] } });
    } catch {
      /* стара квитанція могла зникнути — кнопки й так більше нічого не зроблять */
    }
  }
  await sendReceipt(ctx, d, cap, v.text, out.items, now);
}

// Текстове повідомлення (не команда). Порядок: дубль доставки → виправлення в межах вікна → нове захоплення.
export async function handleText(ctx: Context, d: CaptureDeps): Promise<void> {
  const text = ctx.message?.text;
  if (text === undefined || text.trim() === "") return; // порожнє — не захоплення (S1.4.f)
  const updateId = ctx.update.update_id;

  if (await isKnownUpdate(d.user.id, d.db, updateId)) return; // НФ-7, S1.6.i: до ШІ
  const fix = await activeFix(d.user.id, d.db, d.clock.now(), FIX_WINDOW_MS);
  if (fix !== null) return applyFix(ctx, d, fix, text, updateId);
  return captureNew(ctx, d, text, updateId);
}

// Кнопки квитанції: `fix:<id>` («Не так») і `clar:<id>` («Уточнити»). Відповідь на callback — завжди (НФ-9).
export async function handleCallback(ctx: Context, d: CaptureDeps): Promise<void> {
  const m = /^(fix|clar):(\d{1,15})$/.exec(ctx.callbackQuery?.data ?? "");
  if (m === null) return;
  const id = Number(m[2]);
  // Чужий чи неіснуючий id: getById/requestFix фільтрують за user_id — нічого не змінюється, відповіді немає.
  if ((await getById(d.user.id, d.db, id)) === null) return;
  const cap = await requestFix(d.user.id, d.db, id, d.clock.now());
  if (cap === null) return;
  const pool = m[1] === "clar" ? CLARIFY_ASK_POOL : FIX_ASK_POOL;
  await ctx.reply(pick(pool, null, d.rand).text);
}
