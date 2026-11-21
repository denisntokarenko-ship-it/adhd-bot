// Cron-повтор pending (S1.5.b–e, S1.7.d): захоплення, яке не вдалося розібрати, підбирається, розбирається ще раз
// і, якщо вийшло, замінює запасну нотатку розібраними записами. Запис не губиться ніколи (НФ-5): будь-який збій —
// захоплення лишається pending (чи gave_up після 6-ї невдачі) із запасною нотаткою.
import { Api } from "grammy";
import type { Clock } from "./clock";
import { MIN_TEXT_CHARS } from "./ai/stt";
import { captureDepsFor, type BotDeps } from "./bot";
import { entryOf, pick, retryDelay, runParse, toNew, transcribeVoice, type CaptureDeps } from "./capture";
import {
  MAX_ATTEMPTS,
  giveUp,
  lastVariantIdx,
  markParsed,
  markRetryFailed,
  setReceipt,
  storeTranscript,
  type Capture,
} from "./db/captures";
import { openDb, type Db } from "./db/index";
import { claimDuePendingCaptures } from "./db/system";
import { getById as getUser } from "./db/users";
import type { AppEnv } from "./env";
import { buildReceipt } from "./format";
import { askTravel } from "./reminders/travel";
import { RETRIED_POOL } from "./texts";
import { dayBounds } from "./time";

export const MAX_PER_RUN = 3; // S1.5.g: не більше трьох захоплень за хвилину

export type RetryDeps = Partial<Pick<BotDeps, "ai" | "stt" | "rand" | "aiTimeoutMs">>;

// Одне захоплення. Не кидає на очікуваних збоях (ШІ, STT, Telegram); неочікуваний збій D1 лишає оренду, і воно
// підбереться знову через 120 с — запис при цьому цілий.
async function retryOne(api: Api, d: CaptureDeps, claimed: Capture): Promise<void> {
  const userId = d.user.id;
  const now = d.clock.now();
  let cap = claimed;
  const voice = claimed.tg_file_id !== null; // голосове: розпізнане треба показати у квитанції

  // Невдача: спроба витрачена; після 6-ї — gave_up і тиша (S1.5.b).
  const fail = async () => {
    const attempts = cap.parse_attempts + 1;
    await markRetryFailed(userId, d.db, cap, attempts, attempts >= MAX_ATTEMPTS ? null : now + retryDelay(attempts), now);
  };

  // S1.7.d: спершу STT, потім розбір.
  if (cap.raw_text === null) {
    const heard = cap.tg_file_id === null ? null : await transcribeVoice(api, d, cap.tg_file_id);
    if (heard === null) return fail();
    if (Array.from(heard).length < MIN_TEXT_CHARS) return giveUp(userId, d.db, cap.id); // у голосовому була лише тиша
    await storeTranscript(userId, d.db, cap, heard, now);
    cap = { ...cap, raw_text: heard };
  }

  const out = await runParse(d, now, cap, "parse");
  if (out.fallback) {
    if (out.reason === "limit") {
      // S1.5.f: ліміт доби — спроба не витрачається, повтор з початку наступної доби `tz`.
      return markRetryFailed(userId, d.db, cap, cap.parse_attempts, dayBounds(d.user.tz, now)[1], now);
    }
    return fail();
  }

  const v = pick(RETRIED_POOL, await lastVariantIdx(userId, d.db, cap.id), d.rand);
  try {
    await markParsed(userId, d.db, cap, out.items.map(toNew), v.idx, now); // нотатку видаляє той самий batch; очка вдруге немає
  } catch {
    console.error("retry: markParsed failed");
    return fail();
  }
  // Усе збережено; відповідь людині — окремо: збій Telegram не відкочує розібране (запис видно в /today).
  try {
    const r = buildReceipt(v.text, out.items.map(entryOf), cap.id, d.user.tz, now, voice ? (cap.raw_text ?? undefined) : undefined, 0);
    const sent = await api.sendMessage(d.user.tg_id, r.text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [r.buttons.map((b) => ({ text: b.text, callback_data: b.data }))] },
    });
    await setReceipt(userId, d.db, cap.id, sent.message_id);
    // Питання про дорогу — слідом за квитанцією, а не за часом події (S2.7.a); не кидає.
    await askTravel({ db: d.db, userId, tz: d.user.tz, now, rand: d.rand }, cap.id, (text, keyboard) =>
      api.sendMessage(d.user.tg_id, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } }),
    );
  } catch {
    console.error("retry: receipt not sent");
  }
}

// Підбір по всіх користувачах (S1.5.c). Захоплення беремо по одному, а не пачкою: оренда 120 с, а розбір одного —
// до 20 с STT + 20 с ШІ, тож пачка з трьох могла б проспати власну оренду.
export async function processPending(env: AppEnv, clock: Clock, deps: RetryDeps = {}): Promise<void> {
  const token = env.BOT_TOKEN;
  if (!token) {
    console.error("retry: BOT_TOKEN is missing");
    return;
  }
  const db: Db = openDb(env);
  const api = new Api(token);
  const base = { clock, rand: deps.rand ?? Math.random, ...deps };
  for (let i = 0; i < MAX_PER_RUN; i++) {
    const [cap] = await claimDuePendingCaptures(db, clock.now(), 1);
    if (cap === undefined) return;
    try {
      const user = await getUser(cap.user_id, db);
      if (user === null) continue;
      await retryOne(api, captureDepsFor(env, base, db, user), cap);
    } catch (err) {
      console.error("retry: capture failed", err instanceof Error ? err.name : "unknown"); // без тексту й id
    }
  }
}
