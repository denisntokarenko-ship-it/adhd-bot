// Живий прогін розбору (крок 1.2) — запускає людина (👤): ключ вводить вона сама.
//
//   $env:ANTHROPIC_API_KEY = Read-Host "ANTHROPIC_API_KEY" -MaskInput
//   node scripts/live-parse.mjs
//   Remove-Item Env:ANTHROPIC_API_KEY
//
// Що відбувається: esbuild збирає src/ai/* у тимчасовий модуль, wrangler піднімає ЛОКАЛЬНИЙ D1 (Miniflare,
// міграції з migrations/), п'ять фраз ідуть у справжній Claude API. Preview-D1 і prod не чіпаються.
// Ключ читається лише з process.env і не друкується; помилки SDK виводяться без заголовків.
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { getPlatformProxy } from "wrangler";

const root = path.resolve(import.meta.dirname, "..");
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Немає ANTHROPIC_API_KEY у середовищі (див. команду на початку файлу).");
  process.exit(2);
}

execSync("npx wrangler d1 migrations apply DB --env preview --local", { cwd: root, stdio: "ignore" });

const dir = mkdtempSync(path.join(tmpdir(), "live-parse-"));
const outfile = path.join(dir, "entry.mjs");
let proxy;
try {
  await build({
    entryPoints: [path.join(root, "scripts/live-parse.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "error",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  proxy = await getPlatformProxy({ configPath: path.join(root, "wrangler.toml"), environment: "preview" });
  const { run } = await import(pathToFileURL(outfile).href);
  await run(proxy.env, apiKey);
} catch (e) {
  console.error(`збій живого прогону: ${e?.name ?? "Error"}${e?.status ? ` HTTP ${e.status}` : ""}`);
  process.exitCode = 1;
} finally {
  await proxy?.dispose();
  rmSync(dir, { recursive: true, force: true });
}
