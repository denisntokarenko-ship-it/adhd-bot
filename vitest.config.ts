import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Два проєкти: «node» (скани файлів, парсинг wrangler.toml, тексти) і «workers»
// (код у workerd + D1 у Miniflare за Рішенням 0.3 у PROGRESS.md). Перед тестами міграції
// застосовує test/worker/setup.ts.
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "node", include: ["test/node/**/*.test.ts"] },
      },
      defineConfig(async () => {
        const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
        return {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.toml", environment: "preview" },
              // Біндинг AI завжди віддалений (Workers AI): тестам він не потрібен — STT підміняється через deps.stt,
              // а CI без облікових даних Cloudflare не мусить підіймати віддалену проксі-сесію.
              remoteBindings: false,
              miniflare: {
                // Окрема порожня база для тестів міграції `0006` (4.1.b): стан «0001–0005 + дані» → `0006`.
                // Основну `DB` setup.ts уже довів до останньої міграції.
                d1Databases: { MIG_DB: "mig-test" },
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  BOT_TOKEN: "123456789:TESTTOKEN",
                  WEBHOOK_SECRET: "test-webhook-secret",
                  ALLOWED_TG_IDS: "111, 222",
                  GIT_SHA: "abc123def456",
                },
              },
            }),
          ],
          test: {
            name: "workers",
            // SDK Anthropic тягне `standardwebhooks` (CJS із відносним require) — runner workerd не вміє його резолвити
            // (known-issues Cloudflare «Module resolution»): преcбандлюємо його оптимізатором Vite (deps.optimizer.ssr). Прод-бандл збирає wrangler/esbuild.
            deps: { optimizer: { ssr: { enabled: true, include: ["standardwebhooks"] } } },
            include: ["test/worker/**/*.test.ts"],
            setupFiles: ["./test/worker/setup.ts"],
          },
        };
      }),
    ],
  },
});
