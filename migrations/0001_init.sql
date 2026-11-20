-- 0001: Фаза 0 — users і heartbeat (docs/spec/phase-0.md, «Схема»).
-- Часи — UTC ms із коду (injectable clock), SQL-DEFAULT на час немає. Хвилини доби — 0..1439.

CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id       INTEGER NOT NULL UNIQUE,
  tz          TEXT    NOT NULL DEFAULT 'Europe/Kyiv' CHECK (length(tz) BETWEEN 1 AND 64),
  quiet_from  INTEGER NOT NULL DEFAULT 1380 CHECK (quiet_from  BETWEEN 0 AND 1439), -- 23:00
  quiet_to    INTEGER NOT NULL DEFAULT 480  CHECK (quiet_to    BETWEEN 0 AND 1439), -- 08:00; рівні = тихих годин немає
  morning_at  INTEGER NOT NULL DEFAULT 540  CHECK (morning_at  BETWEEN 0 AND 1439), -- 09:00
  evening_at  INTEGER NOT NULL DEFAULT 1260 CHECK (evening_at  BETWEEN 0 AND 1439), -- 21:00
  weekly_dow  INTEGER NOT NULL DEFAULT 7    CHECK (weekly_dow  BETWEEN 1 AND 7),    -- ISO, 7 = неділя
  pause_until INTEGER,
  greet_variant_idx INTEGER CHECK (greet_variant_idx IS NULL OR greet_variant_idx >= 0), -- останній варіант вітання (НФ-4)
  soon_variant_idx  INTEGER CHECK (soon_variant_idx  IS NULL OR soon_variant_idx  >= 0), -- останній варіант «навчуся скоро»
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE heartbeat (
  key             TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 32),  -- у Фазі 0 єдиний ключ 'cron'
  last_run_at     INTEGER NOT NULL,
  last_ping_ok_at INTEGER                                                  -- останній успішний пінг монітора
);
