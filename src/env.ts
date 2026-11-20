// Тип оточення = згенероване `wrangler types` (worker-configuration.d.ts) + секрети й змінна деплою,
// яких у wrangler.toml немає. Усе необов'язкове: відсутній секрет = fail-closed, а не падіння.
export type AppEnv = Env & {
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> }; // Workers AI (Whisper); у тестах підміняється через deps.stt
  BOT_TOKEN?: string;
  WEBHOOK_SECRET?: string;
  ALLOWED_TG_IDS?: string;
  MONITOR_PING_URL?: string; // секрет: URL пінгу зовнішнього монітора (НФ-6); у логи й /health не потрапляє
  ANTHROPIC_API_KEY?: string; // секрет (НФ-8): `wrangler secret put ANTHROPIC_API_KEY --env …`; у логи й /health не потрапляє
  AI_MODEL_PARSE?: string; // необов'язкова зміна моделі розбору; за замовчуванням — config.ts
  AI_DAILY_LIMIT?: string; // необов'язкова зміна ліміту викликів ШІ на добу; за замовчуванням 100 (НФ-5)
  GIT_SHA?: string;
};
