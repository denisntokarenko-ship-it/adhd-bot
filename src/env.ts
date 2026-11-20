// Тип оточення = згенероване `wrangler types` (worker-configuration.d.ts) + секрети й змінна деплою,
// яких у wrangler.toml немає. Усе необов'язкове: відсутній секрет = fail-closed, а не падіння.
export type AppEnv = Env & {
  BOT_TOKEN?: string;
  WEBHOOK_SECRET?: string;
  ALLOWED_TG_IDS?: string;
  GIT_SHA?: string;
};
