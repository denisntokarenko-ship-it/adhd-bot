import type { Db } from "./index";
import { DONE_POINTS } from "../reminders/plan";
import { d1Of } from "./index";

// Журнал очок (S1.9). Лише дописується; баланс — SUM(delta), нічого не зберігається.
// Способів писати два: +1 за захоплення (Фаза 1) і +10 «зроблено» (крок 2.2). Загальної `add(delta, reason)` свідомо
// немає: інші причини й від'ємний delta (redeem) — Фази 3–6, і охоронець (S1.9.e) перелічує експорти цього файлу.

// +1 за захоплення (S1.9.a) як частина `DB.batch` разом з INSERT самого захоплення (НФ-3).
// Захоплення шукається за (user_id, tg_update_id): після дубля доставки INSERT захоплення нічого не робить,
// а ledger-рядок упирається в `ux_ledger_capture` і тихо пропускається. ON CONFLICT, не OR IGNORE:
// OR IGNORE мовчки ковтав би й порушення CHECK.
export function captureStatement(userId: number, db: Db, tgUpdateId: number, now: number): D1PreparedStatement {
  return d1Of(db)
    .prepare(
      `INSERT INTO points_ledger (user_id, delta, reason, capture_id, created_at)
       SELECT ?1, 1, 'capture', id, ?3 FROM captures WHERE user_id = ?1 AND tg_update_id = ?2
       ON CONFLICT DO NOTHING`,
    )
    .bind(userId, tgUpdateId, now);
}

// +10 «зроблено» (S2.4.a) як частина `DB.batch` ✅: пишеться, лише поки запис ще `open` (до того, як той самий batch
// закриє його), а друге «зроблено» на запис назавжди відсікає `ux_ledger_done` у БД (S2.4.b). Однаково за вчасний
// і запізнілий ✅ (правило 6): жодних бонусів і штрафів за точність.
export function doneStatement(userId: number, db: Db, itemId: number, now: number): D1PreparedStatement {
  return d1Of(db)
    .prepare(
      `INSERT INTO points_ledger (user_id, delta, reason, item_id, created_at)
       SELECT ?1, ?4, 'done', id, ?3 FROM items WHERE id = ?2 AND user_id = ?1 AND status = 'open'
       ON CONFLICT DO NOTHING`,
    )
    .bind(userId, itemId, now, DONE_POINTS);
}

export async function balance(userId: number, db: Db): Promise<number> {
  const row = await d1Of(db)
    .prepare("SELECT COALESCE(SUM(delta), 0) AS total FROM points_ledger WHERE user_id = ?1")
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export interface LedgerRow {
  id: number;
  delta: number;
  reason: string;
  item_id: number | null;
  capture_id: number | null;
  created_at: number;
}

// Для /export (S1.11): без user_id у виводі.
export async function listForExport(userId: number, db: Db): Promise<LedgerRow[]> {
  const res = await d1Of(db)
    .prepare("SELECT id, delta, reason, item_id, capture_id, created_at FROM points_ledger WHERE user_id = ?1 ORDER BY id")
    .bind(userId)
    .all<LedgerRow>();
  return res.results;
}
