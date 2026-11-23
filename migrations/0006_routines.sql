-- 0006: Фаза 4, крок 4.1 — ліки й рутини (docs/spec/phase-4.md, «Схема», S4.1).
-- Часи — UTC ms із коду. Головне тут — перебудова `reminders`: CHECK `0004` не пускає рядок без `item_id`, а SQLite
-- не змінює CHECK без перебудови таблиці (Р4.1). Рецепт: CREATE reminders_new → INSERT SELECT → перенос лічильника
-- AUTOINCREMENT → DROP → RENAME → індекси й тригер. Репетиція на preview з bookmark — 4.1.c (до prod, крок 4.3).

-- Батьківські ключі перевіряються в кінці міграції, а не по рядку (D1 не дає вимкнути foreign_keys, лише відкласти).
PRAGMA defer_foreign_keys = true;

-- ── routines: ліки чи звичка ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('med','habit')),
  -- length() у SQLite — символи, не байти; один рядок (char(10) — перенос)
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 64 AND instr(title, char(10)) = 0),
  -- JSON-масив "HH:MM", відсортований, без повторів; формат кожного елемента тримає код (src/routines/schedule.ts)
  times TEXT NOT NULL CHECK (json_valid(times) AND json_type(times) = 'array' AND json_array_length(times) BETWEEN 1 AND 6),
  days_mask INTEGER NOT NULL CHECK (days_mask BETWEEN 1 AND 127), -- біт 0 = понеділок … біт 6 = неділя
  escalate INTEGER NOT NULL CHECK (escalate IN (0,1)),            -- 1: ланцюг повторів до відповіді (med)
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),      -- 0 = на паузі
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_routines_user ON routines(user_id);

-- ── routine_logs: відповідь на слот, одна назавжди (принцип 3) ────────────────────────────────────────────
CREATE TABLE routine_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,        -- на нього посилається points_ledger.routine_log_id
  user_id INTEGER NOT NULL REFERENCES users(id),
  routine_id INTEGER NOT NULL REFERENCES routines(id),
  scheduled_for INTEGER NOT NULL,              -- slot_at слота (UTC ms)
  status TEXT NOT NULL CHECK (status IN ('taken','skipped','missed')),
  answered_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK ((status = 'missed') = (answered_at IS NULL)),
  UNIQUE (routine_id, scheduled_for)           -- відповідь на слот одна: тримає БД, не код (4.5.c)
);
CREATE INDEX ix_rlog_user_day ON routine_logs(user_id, scheduled_for);

-- ── reminders: перебудова (+ routine_id, slot_at, kind 'routine') ────────────────────────────────────────
-- Самопосилання — на reminders_new: якби вони вказували на стару `reminders`, DROP її (неявний DELETE) каскадом
-- стер би нову. RENAME нижче переписує `reminders_new` → `reminders` у тексті схеми.
CREATE TABLE reminders_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('due','eve_before','leave_now','repeat','timer','digest_morning','digest_evening','digest_weekly','routine')),
  fire_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 4),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 4),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','answered','cancelled')),
  parent_id INTEGER REFERENCES reminders_new(id) ON DELETE CASCADE,
  root_id INTEGER REFERENCES reminders_new(id) ON DELETE CASCADE,
  lease_until INTEGER,
  sent_at INTEGER,
  sent_as TEXT CHECK (sent_as IS NULL OR sent_as IN ('single','summary')),
  tg_message_id INTEGER,
  variant_idx INTEGER CHECK (variant_idx IS NULL OR variant_idx >= 0),
  created_at INTEGER NOT NULL,
  routine_id INTEGER REFERENCES routines(id),  -- рядок рутини: корінь 'routine' і його повтори 'repeat'
  slot_at INTEGER,                             -- мить слота; у «+15 хв» fire_at ≠ slot_at
  CHECK (attempt <= max_attempts),
  CHECK ((parent_id IS NULL) = (root_id IS NULL)),
  CHECK ((kind = 'repeat') = (parent_id IS NOT NULL)),
  CHECK ((status IN ('sent','answered')) = (sent_at IS NOT NULL)),
  CHECK ((sent_at IS NULL) = (sent_as IS NULL)),
  CHECK ((routine_id IS NULL) = (slot_at IS NULL)),
  CHECK (item_id IS NULL OR routine_id IS NULL),
  -- форма рядка за видом; CASE вичерпний — невідомий kind не проходить (ELSE 0)
  CHECK (CASE
    WHEN kind IN ('due','eve_before','leave_now') THEN item_id IS NOT NULL
    WHEN kind = 'routine' THEN routine_id IS NOT NULL
    WHEN kind = 'repeat' THEN item_id IS NOT NULL OR routine_id IS NOT NULL
    WHEN kind IN ('digest_morning','digest_evening','digest_weekly') THEN item_id IS NULL AND routine_id IS NULL
    WHEN kind = 'timer' THEN routine_id IS NULL
    ELSE 0
  END)
);

-- Кожне поле кожного рядка; ORDER BY id — батько й корінь ланцюга завжди старші за нащадка.
INSERT INTO reminders_new (id, user_id, item_id, kind, fire_at, attempt, max_attempts, status, parent_id, root_id,
                           lease_until, sent_at, sent_as, tg_message_id, variant_idx, created_at, routine_id, slot_at)
SELECT id, user_id, item_id, kind, fire_at, attempt, max_attempts, status, parent_id, root_id,
       lease_until, sent_at, sent_as, tg_message_id, variant_idx, created_at, NULL, NULL
FROM reminders ORDER BY id;

-- Лічильник AUTOINCREMENT переноситься (S4.1, рев'ю 4.0 Б2): INSERT SELECT ставить seq = max(id) вижилих, і id
-- видаленого найбільшого рядка дістався б новому нагадуванню — ✅ зі старого повідомлення закрив би чужу справу.
-- DROP прибирає рядок 'reminders', RENAME перейменовує 'reminders_new' → 'reminders'.
DELETE FROM sqlite_sequence WHERE name = 'reminders_new';
INSERT INTO sqlite_sequence (name, seq) SELECT 'reminders_new', seq FROM sqlite_sequence WHERE name = 'reminders';

DROP TABLE reminders;
ALTER TABLE reminders_new RENAME TO reminders;

-- Індекси 0004 і 0005 — без змін.
CREATE INDEX ix_rem_due ON reminders(status, fire_at);
CREATE INDEX ix_rem_item ON reminders(item_id);
CREATE INDEX ix_rem_user_sent ON reminders(user_id, sent_at);
CREATE UNIQUE INDEX ux_rem_root ON reminders(item_id, kind, fire_at) WHERE parent_id IS NULL AND status <> 'cancelled';
CREATE UNIQUE INDEX ux_rem_child ON reminders(parent_id) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX ux_rem_digest_pending ON reminders(user_id, kind)
  WHERE kind IN ('digest_morning','digest_evening','digest_weekly') AND status = 'pending';

-- Тригер 0005 — без змін (DROP TABLE забрав його разом зі старою таблицею).
CREATE TRIGGER trg_rem_digest_shape BEFORE INSERT ON reminders
WHEN NEW.kind IN ('digest_morning','digest_evening','digest_weekly')
BEGIN
  SELECT RAISE(ABORT, 'digest row shape')
  WHERE NEW.item_id IS NOT NULL OR NEW.parent_id IS NOT NULL OR NEW.attempt <> 1 OR NEW.max_attempts <> 1;
END;

-- Нове (Фаза 4): у слота не більше одного майбутнього кореня; рядки слота — за (routine_id, slot_at).
CREATE UNIQUE INDEX ux_rem_routine_pending ON reminders(routine_id, slot_at)
  WHERE parent_id IS NULL AND routine_id IS NOT NULL AND status = 'pending';
CREATE INDEX ix_rem_routine ON reminders(routine_id, slot_at) WHERE routine_id IS NOT NULL;

-- ── points_ledger: «✅» на слот ────────────────────────────────────────────────────────────────────────────
ALTER TABLE points_ledger ADD COLUMN routine_log_id INTEGER REFERENCES routine_logs(id)
  CHECK (routine_log_id IS NULL OR (reason = 'done' AND item_id IS NULL));
-- одне «✅» на слот назавжди: ux_ledger_done за item_id тут нічого не тримає (NULL ≠ NULL)
CREATE UNIQUE INDEX ux_ledger_routine_done ON points_ledger(routine_log_id) WHERE reason = 'done' AND routine_log_id IS NOT NULL;

-- ── routine_drafts: чернетка майстра, одна на користувача (Р4.2) ─────────────────────────────────────────
CREATE TABLE routine_drafts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  routine_id INTEGER REFERENCES routines(id),  -- NOT NULL — редагування наявної рутини (S4.7)
  step TEXT NOT NULL CHECK (step IN ('kind','title','times','days','confirm')),
  kind TEXT CHECK (kind IS NULL OR kind IN ('med','habit')),
  title TEXT CHECK (title IS NULL OR (length(title) BETWEEN 1 AND 64 AND instr(title, char(10)) = 0)),
  times TEXT CHECK (times IS NULL OR (json_valid(times) AND json_type(times) = 'array' AND json_array_length(times) <= 6)),
  days_mask INTEGER CHECK (days_mask IS NULL OR days_mask BETWEEN 0 AND 127), -- 0 — проміжний стан перемикачів (4.2.d)
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- ── routine_inputs: повідомлення, які забрав майстер (Р4.4) ──────────────────────────────────────────────
CREATE TABLE routine_inputs (
  user_id INTEGER NOT NULL REFERENCES users(id),
  tg_update_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tg_update_id)
);

-- Один простір update_id (як tg_captures_not_fix, 0002): повтор доставки назви не стає захопленням чи виправленням.
CREATE TRIGGER tg_captures_not_routine_input BEFORE INSERT ON captures
WHEN EXISTS (SELECT 1 FROM routine_inputs WHERE user_id = NEW.user_id AND tg_update_id = NEW.tg_update_id)
BEGIN SELECT RAISE(ABORT, 'update is a routine input'); END;

CREATE TRIGGER tg_fixes_not_routine_input BEFORE INSERT ON capture_fixes
WHEN EXISTS (SELECT 1 FROM routine_inputs WHERE user_id = NEW.user_id AND tg_update_id = NEW.tg_update_id)
BEGIN SELECT RAISE(ABORT, 'update is a routine input'); END;

-- ── users: пам'ять варіантів тостів (НФ-4); «+15 хв» бере наявний ack_later_idx ─────────────────────────
ALTER TABLE users ADD COLUMN ack_taken_idx INTEGER CHECK (ack_taken_idx IS NULL OR ack_taken_idx >= 0);
ALTER TABLE users ADD COLUMN ack_skip_idx INTEGER CHECK (ack_skip_idx IS NULL OR ack_skip_idx >= 0);
