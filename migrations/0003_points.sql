-- 0003 (крок 1.5): журнал очок + індекс варіанта порожнього /today.
-- Журнал лише дописується; баланс = SUM(delta), не зберігається (НФ-3, S1.9).
-- Повний перелік reason — одразу (план): SQLite не вміє змінити CHECK без перебудови таблиці.
-- У Фазі 1 пишеться лише 'capture'; решта — запас для Фаз 2–6.
CREATE TABLE points_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('capture','start','step','done','release','comeback','bonus','achievement','redeem')),
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  capture_id INTEGER REFERENCES captures(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  -- мінус лише redeem і redeem лише мінус; нуль — ніколи (рішення рев'ю 0.2, В1: суворіше за «delta >= 0 OR redeem»)
  CHECK (delta <> 0 AND (reason = 'redeem') = (delta < 0)),
  -- інакше NULL обходить UNIQUE нижче (у SQLite NULL-и в унікальному індексі різні)
  CHECK (reason <> 'capture' OR capture_id IS NOT NULL)
);
-- Одне очко на захоплення — у БД, а не перевіркою в коді (НФ-7, S1.9.a).
CREATE UNIQUE INDEX ux_ledger_capture ON points_ledger(capture_id) WHERE reason = 'capture';
CREATE INDEX ix_ledger_user ON points_ledger(user_id);

-- Порожній /today — пул фраз; підряд не повторюється, індекс у БД (НФ-4).
ALTER TABLE users ADD COLUMN today_variant_idx INTEGER CHECK (today_variant_idx IS NULL OR today_variant_idx >= 0);
