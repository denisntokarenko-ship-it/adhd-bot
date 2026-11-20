// Збій, після якого НІЧОГО не збережено: вебхук відповідає 500, Telegram повторить доставку (S1.4.h).
// Усі інші помилки обробки (уже щось записано) — 200, щоб отруйний update не блокував чергу (0.7.a).
export class RetryableError extends Error {
  constructor(cause?: unknown) {
    super("retryable: nothing was saved");
    this.name = "RetryableError";
    this.cause = cause;
  }
}
