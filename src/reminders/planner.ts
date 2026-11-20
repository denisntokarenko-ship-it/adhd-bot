// Планувальник нагадувань (docs/spec/phase-2.md, «Звідки береться нагадування»): нагадування — похідний стан.
// Рядки створює cron із записів, а не код захоплення, тож будь-який шлях запису (текст, голос, пересилання,
// повтор розбору, «не так») нічого не забуде. Кожен запис — окремий batch: збій одного не блокує інших.
import type { Db } from "../db/index";
import { planItem } from "../db/reminders";
import { listUnplannedItems } from "../db/system";
import { PLAN_LIMIT, plannedFor } from "./plan";

export interface PlanResult {
  items: number;
  rows: number;
}

export async function planReminders(db: Db, now: number): Promise<PlanResult> {
  const items = await listUnplannedItems(db, PLAN_LIMIT);
  let rows = 0;
  for (const it of items) {
    try {
      rows += await planItem(it.user_id, db, it.id, plannedFor(it, now, it), now);
    } catch (err) {
      console.error("planner: item failed", it.id, err instanceof Error ? err.name : "unknown"); // id, без тексту
    }
  }
  return { items: items.length, rows };
}
