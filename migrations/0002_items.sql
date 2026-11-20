-- 0002: Фаза 1, крок 1.1 — захоплення, записи, повнотекстовий пошук, журнал викликів ШІ (docs/spec/phase-1.md, «Схема»).
-- Часи — UTC ms із коду (injectable clock), SQL-DEFAULT на час немає.
-- Не тут (за завданням 1.1): points_ledger (крок 1.5), items.parent_id (5.1), items.person_id (7.2).
-- Колонки travel_min, snooze_count, done_at існують уже зараз, але до Фаз 2/5 порожні.

CREATE TABLE captures (                       -- одне вхідне повідомлення; одиниця ідемпотентності (НФ-7)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  tg_update_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('text','voice','forward')),
  raw_text TEXT CHECK (raw_text IS NULL OR length(raw_text) BETWEEN 1 AND 20000), -- NULL, поки голос не розпізнано
  tg_file_id TEXT,                            -- голосове, доки не розпізнане
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','parsed','gave_up')),
  parse_attempts INTEGER NOT NULL DEFAULT 0 CHECK (parse_attempts BETWEEN 0 AND 6),
  next_try_at INTEGER,                        -- pending: «оренда» і час повтору
  receipt_message_id INTEGER,
  variant_idx INTEGER,                        -- який варіант тексту квитанції (не повторювати підряд)
  fix_requested_at INTEGER,                   -- натиснуто «Не так»/«Уточнити»
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, tg_update_id),
  CHECK (raw_text IS NOT NULL OR tg_file_id IS NOT NULL),
  CHECK ((status = 'pending') = (next_try_at IS NOT NULL))
);
CREATE INDEX ix_captures_pending ON captures(status, next_try_at);

CREATE TABLE capture_fixes (                  -- update повідомлення-виправлення («Не так», S1.6): НФ-7
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  capture_id INTEGER NOT NULL REFERENCES captures(id),
  tg_update_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, tg_update_id)
);

-- один простір update_id на два шляхи: жоден не може бути і захопленням, і виправленням
CREATE TRIGGER tg_captures_not_fix BEFORE INSERT ON captures
WHEN EXISTS (SELECT 1 FROM capture_fixes WHERE user_id = NEW.user_id AND tg_update_id = NEW.tg_update_id)
BEGIN SELECT RAISE(ABORT, 'update is a fix'); END;

CREATE TRIGGER tg_fixes_not_capture BEFORE INSERT ON capture_fixes
WHEN EXISTS (SELECT 1 FROM captures WHERE user_id = NEW.user_id AND tg_update_id = NEW.tg_update_id)
BEGIN SELECT RAISE(ABORT, 'update is a capture'); END;

CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  capture_id INTEGER REFERENCES captures(id),
  kind TEXT NOT NULL CHECK (kind IN ('task','note','event')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body TEXT CHECK (body IS NULL OR length(body) <= 4000),
  raw_text TEXT,                              -- оригінал захоплення; NULL для голосового без розпізнавання
  source TEXT NOT NULL CHECK (source IN ('text','voice','forward','button')),
  due_at INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0,1)),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','important')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','released')),
  travel_min INTEGER CHECK (travel_min IS NULL OR travel_min BETWEEN 0 AND 600),
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  snooze_count INTEGER NOT NULL DEFAULT 0 CHECK (snooze_count >= 0),
  CHECK ((status = 'done') = (done_at IS NOT NULL)),
  CHECK (all_day = 0 OR due_at IS NOT NULL)
);
CREATE INDEX ix_items_user_status_due ON items(user_id, status, due_at);
CREATE INDEX ix_items_capture ON items(capture_id);

-- Пошук: FTS5 з external content (дані лише в items, індекс окремо). body скрізь через coalesce(body,''):
-- 'delete' мусить отримати рівно ті значення, що були проіндексовані, інакше індекс розсинхронізується.
-- separators 'ʼ' (U+02BC): ASCII ' і ’ (U+2019) unicode61 і так вважає розділювачами, а ʼ (апостроф українських
-- розкладок) — літера, що склеювала б «пʼятниця» в один токен і ховала від пошуку «п'ятниця». Перевірено на D1 preview.
CREATE VIRTUAL TABLE items_fts USING fts5(title, body, content='items', content_rowid='id',
                                          tokenize='unicode61 remove_diacritics 2 separators ''ʼ''');

CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, body) VALUES (new.id, new.title, coalesce(new.body, ''));
END;

CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.id, old.title, coalesce(old.body, ''));
END;

CREATE TRIGGER items_fts_au AFTER UPDATE OF title, body ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.id, old.title, coalesce(old.body, ''));
  INSERT INTO items_fts(rowid, title, body) VALUES (new.id, new.title, coalesce(new.body, ''));
END;

CREATE TABLE ai_calls (                       -- лише лічильники й мітка ok, без тексту (НФ-2)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  capture_id INTEGER REFERENCES captures(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('parse','fix','steps','ask')),
  ok INTEGER NOT NULL CHECK (ok IN (0,1)),
  error TEXT CHECK (error IN ('timeout','http','json','schema')),
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK ((ok = 1) = (error IS NULL))
);
CREATE INDEX ix_ai_calls_user_day ON ai_calls(user_id, created_at);
