// Планувальник оглядів (docs/spec/phase-3.md, S3.1): кожен тик cron доплановує користувачам відсутній `pending` огляд.
// Ланцюг самовідновлюється: розірваний вручну, скасований збоєм чи не створений (новий користувач) — відновиться за хвилину.
import { insertDigest } from "../db/digests";
import type { Db } from "../db/index";
import { listUsersMissingDigests } from "../db/system";
import { nextDigestAt } from "./schedule";

export async function planDigests(db: Db, now: number): Promise<number> {
  let added = 0;
  for (const m of await listUsersMissingDigests(db)) {
    try {
      const at = nextDigestAt(m.kind, m, now, m.last_sent_fire_at);
      if (await insertDigest(m.user_id, db, m.kind, at, now)) added += 1;
    } catch (err) {
      console.error("digest planner: user failed", m.user_id, m.kind, err instanceof Error ? err.name : "unknown"); // id, без тексту
    }
  }
  return added;
}
