// scripts/release-lib.mjs — чисті перевірки для scripts/release.sh (S3.10, крок 3.3).
// Bash лише запускає команди; усі висновки «можна далі / стоп» — тут, щоб їх тримали тести (test/node/release.test.ts).
// CLI: node scripts/release-lib.mjs <команда> [аргументи]; вхід (вивід wrangler, тіло /health) — зі stdin.
// Скрипт нічого секретного не друкує: зі списку секретів — лише назви, з deployments status — лише version_id
// (там є пошта автора — її не виводимо).
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";

// НФ-8: назви з коду (src/env.ts), а не з промпту 3.3 (S3.10 п. 2).
export const REQUIRED_SECRETS = ["BOT_TOKEN", "WEBHOOK_SECRET", "ALLOWED_TG_IDS", "MONITOR_PING_URL", "ANTHROPIC_API_KEY"];
export const PROD_ENV = "production";
export const PROD_WORKER = "adhd-bot-prod";
export const PREVIEW_WORKER = "adhd-bot-preview";
export const PLACEHOLDER_D1_ID = "REPLACE_WITH_PROD_D1_ID";

// prod D1 «створено» = у wrangler.toml справжній database_id, а не заглушка з 0.4.
export function prodD1State(tomlText) {
  const cfg = parse(tomlText);
  const db = cfg.env?.[PROD_ENV]?.d1_databases?.[0];
  if (!db) return { created: false, name: null, reason: "немає [[env.production.d1_databases]]" };
  const id = String(db.database_id ?? "");
  if (id === "" || id === PLACEHOLDER_D1_ID) {
    return { created: false, name: db.database_name, reason: `database_id = ${id || "порожньо"}` };
  }
  return { created: true, name: db.database_name, reason: "" };
}

// Ворота git: реліз — лише з чистого дерева й рівно з origin/main. У dry-run ті самі перевірки — попередження.
export function checkGit({ porcelain, head, originMain, dryRun }) {
  const problems = [];
  if ((porcelain ?? "").trim() !== "") problems.push("робоче дерево не чисте (git status --porcelain не порожній)");
  if (!head || !originMain) problems.push("не вдалося прочитати HEAD або origin/main");
  else if (head !== originMain) problems.push(`HEAD ${head.slice(0, 7)} ≠ origin/main ${originMain.slice(0, 7)}`);
  return dryRun ? { fatal: [], warn: problems } : { fatal: problems, warn: [] };
}

// `wrangler d1 time-travel info <db> --env <env> --json` → {"bookmark": "..."} (перевірено на preview 2026-11-22).
export function parseBookmark(text) {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("у виводі немає JSON");
  const json = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
  const b = json.bookmark;
  if (typeof b !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]+){3}$/.test(b)) throw new Error("bookmark не схожий на bookmark D1");
  return b;
}

// `wrangler d1 migrations list … --remote`: «No migrations to apply» → [], таблиця імен → список; інше → null (не вгадуємо).
export function parsePendingMigrations(text) {
  if (/No migrations to apply/i.test(text)) return [];
  if (!/Migrations to be applied/i.test(text)) return null;
  return [...text.matchAll(/\b(\d{4}_[A-Za-z0-9_-]+\.sql)\b/g)].map((m) => m[1]);
}

// `wrangler secret list --env production` (JSON-масив {name,type}) → яких назв НФ-8 бракує.
export function missingSecrets(text) {
  const names = new Set([...text.matchAll(/"name"\s*:\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
  return REQUIRED_SECRETS.filter((n) => !names.has(n));
}

// `wrangler deployments status --env … --json` → version_id на 100 % (ціль відкату коду). Немає Worker-а → null.
export function parseDeployedVersion(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const json = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
    const v = (json.versions ?? []).find((x) => x.percentage === 100) ?? json.versions?.[0];
    return typeof v?.version_id === "string" ? v.version_id : null;
  } catch {
    return null;
  }
}

// Вивід `wrangler deploy --env production`: адреса workers.dev, активний cron «* * * * *», id версії.
export function parseDeploy(text, worker = PROD_WORKER) {
  const esc = worker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const url = text.match(new RegExp(`https://${esc}\\.[a-z0-9-]+\\.workers\\.dev`))?.[0] ?? null;
  const cronActive = /schedule:\s*\* \* \* \* \*/.test(text);
  const versionId = text.match(/Current Version ID:\s*([0-9a-f-]{36})/)?.[1] ?? null;
  const problems = [];
  if (!url) problems.push(`у виводі деплою немає адреси https://${worker}.<піддомен>.workers.dev (workers_dev = true?)`);
  if (!cronActive) problems.push("у виводі деплою немає «schedule: * * * * *» — cron не активний");
  return { url, cronActive, versionId, problems };
}

// 3.10.a: 200, ok:true, sha = HEAD, cron не stale, monitor не missing, env = production.
export function verifyHealth(bodyText, sha, env = PROD_ENV) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return ["/health повернув не JSON"];
  }
  const problems = [];
  if (body.ok !== true) problems.push(`ok = ${JSON.stringify(body.ok)}`);
  if (body.monitor === "missing") problems.push("monitor: missing — немає MONITOR_PING_URL");
  if (body.env !== env) problems.push(`env = ${JSON.stringify(body.env)}, очікував ${env}`);
  if (body.sha !== sha) problems.push(`sha = ${String(body.sha).slice(0, 12)}, очікував ${sha.slice(0, 12)}`);
  if (body.cron?.stale !== false) problems.push(`cron.stale = ${JSON.stringify(body.cron?.stale)} (age_s ${body.cron?.age_s ?? "—"})`);
  return problems;
}

export function healthSha(bodyText) {
  try {
    const sha = JSON.parse(bodyText).sha;
    return typeof sha === "string" ? sha : null;
  } catch {
    return null;
  }
}

// Рядок для docs/releases.md (без персональних даних: ні tg_id, ні текстів, ні адрес пінгу).
export function releaseLine({ date, sha, migrations, bookmark }) {
  const m = migrations.length ? migrations.map((x) => x.replace(/\.sql$/, "")).join(", ") : "—";
  return `| ${date} | \`${sha.slice(0, 7)}\` | ${m} | \`${bookmark}\` | ⏳ чекліст RUNBOOK |`;
}

function stdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(argv) {
  const [cmd, ...args] = argv;
  const out = (s) => process.stdout.write(`${s}\n`);
  const err = (s) => process.stderr.write(`${s}\n`);
  switch (cmd) {
    case "prod-d1": {
      const s = prodD1State(readFileSync(args[0] ?? "wrangler.toml", "utf8"));
      out(s.name ?? "");
      if (!s.created) {
        err(s.reason);
        return 3;
      }
      return 0;
    }
    case "git-check": {
      const r = checkGit({
        porcelain: process.env.GIT_PORCELAIN,
        head: process.env.GIT_HEAD,
        originMain: process.env.GIT_ORIGIN_MAIN,
        dryRun: args[0] === "dry",
      });
      r.warn.forEach((p) => out(`ПОПЕРЕДЖЕННЯ (dry-run): ${p}`));
      r.fatal.forEach((p) => err(`СТОП: ${p}`));
      return r.fatal.length ? 1 : 0;
    }
    case "bookmark":
      try {
        out(parseBookmark(stdin()));
        return 0;
      } catch (e) {
        err(`bookmark: ${e.message}`);
        return 1;
      }
    case "pending": {
      const list = parsePendingMigrations(stdin());
      if (list === null) {
        err("не розпізнав вивід migrations list");
        return 1;
      }
      list.forEach(out);
      return 0;
    }
    case "secrets": {
      const miss = missingSecrets(stdin());
      miss.forEach(out);
      return miss.length ? 1 : 0;
    }
    case "deployed-version":
      out(parseDeployedVersion(stdin()) ?? "");
      return 0;
    case "deploy": {
      const d = parseDeploy(stdin(), args[0]);
      out(`url=${d.url ?? ""}`);
      out(`version=${d.versionId ?? ""}`);
      d.problems.forEach((p) => err(`СТОП: ${p}`));
      return d.problems.length ? 1 : 0;
    }
    case "health": {
      const problems = verifyHealth(stdin(), args[0] ?? "", args[1]);
      problems.forEach(out);
      return problems.length ? 1 : 0;
    }
    case "health-sha":
      out(healthSha(stdin()) ?? "");
      return 0;
    case "release-line":
      out(releaseLine({ date: args[0], sha: args[1], bookmark: args[2], migrations: args.slice(3) }));
      return 0;
    default:
      err(`невідома команда: ${cmd}`);
      return 2;
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/release-lib.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
