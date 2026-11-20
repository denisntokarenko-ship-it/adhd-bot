import { defineConfig } from "vitest/config";

// Крок 0.3: звичайний Node-раннер. Пул Workers + D1 підключає крок 0.4 (потрібен wrangler.toml).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
