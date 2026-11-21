// Відправка оглядів (docs/spec/phase-3.md, S3.1): окрема гілка `dispatchUser` ДО перевірки запису й `selectBatch`.
// Огляд не зливається в зведення й не чекає ліміту 6/год, а після відправки записується `sent_as='single'` і входить у
// ліміт для решти. Закриття — ПІСЛЯ `sendMessage` (S2.3): збій закриття = допустимий дубль через `LEASE_MS`, не втрата.
import type { Api } from "grammy";
import type { Clock } from "../clock";
import {
  cancelDigest,
  closeDigestSent,
  doneBetween,
  hangingBetween,
  lastDigestVariantIdx,
  lastSentFireAt,
  morningContent,
  pointsBetween,
  stuckTasks,
} from "../db/digests";
import type { Db } from "../db/index";
import { balance } from "../db/points";
import { releaseLease, type Reminder } from "../db/reminders";
import { getDigestUser, type DigestUser } from "../db/users";
import { DIGEST_EVENING_POOL, DIGEST_MORNING_POOL, DIGEST_WARM_POOL, DIGEST_WEEKLY_POOL, pickVariant } from "../texts";
import { RUN_BUDGET_MS } from "../reminders/plan";
import { classify, errorClass } from "../reminders/send-failure";
import { dayBounds } from "../time";
import { eveningMessage, morningMessage, weeklyMessage } from "./render";
import { DIGEST_ORDER, DIGEST_TTL_MS, STUCK_DAYS, WARM_EVERY_DAYS, WEEKLY_ITEMS, localDayDiff, nextDigestAt, type DigestKind } from "./schedule";

export interface DigestCtx {
  api: Api;
  db: Db;
  clock: Clock;
  rand: () => number;
  start: number;
  unsent: Set<number>;
}

interface Built {
  text: string;
  keyboard: { text: string; callback_data: string }[][];
  variantIdx: number | null;
  warmIdx: number | null;
  shown: { id: number; all_day: number; due_at: number | null }[]; // для S3.4: що відрендерено в ранку
}

// Зміст на мить відправки (принцип 2) у добі `fire_at` (а не добі миті відправки). `null` — порожньо → огляд не йде.
async function build(c: DigestCtx, userId: number, u: DigestUser, r: Reminder, now: number): Promise<Built | null> {
  const kind = r.kind as DigestKind;
  const [start, end] = dayBounds(u.tz, r.fire_at);
  const headIdx = async (pool: readonly string[]) => pickVariant(pool.length, await lastDigestVariantIdx(userId, c.db, kind), c.rand);
  if (kind === "digest_morning") {
    const content = await morningContent(userId, c.db, start, end, now);
    if (content.events.length === 0 && content.tasks.length === 0) {
      // Порожній ранок — тиша, крім теплої фрази раз на `WARM_EVERY_DAYS` локальних діб (S3.3).
      if (u.warm_at !== null && localDayDiff(u.tz, u.warm_at, now) < WARM_EVERY_DAYS) return null;
      const idx = pickVariant(DIGEST_WARM_POOL.length, u.warm_variant_idx, c.rand);
      return { text: DIGEST_WARM_POOL[idx] ?? DIGEST_WARM_POOL[0] ?? "", keyboard: [], variantIdx: null, warmIdx: idx, shown: [] };
    }
    const idx = await headIdx(DIGEST_MORNING_POOL);
    const m = morningMessage({ head: DIGEST_MORNING_POOL[idx] ?? "", events: content.events, tasks: content.tasks, all: false, tz: u.tz, dayStart: start, dayEnd: end });
    return { text: m.text, keyboard: m.keyboard, variantIdx: idx, warmIdx: null, shown: m.shown };
  }
  if (kind === "digest_evening") {
    const to = Math.min(now, end); // запізнілий вечір показує свою добу, не наступну
    const [done, pointsToday, bal, hanging] = await Promise.all([
      doneBetween(userId, c.db, start, to),
      pointsBetween(userId, c.db, start, to),
      balance(userId, c.db),
      hangingBetween(userId, c.db, start, to),
    ]);
    const idx = await headIdx(DIGEST_EVENING_POOL);
    const text = eveningMessage({ head: DIGEST_EVENING_POOL[idx] ?? "", done, pointsToday, balance: bal, hanging });
    return text === null ? null : { text, keyboard: [], variantIdx: idx, warmIdx: null, shown: [] };
  }
  const stuck = await stuckTasks(userId, c.db, start, now - STUCK_DAYS * 86_400_000, WEEKLY_ITEMS);
  if (stuck.length === 0) return null; // порожній тиждень — тиша (open-questions.md)
  const idx = await headIdx(DIGEST_WEEKLY_POOL);
  const m = weeklyMessage(DIGEST_WEEKLY_POOL[idx] ?? "", stuck);
  return { text: m.text, keyboard: m.keyboard, variantIdx: idx, warmIdx: null, shown: [] };
}

// Повертає id рядків із `rest`, які ранок скасував (S3.4): `due` лише відрендерених у ньому записів.
export async function dispatchDigests(c: DigestCtx, userId: number, digests: Reminder[], rest: Reminder[]): Promise<Set<number>> {
  const gone = new Set<number>();
  const u = await getDigestUser(userId, c.db);
  if (u === null) return gone;
  const ordered = [...digests].sort((a, b) => DIGEST_ORDER.indexOf(a.kind as DigestKind) - DIGEST_ORDER.indexOf(b.kind as DigestKind) || a.id - b.id);
  for (const r of ordered) {
    if (c.clock.now() - c.start >= RUN_BUDGET_MS) return gone; // решта чекає тику (оренду знімає `finally`)
    const kind = r.kind as DigestKind;
    const now = c.clock.now();
    const lastSent = await lastSentFireAt(userId, c.db, kind);
    // Не відправлений огляд доби не забирає: наступний слот рахується від останнього `sent` (В1).
    const skip = async () => {
      await cancelDigest(userId, c.db, r, nextDigestAt(kind, u, now, lastSent), now);
      c.unsent.delete(r.id);
    };
    if (now - r.fire_at > DIGEST_TTL_MS) {
      await skip(); // пауза, тиша чи збій cron: запізнілий огляд уже не потрібен
      continue;
    }
    const built = await build(c, userId, u, r, now);
    if (built === null) {
      await skip();
      continue;
    }
    let sent: { message_id: number };
    try {
      sent = await c.api.sendMessage(u.tg_id, built.text, {
        parse_mode: "HTML",
        ...(built.keyboard.length > 0 ? { reply_markup: { inline_keyboard: built.keyboard } } : {}),
      });
    } catch (err) {
      const f = classify(err, c.clock.now());
      if (f.kind === "dead") {
        console.error("dispatch: digest chat unavailable, cancelled", r.id, f.code, errorClass(err)); // id, код, клас — без тексту
        await skip(); // завтра спроба знову
        continue;
      }
      await releaseLease(userId, c.db, r.id, f.kind === "rate" ? f.until : null);
      c.unsent.delete(r.id);
      return gone; // 429/5xx: спроба в наступному тику; решта оренд зніме `finally`
    }
    const sentAt = c.clock.now();
    c.unsent.delete(r.id); // відправлено: оренда лишається, поки не закриємо (інакше — дубль за LEASE_MS)
    const [dayStart, dayEnd] = dayBounds(u.tz, r.fire_at);
    // S3.4: ранок забирає `due` лише відрендерених записів `all_day` цієї доби, орендованих у цьому ж тику.
    const rendered = new Map(built.shown.map((i) => [i.id, i]));
    const cancelDueIds =
      kind === "digest_morning"
        ? rest
            .filter((x) => x.kind === "due" && x.attempt === 1 && x.max_attempts === 1 && x.parent_id === null && x.item_id !== null && rendered.get(x.item_id)?.all_day === 1)
            .map((x) => x.id)
        : [];
    try {
      const next = nextDigestAt(kind, u, sentAt, Math.max(lastSent ?? Number.NEGATIVE_INFINITY, r.fire_at));
      await closeDigestSent(userId, c.db, r, { sentAt, tgMessageId: sent.message_id, variantIdx: built.variantIdx, warmIdx: built.warmIdx, cancelDueIds, dayStart, dayEnd }, next, sentAt);
      for (const id of cancelDueIds) gone.add(id);
    } catch (err) {
      console.error("dispatch: digest close failed", r.id, err instanceof Error ? err.name : "unknown"); // оренда збіжить — допустимий дубль
    }
  }
  return gone;
}
