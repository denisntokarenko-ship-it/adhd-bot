// Що робити з рядком після помилки Telegram (S2.3.c): 429 — відкласти на `retry_after`; 400/403 — чат недоступний,
// рядок закрито; решта (5xx, мережа) — спроба не витрачена, рядок підбереться на наступному тику.
import { GrammyError } from "grammy";

export type SendFailure = { kind: "rate"; until: number } | { kind: "dead"; code: number } | { kind: "transient" };

export function classify(err: unknown, now: number): SendFailure {
  if (err instanceof GrammyError) {
    if (err.error_code === 429) return { kind: "rate", until: now + (err.parameters?.retry_after ?? 30) * 1000 };
    if (err.error_code === 400 || err.error_code === 403) return { kind: "dead", code: err.error_code };
  }
  return { kind: "transient" };
}

// Закритий список класів помилки для логу оглядів (S3.1.h, борг R-2 Д4). Сирий `description` не логується ніколи:
// для зламаного HTML він містить назви тегів із чужих заголовків записів.
export type ErrorClass = "parse_entities" | "too_long" | "chat_unavailable" | "other";

export function errorClass(err: unknown): ErrorClass {
  if (!(err instanceof GrammyError)) return "other";
  const d = (err.description ?? "").toLowerCase();
  if (d.includes("can't parse entities")) return "parse_entities";
  if (d.includes("message is too long")) return "too_long";
  if (err.error_code === 403 || d.includes("chat not found")) return "chat_unavailable";
  return "other";
}
