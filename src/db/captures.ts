import { d1Of, type Db } from "./index";
import { noteFromText } from "../note";
import { VOICE_PENDING_TITLE } from "../texts";
import { insertStatement, type NewItem } from "./items";
import { captureStatement } from "./points";

export type CaptureSource = "text" | "voice" | "forward";
export type CaptureStatus = "pending" | "parsed" | "gave_up";

export interface Capture {
  id: number;
  user_id: number;
  tg_update_id: number;
  source: CaptureSource;
  raw_text: string | null; // NULL — голосове, яке ще не розпізнано (тоді є tg_file_id)
  tg_file_id: string | null;
  status: CaptureStatus;
  parse_attempts: number;
  next_try_at: number | null;
  receipt_message_id: number | null;
  variant_idx: number | null;
  fix_requested_at: number | null;
  created_at: number;
}

export const CAPTURE_COLUMNS =
  "id, user_id, tg_update_id, source, raw_text, tg_file_id, status, parse_attempts, next_try_at, receipt_message_id, variant_idx, fix_requested_at, created_at";

// «Оренда» нового захоплення (S1.4.c): якщо процес помре посеред виклику ШІ, після неї захоплення можна підібрати.
export const LEASE_MS = 120_000;
export const MAX_ATTEMPTS = 6; // після 6-ї невдачі — gave_up (S1.5.b)

type ParsedInput = Omit<NewItem, "captureId" | "rawText" | "source">;

export async function getById(userId: number, db: Db, id: number): Promise<Capture | null> {
  return d1Of(db)
    .prepare(`SELECT ${CAPTURE_COLUMNS} FROM captures WHERE id = ?1 AND user_id = ?2`)
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

// Нове захоплення — ДО виклику ШІ, як pending з орендою (S1.4.c), разом з очком +1 — ОДНИМ batch (S1.4.c, S1.9.a):
// захоплення без очка чи очко без захоплення неможливі. Очко дає саме створення, тож запасна нотатка, голосове без STT
// і пересилання його мають, а повтор розбору й виправлення — ні (S1.9.d).
// null — такий update_id уже є (дубль доставки): очка вдруге не буде (ux_ledger_capture).
export async function createPending(
  userId: number,
  db: Db,
  input: { tgUpdateId: number; source: CaptureSource; rawText: string | null; tgFileId?: string },
  now: number,
): Promise<Capture | null> {
  const d1 = d1Of(db);
  const res = await d1.batch<Capture>([
    d1
      .prepare(
        `INSERT INTO captures (user_id, tg_update_id, source, raw_text, tg_file_id, status, next_try_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?7, 'pending', ?5, ?6)
         ON CONFLICT(user_id, tg_update_id) DO NOTHING
         RETURNING ${CAPTURE_COLUMNS}`,
      )
      .bind(userId, input.tgUpdateId, input.source, input.rawText, now + LEASE_MS, now, input.tgFileId ?? null),
    captureStatement(userId, db, input.tgUpdateId, now),
  ]);
  return res[0]?.results[0] ?? null;
}

// Усі захоплення користувача для /export (S1.11): лише поля зі спеки, без tg_update_id/tg_file_id.
export interface CaptureExportRow {
  id: number;
  source: CaptureSource;
  raw_text: string | null;
  status: CaptureStatus;
  created_at: number;
}
export async function listForExport(userId: number, db: Db): Promise<CaptureExportRow[]> {
  const res = await d1Of(db)
    .prepare("SELECT id, source, raw_text, status, created_at FROM captures WHERE user_id = ?1 ORDER BY id")
    .bind(userId)
    .all<CaptureExportRow>();
  return res.results;
}

// Розбір вдався: захоплення → parsed і записи — ОДНИМ batch (НФ-3). Якщо це повтор після запасної нотатки (S1.5.d),
// нотатку (єдиний відкритий запис цього захоплення) видаляє той самий batch; для нового захоплення DELETE нічого не чіпає.
// `capture.raw_text` — актуальний текст (для голосового, розпізнаного вже в cron, — саме розпізнане).
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
    d1.prepare("DELETE FROM items WHERE user_id = ?1 AND capture_id = ?2 AND status = 'open'").bind(userId, capture.id),
    d1
      .prepare(
        "UPDATE captures SET status = 'parsed', next_try_at = NULL, variant_idx = ?3, raw_text = ?4 WHERE id = ?1 AND user_id = ?2",
      )
      .bind(capture.id, userId, variantIdx, capture.raw_text),
    ...items.map((it) =>
      insertStatement(userId, db, { ...it, captureId: capture.id, rawText: capture.raw_text, source: capture.source }, now),
    ),
  ]);
}

// Запасна нотатка захоплення: з тексту (`noteFromText`, S1.5.a) чи заглушка для голосового без розпізнавання (S1.7.d).
function fallbackNote(capture: Capture, text: string | null) {
  const note = text === null ? null : noteFromText(text);
  return {
    kind: "note" as const,
    title: note === null ? VOICE_PENDING_TITLE : note.title,
    body: note === null ? null : note.body,
    captureId: capture.id,
    rawText: text,
    source: capture.source,
  };
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
  const d1 = d1Of(db);
  const attempts = reason === "limit" ? capture.parse_attempts : capture.parse_attempts + 1;
  await d1.batch([
    d1
      .prepare("UPDATE captures SET parse_attempts = ?3, next_try_at = ?4, variant_idx = ?5 WHERE id = ?1 AND user_id = ?2")
      .bind(capture.id, userId, attempts, retryAt, variantIdx),
    insertStatement(userId, db, fallbackNote(capture, capture.raw_text), now),
  ]);
}

// ── Cron-повтор pending (S1.5.b–e, S1.7.d) ────────────────────────────────────────────────────────────────────

// Голосове розпізнано вже в cron: зберегти текст і замінити заглушку «Голосове — розберу пізніше» нотаткою з цього тексту.
// Один batch: якщо далі ШІ знову впаде, STT вдруге не кликатимемо (raw_text уже є).
export async function storeTranscript(userId: number, db: Db, capture: Capture, text: string, now: number): Promise<void> {
  const d1 = d1Of(db);
  await d1.batch([
    d1.prepare("UPDATE captures SET raw_text = ?3 WHERE id = ?1 AND user_id = ?2").bind(capture.id, userId, text),
    d1.prepare("DELETE FROM items WHERE user_id = ?1 AND capture_id = ?2 AND status = 'open'").bind(userId, capture.id),
    insertStatement(userId, db, fallbackNote(capture, text), now),
  ]);
}

// Повтор не вдався. `attempts` — нове значення лічильника (при ліміті доби — старе: спроба не витрачається);
// `nextTryAt === null` — gave_up (S1.5.b): нотатка лишається, людині тиша. Якщо в захоплення немає жодного запису
// (збій D1 між createPending і нотаткою, шов 5), запасну нотатку створюємо тут: запис не губиться.
export async function markRetryFailed(
  userId: number,
  db: Db,
  capture: Capture,
  attempts: number,
  nextTryAt: number | null,
  now: number,
): Promise<void> {
  const d1 = d1Of(db);
  const has = await d1
    .prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = ?1 AND capture_id = ?2")
    .bind(userId, capture.id)
    .first<{ n: number }>();
  await d1.batch([
    d1
      .prepare("UPDATE captures SET parse_attempts = ?3, next_try_at = ?4, status = ?5 WHERE id = ?1 AND user_id = ?2")
      .bind(capture.id, userId, attempts, nextTryAt, nextTryAt === null ? "gave_up" : "pending"),
    ...((has?.n ?? 0) === 0 ? [insertStatement(userId, db, fallbackNote(capture, capture.raw_text), now)] : []),
  ]);
}

// Повтор безнадійний (розпізнане порожнє — у голосовому лише тиша): більше не підбирати, заглушка лишається.
export async function giveUp(userId: number, db: Db, captureId: number): Promise<void> {
  await d1Of(db)
    .prepare("UPDATE captures SET status = 'gave_up', next_try_at = NULL WHERE id = ?1 AND user_id = ?2")
    .bind(captureId, userId)
    .run();
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
        `UPDATE captures SET fix_requested_at = ?3 WHERE id = ?1 AND user_id = ?2 AND status = 'parsed' RETURNING ${CAPTURE_COLUMNS}`,
      )
      .bind(captureId, userId, now),
  ]);
  return res[1]?.results[0] ?? null;
}

// Захоплення, що чекає виправлення в межах вікна. Вікно закінчилось → null (повідомлення — звичайний новий запис, S1.6.c).
export async function activeFix(userId: number, db: Db, now: number, windowMs: number): Promise<Capture | null> {
  return d1Of(db)
    .prepare(
      `SELECT ${CAPTURE_COLUMNS} FROM captures
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
