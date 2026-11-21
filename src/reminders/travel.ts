// Питання «скільки добиратись?» після квитанції про подію з часом (docs/spec/phase-2.md, S2.7.a).
// Один шлях для живої квитанції (capture.ts) і для квитанції з cron-повтору розбору (retry.ts): питання йде слідом
// за квитанцією, а не за часом події. Питання без відповіді нічого не блокує й не повторюється (S2.7.c).
import type { Db } from "../db/index";
import { listByCapture } from "../db/items";
import { claimTravelAsk } from "../db/reminders";
import { TRAVEL_ASK_POOL, pickVariant } from "../texts";
import { travelMessage, type Keyboard } from "./render";

export interface AskDeps {
  db: Db;
  userId: number;
  tz: string;
  now: number;
  rand: () => number;
}

export type SendQuestion = (text: string, keyboard: Keyboard) => Promise<unknown>;

// Для кожної події з часом цього захоплення, що ще попереду й про яку ще не питали: захоплення `travel_asked_at`, потім
// повідомлення. Не кидає: збій питання не ламає квитанцію, що вже пішла (запис і так збережено).
export async function askTravel(d: AskDeps, captureId: number, send: SendQuestion): Promise<void> {
  try {
    for (const it of await listByCapture(d.userId, d.db, captureId)) {
      if (it.kind !== "event" || it.status !== "open" || it.all_day === 1 || it.due_at === null || it.due_at <= d.now) continue;
      if (!(await claimTravelAsk(d.userId, d.db, it.id, d.now))) continue;
      const head = TRAVEL_ASK_POOL[pickVariant(TRAVEL_ASK_POOL.length, null, d.rand)] ?? TRAVEL_ASK_POOL[0] ?? "";
      const m = travelMessage(head, it.title, it.due_at, d.tz, d.now, it.id);
      await send(m.text, m.keyboard);
    }
  } catch {
    console.error("travel: question failed"); // без тексту й id
  }
}
