-- 0004: Фаза 2, крок 2.1 — черга нагадувань (docs/spec/phase-2.md, «Схема»).
-- Часи — UTC ms із коду, SQL-DEFAULT на час немає. users.quiet_from/quiet_to/pause_until уже є з 0001 (ALTER не треба).
-- Відхилення від PLAN.md: без routine_id (у SQLite NULL ≠ NULL — UNIQUE з ним не тримав би ідемпотентність; додасть Фаза 4).

CREATE TABLE reminders (                      -- одна запланована відправка; рядок — похідний стан запису (планувальник у cron)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,       -- заміна записів «не так» прибирає нагадування сама
  -- повний перелік плану: SQLite не міняє CHECK без перебудови таблиці
  kind TEXT NOT NULL CHECK (kind IN ('due','eve_before','leave_now','repeat','timer','digest_morning','digest_evening','digest_weekly')),
  fire_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 4),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 4),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','answered','cancelled')),
  parent_id INTEGER REFERENCES reminders(id) ON DELETE CASCADE, -- попередня спроба ланцюга; NULL у кореня
  root_id INTEGER REFERENCES reminders(id) ON DELETE CASCADE,   -- перший рядок ланцюга; NULL у кореня
  lease_until INTEGER,                        -- оренда на час відправки: рядок не стає sent, доки не відправлений
  sent_at INTEGER,
  sent_as TEXT CHECK (sent_as IS NULL OR sent_as IN ('single','summary')),
  tg_message_id INTEGER,
  variant_idx INTEGER CHECK (variant_idx IS NULL OR variant_idx >= 0),
  created_at INTEGER NOT NULL,
  CHECK (attempt <= max_attempts),
  CHECK ((parent_id IS NULL) = (root_id IS NULL)),
  CHECK ((kind = 'repeat') = (parent_id IS NOT NULL)),
  CHECK ((status IN ('sent','answered')) = (sent_at IS NOT NULL)),
  CHECK ((sent_at IS NULL) = (sent_as IS NULL)),
  CHECK (kind IN ('digest_morning','digest_evening','digest_weekly','timer') OR item_id IS NOT NULL)
);
CREATE INDEX ix_rem_due ON reminders(status, fire_at);
CREATE INDEX ix_rem_item ON reminders(item_id);
CREATE INDEX ix_rem_user_sent ON reminders(user_id, sent_at);   -- лічильник пушів за годину (S2.6)
-- Ідемпотентність у БД, не в коді (НФ-7). Скасований корінь не блокує перепланування в ту саму мить (S2.7.g).
CREATE UNIQUE INDEX ux_rem_root ON reminders(item_id, kind, fire_at) WHERE parent_id IS NULL AND status <> 'cancelled';
-- У рядка не більше одного нащадка, хоч би скільки разів «відпрацювала» оренда.
CREATE UNIQUE INDEX ux_rem_child ON reminders(parent_id) WHERE parent_id IS NOT NULL;

ALTER TABLE items ADD COLUMN travel_asked_at INTEGER;  -- питання про дорогу задано раз (S2.7.a)
ALTER TABLE items ADD COLUMN planned_at INTEGER;       -- планувальник запис опрацював — навіть коли рядків вийшло 0
CREATE INDEX ix_items_status_due ON items(status, due_at);

-- одне «зроблено» на запис назавжди (S2.4.b)
CREATE UNIQUE INDEX ux_ledger_done ON points_ledger(item_id) WHERE reason = 'done';

-- пам'ять варіанта підтверджень — колонка на пул (НФ-4, S2.10.b)
ALTER TABLE users ADD COLUMN ack_ok_idx INTEGER CHECK (ack_ok_idx IS NULL OR ack_ok_idx >= 0);
ALTER TABLE users ADD COLUMN ack_later_idx INTEGER CHECK (ack_later_idx IS NULL OR ack_later_idx >= 0);
ALTER TABLE users ADD COLUMN ack_rel_idx INTEGER CHECK (ack_rel_idx IS NULL OR ack_rel_idx >= 0);
ALTER TABLE users ADD COLUMN ack_pause_idx INTEGER CHECK (ack_pause_idx IS NULL OR ack_pause_idx >= 0);
ALTER TABLE users ADD COLUMN ack_resume_idx INTEGER CHECK (ack_resume_idx IS NULL OR ack_resume_idx >= 0);
ALTER TABLE users ADD COLUMN ack_travel_idx INTEGER CHECK (ack_travel_idx IS NULL OR ack_travel_idx >= 0);
