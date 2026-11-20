// Текстове захоплення (крок 1.3): повідомлення → захоплення (pending, до ШІ) → розбір → записи → квитанція.
// «Не так»/«Уточнити» → наступне повідомлення перерозбирає оригінал разом з виправленням (S1.6).
import type { Context } from "grammy";
import { MAX_VOICE_SECONDS, MIN_TEXT_CHARS, downloadTelegramFile, type Stt } from "./ai/stt";
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
  type CaptureSource,
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
  VOICE_EMPTY_POOL,
  VOICE_PENDING_POOL,
  VOICE_TOO_LONG_POOL,
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
  stt: Stt | null; // null — немає біндингу Workers AI: голос іде запасним шляхом (S1.7.d)
  botToken: string; // лише для скачування файлу голосового; у логи не йде
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

async function sendReceipt(
  ctx: Context,
  d: CaptureDeps,
  cap: Capture,
  intro: string,
  items: ParsedItem[],
  now: number,
  heard?: string,
  points = 0,
) {
  const r = buildReceipt(intro, items.map(entryOf), cap.id, d.user.tz, now, heard, points);
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
  unheard = false, // голос без тексту: відповідь про голосове, а не «записав як є»
) {
  const v = pick(unheard ? VOICE_PENDING_POOL : reason === "limit" ? LIMIT_POOL : FALLBACK_POOL, last, d.rand);
  const retryAt = reason === "limit" ? dayBounds(d.user.tz, now)[1] : now + retryDelay(cap.parse_attempts + 1);
  await saveFallback(d.user.id, d.db, cap, reason, retryAt, v.idx, now);
  await ctx.reply(v.text);
}

// `heard` — розпізнаний голос (показується у квитанції); `fileId` — голосове без тексту (STT не вдався).
interface Origin {
  source: CaptureSource;
  heard?: string;
}

async function captureNew(
  ctx: Context,
  d: CaptureDeps,
  text: string | null,
  updateId: number,
  origin: Origin & { fileId?: string } = { source: "text" },
): Promise<void> {
  const now = d.clock.now();
  let cap: Capture | null;
  try {
    cap = await createPending(
      d.user.id,
      d.db,
      { tgUpdateId: updateId, source: origin.source, rawText: text, ...(origin.fileId === undefined ? {} : { tgFileId: origin.fileId }) },
      now,
    );
  } catch (err) {
    throw new RetryableError(err); // нічого не збережено → 500, Telegram повторить
  }
  if (cap === null) return; // той самий update_id вдруге (НФ-7)

  const last = await lastVariantIdx(d.user.id, d.db, cap.id);
  if (text === null) return fallbackReply(ctx, d, cap, "unavailable", last, now, true); // STT не вдався (S1.7.d)
  const out = await runParse(d, now, cap, "parse");
  if (out.fallback) return fallbackReply(ctx, d, cap, out.reason, last, now);

  const v = pick(RECEIPT_POOL, last, d.rand);
  try {
    await markParsed(d.user.id, d.db, cap, out.items.map(toNew), v.idx, now);
  } catch {
    console.error("markParsed failed"); // розбір є, а зберегти не вдалося: тримаємо хоча б сирий текст
    return fallbackReply(ctx, d, cap, "unavailable", last, now);
  }
  await sendReceipt(ctx, d, cap, v.text, out.items, now, origin.heard, 1); // +1 — очко створене разом із захопленням
}

async function applyFix(
  ctx: Context,
  d: CaptureDeps,
  cap: Capture,
  fixText: string,
  updateId: number,
  heard?: string,
): Promise<void> {
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
  await sendReceipt(ctx, d, cap, v.text, out.items, now, heard);
}

// Текст людини (не команда): звичайний, підпис пересланого чи розпізнаний голос — далі один шлях.
// Порядок: дубль доставки → виправлення в межах вікна → нове захоплення.
async function handleCaptured(
  ctx: Context,
  d: CaptureDeps,
  text: string,
  updateId: number,
  origin: Origin,
): Promise<void> {
  const fix = await activeFix(d.user.id, d.db, d.clock.now(), FIX_WINDOW_MS);
  if (fix !== null) return applyFix(ctx, d, fix, text, updateId, origin.heard);
  return captureNew(ctx, d, text, updateId, origin);
}

// Текстове повідомлення (не команда) або підпис пересланого. `source` — text|forward (S1.8).
export async function handleText(ctx: Context, d: CaptureDeps, source: "text" | "forward" = "text"): Promise<void> {
  const text = ctx.message?.text ?? ctx.message?.caption;
  if (text === undefined || text.trim() === "") return; // порожнє — не захоплення (S1.4.f)
  const updateId = ctx.update.update_id;

  if (await isKnownUpdate(d.user.id, d.db, updateId)) return; // НФ-7, S1.6.i: до ШІ
  return handleCaptured(ctx, d, text, updateId, { source });
}

// Голосове (S1.7) і переслане голосове (S1.8.e, source='forward'): getFile → Whisper → той самий шлях, що в тексту.
export async function handleVoice(ctx: Context, d: CaptureDeps, source: "voice" | "forward"): Promise<void> {
  const voice = ctx.message?.voice;
  if (voice === undefined) return;
  const updateId = ctx.update.update_id;
  if (await isKnownUpdate(d.user.id, d.db, updateId)) return; // дубль доставки — до скачування й STT

  // Порожнє й задовге — дружня відповідь без STT і без Claude (S1.7.b, S1.7.c).
  if (voice.duration <= 0) return void (await ctx.reply(pick(VOICE_EMPTY_POOL, null, d.rand).text));
  if (voice.duration > MAX_VOICE_SECONDS) return void (await ctx.reply(pick(VOICE_TOO_LONG_POOL, null, d.rand).text));

  let heard: string | null = null; // null — STT не вдався; "" — вдався, але тиша
  if (d.stt !== null) {
    try {
      const file = await ctx.api.getFile(voice.file_id);
      if (file.file_path !== undefined) {
        heard = (await d.stt.transcribe(await downloadTelegramFile(d.botToken, file.file_path))).trim();
      }
    } catch {
      console.error("stt failed"); // без токена, id файлу й тексту
    }
  }

  if (heard === null) {
    // Не втратити запис (НФ-5): захоплення без тексту + запасна нотатка. Виправлення («Не так») без STT — «лишив як було».
    const fix = await activeFix(d.user.id, d.db, d.clock.now(), FIX_WINDOW_MS);
    if (fix !== null) return void (await ctx.reply(pick(FIX_FAILED_POOL, null, d.rand).text));
    return captureNew(ctx, d, null, updateId, { source, fileId: voice.file_id });
  }
  if (Array.from(heard).length < MIN_TEXT_CHARS) return void (await ctx.reply(pick(VOICE_EMPTY_POOL, null, d.rand).text));
  return handleCaptured(ctx, d, heard, updateId, { source, heard });
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
