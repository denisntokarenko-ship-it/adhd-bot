-- 0005: Фаза 3, крок 3.1 — огляди (docs/spec/phase-3.md, «Схема»).
-- users.morning_at / evening_at / weekly_dow уже є з 0001, `digest_*` — у CHECK kind з 0004: тут лише те, чого бракувало.

-- У користувача не більше одного майбутнього огляду кожного виду. `ux_rem_root` для item_id NULL нічого не тримає
-- (NULL ≠ NULL), тож ідемпотентність планування — цей частковий індекс. Другу відправку тієї ж доби тримає не індекс,
-- а межа в `nextDigestAt`; слот-індекс (user_id, kind, fire_at) прибрано з рев'ю 3.0 (Д2).
CREATE UNIQUE INDEX ux_rem_digest_pending ON reminders(user_id, kind)
  WHERE kind IN ('digest_morning','digest_evening','digest_weekly') AND status = 'pending';

-- Форма рядка огляду: без запису, без ланцюга, без повторів.
CREATE TRIGGER trg_rem_digest_shape BEFORE INSERT ON reminders
WHEN NEW.kind IN ('digest_morning','digest_evening','digest_weekly')
BEGIN
  SELECT RAISE(ABORT, 'digest row shape')
  WHERE NEW.item_id IS NOT NULL OR NEW.parent_id IS NOT NULL OR NEW.attempt <> 1 OR NEW.max_attempts <> 1;
END;

-- Тепла фраза порожнього ранку: коли була остання і який варіант (НФ-4: пам'ять у БД).
ALTER TABLE users ADD COLUMN warm_at INTEGER;
ALTER TABLE users ADD COLUMN warm_variant_idx INTEGER CHECK (warm_variant_idx IS NULL OR warm_variant_idx >= 0);
-- Пам'ять варіанта тосту «✅ сьогодні» тижневого огляду (S3.6).
ALTER TABLE users ADD COLUMN ack_today_idx INTEGER CHECK (ack_today_idx IS NULL OR ack_today_idx >= 0);
