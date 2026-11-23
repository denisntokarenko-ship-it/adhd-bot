// Відправка рядків рутин (docs/spec/phase-4.md, S4.5): окрема гілка `dispatchUser`, як огляди (S3.1). Рядок рутини
// не зливається в зведення й не чекає ліміту 6/год, а після відправки записується `sent_as='single'` і входить у ліміт
// для решти (4.5.i). Тиха ніч його не тримає; пауза — лише звичку, ліки ні (`claimDueReminders`, 4.5.h, В4 R-4). Текст збирається в мить
// відправки (4.7.b: нова назва діє й на повтори). Закриття — ПІСЛЯ `sendMessage` (S2.3): краще двічі, ніж жодного.
import type { Api } from "grammy";
import type { Clock } from "../clock";
import type { Db } from "../db/index";
import { cancelOne, releaseLease, type Reminder } from "../db/reminders";
import { closeRoutineSent, getRoutine, lastRoutineVariantIdx, slotAnswered } from "../db/routines";
import { getDelivery } from "../db/users";
import { nextRepeat, RUN_BUDGET_MS } from "../reminders/plan";
import { classify, errorClass } from "../reminders/send-failure";
import { pickVariant } from "../texts";
import { pushMessage, pushPool } from "./render";
import { ROUTINE_TTL_MS } from "./schedule";

export interface RoutineDispatchCtx {
  api: Api;
  db: Db;
  clock: Clock;
  rand: () => number;
  start: number;
  unsent: Set<number>;
}

export const isRoutineRow = (r: Reminder) => r.routine_id !== null;

export async function dispatchRoutineRows(c: RoutineDispatchCtx, userId: number, rows: Reminder[]): Promise<void> {
  const dl = await getDelivery(userId, c.db);
  if (dl === null) return;
  const drop = async (r: Reminder) => {
    await cancelOne(userId, c.db, r.id);
    c.unsent.delete(r.id);
  };
  for (const r of [...rows].sort((a, b) => a.fire_at - b.fire_at || a.id - b.id)) {
    if (c.clock.now() - c.start >= RUN_BUDGET_MS) return; // решта чекає тику (оренду знімає `finally`)
    const now = c.clock.now();
    const routine = await getRoutine(userId, c.db, r.routine_id!);
    // 4.5.g: рутина на паузі чи слот уже має відповідь; 4.5.h: рядок, що не пішов за 3 год після `fire_at`, — мовчки.
    if (routine === null || !routine.active || now - r.fire_at > ROUTINE_TTL_MS || (await slotAnswered(userId, c.db, routine.id, r.slot_at!))) {
      await drop(r);
      continue;
    }
    const pool = pushPool(routine.kind, r.attempt);
    const idx = pickVariant(pool.length, await lastRoutineVariantIdx(userId, c.db, r.attempt > 1), c.rand);
    const msg = pushMessage(routine.kind, routine.title, r.id, r.attempt, idx);
    let sent: { message_id: number };
    try {
      sent = await c.api.sendMessage(dl.tg_id, msg.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: msg.keyboard } });
    } catch (err) {
      const f = classify(err, c.clock.now());
      if (f.kind === "dead") {
        // 4.5.k: id, код і клас із закритого списку — без сирого `description` (у ньому може бути назва ліків)
        console.error("dispatch: routine chat unavailable, cancelled", r.id, f.code, errorClass(err));
        await drop(r);
        continue;
      }
      await releaseLease(userId, c.db, r.id, f.kind === "rate" ? f.until : null);
      c.unsent.delete(r.id);
      return; // 429/5xx: спроба наступним тиком (S2.3)
    }
    const sentAt = c.clock.now();
    c.unsent.delete(r.id); // відправлено: оренда лишається, поки не закриємо
    try {
      const next = nextRepeat({ attempt: r.attempt, max_attempts: r.max_attempts, sent_at: sentAt });
      const closed = await closeRoutineSent(userId, c.db, r, { sentAt, tgMessageId: sent.message_id, variantIdx: idx }, next, sentAt);
      if (!closed) await c.api.deleteMessage(dl.tg_id, sent.message_id).catch(() => undefined); // відповідь випередила
    } catch (err) {
      console.error("dispatch: routine close failed", r.id, err instanceof Error ? err.name : "unknown"); // оренда збіжить — допустимий дубль
    }
  }
}
