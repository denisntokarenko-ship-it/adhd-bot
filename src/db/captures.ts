import { d1Of, type Db } from "./index";
import { insertStatement, type NewItem } from "./items";

export type CaptureSource = "text" | "voice" | "forward";
export type CaptureStatus = "pending" | "parsed" | "gave_up";

export interface Capture {
  id: number;
  user_id: number;
  tg_update_id: number;
  source: CaptureSource;
  raw_text: string | null;
  status: CaptureStatus;
  parse_attempts: number;
  next_try_at: number | null;
  receipt_message_id: number | null;
  variant_idx: number | null;
  fix_requested_at: number | null;
  created_at: number;
}

const COLUMNS =
  "id, user_id, tg_update_id, source, raw_text, status, parse_attempts, next_try_at, receipt_message_id, variant_idx, fix_requested_at, created_at";

// «Оренда» нового захоплення (S1.4.c): якщо процес помре посеред виклику ШІ, після неї захоплення можна підібрати.
export const LEASE_MS = 120_000;
const FALLBACK_TITLE_LEN = 80;

type ParsedInput = Omit<NewItem, "captureId" | "rawText" | "source">;

export async function getById(userId: number, db: Db, id: number): Promise<Capture | null> {
  return d1Of(db)
    .prepare(`SELECT ${COLUMNS} FROM captures WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<Capture>();
}

// Цей update_id уже оброблено як захоплення або як виправлення? (НФ-7, S1.6.i) Перевірка до ШІ; UNIQUE і тригери — страховка.
export async function isKnownUpdate(userId: number, db: Db, tgUpdateId: number): Promise<boolean> {
  const row = await d1Of(db)
    .prepare(
      `SELECT (SELECT COUNT(*) FROM captures WHERE user_id = ?1 AND tg_update_id = ?2)
            + (SELECT COUNT(*) FROM capture_fixes WHERE user_id = ?1 AND tg_update_id = ?2) AS n`,
    )
    .bind(userId, tgUpdateId)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

// Нове захоплення — ДО виклику ШІ, як pending з орендою (S1.4.c). null — такий update_id уже є (дубль доставки).
export async function createPending(
  userId: number,
  db: Db,
  input: { tgUpdateId: number; source: CaptureSource; rawText: string },
  now: number,
): Promise<Capture | null> {
  return d1Of(db)
    .prepare(
      `INSERT INTO captures (user_id, tg_update_id, source, raw_text, status, next_try_at, created_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)
       ON CONFLICT(user_id, tg_update_id) DO NOTHING
       RETURNING ${COLUMNS}`,
    )
    .bind(userId, input.tgUpdateId, input.source, input.rawText, now + LEASE_MS, now)
    .first<Capture>();
}

// Розбір вдався: захоплення → parsed і записи — ОДНИМ batch (НФ-3).
export async function markParsed(
  userId: number,
  db: Db,
  capture: Capture,
  items: ParsedInput[],
  variantIdx: number,
  now: number,
): Promise<void> {
  const d1 = d1Of(db);
  await d1.batch([
    d1
      .prepare("UPDATE captures SET status = 'parsed', next_try_at = NULL, variant_idx = ?3 WHERE id = ?1 AND user_id = ?2")
      .bind(capture.id, userId, variantIdx),
    ...items.map((it) =>
      insertStatement(userId, db, { ...it, captureId: capture.id, rawText: capture.raw_text, source: capture.source }, now),
    ),
  ]);
}

// ШІ недоступний (S1.5.a): запасна нотатка з raw_text, захоплення лишається pending для повтору.
// `limit` — ліміт доби: спроба не витрачається, повтор — на початок наступної доби (`retryAt`).
export async function saveFallback(
  userId: number,
  db: Db,
  capture: Capture,
  reason: "unavailable" | "limit",
  retryAt: number,
  variantIdx: number,
  now: number,
): Promise<void> {
  const raw = capture.raw_text ?? "";
  const flat = raw.replace(/\s+/g, " ").trim();
  const title = Array.from(flat).slice(0, FALLBACK_TITLE_LEN).join("").trim() || "Нотатка";
  const d1 = d1Of(db);
  const attempts = reason === "limit" ? capture.parse_attempts : capture.parse_attempts + 1;
  await d1.batch([
    d1
      .prepare("UPDATE captures SET parse_attempts = ?3, next_try_at = ?4, variant_idx = ?5 WHERE id = ?1 AND user_id = ?2")
      .bind(capture.id, userId, attempts, retryAt, variantIdx),
    insertStatement(
      userId,
      db,
      {
        kind: "note",
        title,
        body: raw.length > 0 ? Array.from(raw).slice(0, 4000).join("") : null,
        captureId: capture.id,
        rawText: raw,
        source: capture.source,
      },
      now,
    ),
  ]);
}

export async function setReceipt(userId: number, db: Db, captureId: number, messageId: number): Promise<void> {
  await d1Of(db)
    .prepare("UPDATE captures SET receipt_message_id = ?3 WHERE id = ?1 AND user_id = ?2")
    .bind(captureId, userId, messageId)
    .run();
}

// Варіант тексту попереднього захоплення (НФ-4: підряд не повторювати; пам'ять isolate не рахується).
export async function lastVariantIdx(userId: number, db: Db, exceptCaptureId: number): Promise<number | null> {
  const row = await d1Of(db)
    .prepare(
      "SELECT variant_idx FROM captures WHERE user_id = ?1 AND id <> ?2 AND variant_idx IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .bind(userId, exceptCaptureId)
    .first<{ variant_idx: number }>();
  return row?.variant_idx ?? null;
}

// «Не так»/«Уточнити» (S1.6.a): стан очікування — у самому рядку захоплення. На інших захопленнях користувача
// очищається. Лише розібрані захоплення (у запасної нотатки кнопок немає). null — чужий, неіснуючий чи не parsed.
export async function requestFix(userId: number, db: Db, captureId: number, now: number): Promise<Capture | null> {
  const d1 = d1Of(db);
  const res = await d1.batch<Capture>([
    d1
      .prepare("UPDATE captures SET fix_requested_at = NULL WHERE user_id = ?1 AND id <> ?2 AND fix_requested_at IS NOT NULL")
      .bind(userId, captureId),
    d1
      .prepare(
        `UPDATE captures SET fix_requested_at = ?3 WHERE id = ?1 AND user_id = ?2 AND status = 'parsed' RETURNING ${COLUMNS}`,
      )
      .bind(captureId, userId, now),
  ]);
  return res[1]?.results[0] ?? null;
}

// Захоплення, що чекає виправлення в межах вікна. Вікно закінчилось → null (повідомлення — звичайний новий запис, S1.6.c).
export async function activeFix(userId: number, db: Db, now: number, windowMs: number): Promise<Capture | null> {
  return d1Of(db)
    .prepare(
      `SELECT ${COLUMNS} FROM captures
       WHERE user_id = ?1 AND fix_requested_at IS NOT NULL AND fix_requested_at >= ?2 AND status = 'parsed'
       ORDER BY fix_requested_at DESC LIMIT 1`,
    )
    .bind(userId, now - windowMs)
    .first<Capture>();
}

// Виправлення вдалось (S1.6.b): ОДИН batch — запис update_id виправлення (НФ-7), видалення відкритих записів цього
// захоплення, нові записи, зняття очікування. Ні кроку без решти.
export async function replaceItems(
  userId: number,
  db: Db,
  capture: Capture,
  fixUpdateId: number,
  items: ParsedInput[],
  variantIdx: number,
  now: number,
): Promise<void> {
  const d1 = d1Of(db);
  await d1.batch([
    d1
      .prepare("INSERT INTO capture_fixes (user_id, capture_id, tg_update_id, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(userId, capture.id, fixUpdateId, now),
    d1.prepare("DELETE FROM items WHERE user_id = ?1 AND capture_id = ?2 AND status = 'open'").bind(userId, capture.id),
    ...items.map((it) =>
      insertStatement(userId, db, { ...it, captureId: capture.id, rawText: capture.raw_text, source: capture.source }, now),
    ),
    d1
      .prepare("UPDATE captures SET fix_requested_at = NULL, variant_idx = ?3 WHERE id = ?1 AND user_id = ?2")
      .bind(capture.id, userId, variantIdx),
  ]);
}
