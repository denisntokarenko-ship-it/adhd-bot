// Планувальник рутин (docs/spec/phase-4.md, S4.4, S4.6): кожен тик cron, після записів і оглядів, до відправки.
// (1) `missed` — слотам, чий ланцюг вичерпано без відповіді 30 хв (мовчки: ні повідомлення, ні очок);
// (2) корінь найближчого слота кожної активної рутини без майбутнього кореня (Р4.10). Ідемпотентність — у БД.
import type { Db } from "../db/index";
import { insertRoutineRoot, logAnswer } from "../db/routines";
import { listRoutinesToPlan, listUnansweredRoutineSlots } from "../db/system";
import { MISSED_AFTER_MS, nextRoutineSlot } from "./schedule";

export interface RoutinesPlanned {
  missed: number;
  roots: number;
}

export async function planRoutines(db: Db, now: number): Promise<RoutinesPlanned> {
  const out = { missed: 0, roots: 0 };
  for (const s of await listUnansweredRoutineSlots(db, now, MISSED_AFTER_MS)) {
    try {
      if ((await logAnswer(s.user_id, db, s.routine_id, s.slot_at, "missed", now)) !== null) out.missed += 1;
    } catch (err) {
      console.error("routine planner: missed failed", s.user_id, s.routine_id, err instanceof Error ? err.name : "unknown"); // id, без назви
    }
  }
  for (const r of await listRoutinesToPlan(db)) {
    try {
      const slot = nextRoutineSlot({ times: JSON.parse(r.times) as string[], days_mask: r.days_mask }, r.tz, now);
      if (await insertRoutineRoot(r.user_id, db, r.id, slot, now)) out.roots += 1;
    } catch (err) {
      console.error("routine planner: routine failed", r.user_id, r.id, err instanceof Error ? err.name : "unknown");
    }
  }
  return out;
}
