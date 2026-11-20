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
              miniflare: {
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
            include: ["test/worker/**/*.test.ts"],
            setupFiles: ["./test/worker/setup.ts"],
          },
        };
      }),
    ],
  },
});
