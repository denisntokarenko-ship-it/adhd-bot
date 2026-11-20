import { dayBounds } from "../time";
import { d1Of, type Db } from "./index";

export type AiPurpose = "parse" | "fix" | "steps" | "ask";
export type AiError = "timeout" | "http" | "json" | "schema";

// Лише лічильники й мітка ok — без тексту користувача чи відповіді (НФ-2).
export interface NewAiCall {
  model: string;
  purpose: AiPurpose;
  ok: boolean;
  error?: AiError | null;
  captureId?: number | null;
  inputTokens?: number;
  outputTokens?: number;
}

export async function log(userId: number, db: Db, call: NewAiCall, now: number): Promise<void> {
  await d1Of(db)
    .prepare(
      `INSERT INTO ai_calls (user_id, capture_id, model, purpose, ok, error, input_tokens, output_tokens, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      userId,
      call.captureId ?? null,
      call.model,
      call.purpose,
      call.ok ? 1 : 0,
      call.error ?? null,
      call.inputTokens ?? 0,
      call.outputTokens ?? 0,
      now,
    )
    .run();
}

// Скільки викликів ШІ (усіх purpose, успішних і ні) зроблено за добу `now` у часовому поясі `tz` — для ліміту НФ-5.
// Доба — локальна, не UTC: виклик о 23:30 UTC взимку вже належить наступній київській добі.
export async function countToday(userId: number, db: Db, tz: string, now: number): Promise<number> {
  const [from, to] = dayBounds(tz, now);
  const row = await d1Of(db)
    .prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ?1 AND created_at >= ?2 AND created_at < ?3")
    .bind(userId, from, to)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
