import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_SECRETS,
  checkGit,
  healthSha,
  missingSecrets,
  parseBookmark,
  parseDeploy,
  parseDeployedVersion,
  parsePendingMigrations,
  prodD1State,
  releaseLine,
  verifyHealth,
} from "../../scripts/release-lib.mjs";
import { ROOT } from "./guard-lib";

// Фікстури — форма справжнього виводу wrangler 4.165 (знято живцем на preview 2026-11-22; деплой — формат
// wrangler deploy з іншого проєкту, назву й піддомен замінено). Персональних даних (пошта автора) немає.
const BOOKMARK = "0000000c-000008b8-0000512b-a6e9f2b5b868dc0a30d84b3953c9e7d8";
const TT_JSON = `{\n  "bookmark": "${BOOKMARK}"\n}\n`;
const ML_NONE = "\n ⛅️ wrangler 4.165.0\n───\nResource location: remote \n\n✅ No migrations to apply!\n";
const ML_FIVE = `Migrations to be applied:
┌────────────────────┐
│ Name               │
├────────────────────┤
│ 0001_init.sql      │
├────────────────────┤
│ 0002_items.sql     │
├────────────────────┤
│ 0003_points.sql    │
├────────────────────┤
│ 0004_reminders.sql │
├────────────────────┤
│ 0005_digests.sql   │
└────────────────────┘
`;
const secretsJson = (names: string[]) => JSON.stringify(names.map((name) => ({ name, type: "secret_text" })), null, 2);
const DEPLOYMENTS = `{
  "id": "8b09cce5-df59-4bed-9993-0d5463494b0b",
  "source": "wrangler",
  "versions": [ { "version_id": "da2f32a9-9d89-4732-af5f-fedfb336f35d", "percentage": 100 } ]
}`;
const DEPLOY_OK = `Uploaded adhd-bot-prod (8.97 sec)
Deployed adhd-bot-prod triggers (4.05 sec)
  https://adhd-bot-prod.example-sub.workers.dev
  schedule: * * * * *
Current Version ID: b8c9b7ae-8459-426c-b26f-f2db972f1633
`;
const SHA = "c729d55aa1b2c3d4e5f60718293a4b5c6d7e8f90";
const health = (over: Record<string, unknown> = {}, cron: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: true, env: "production", sha: SHA, cron: { last_run_at: 1, age_s: 30, stale: false, ...cron }, queue: { pending: 0 }, ...over });

const toml = (id: string) => `name = "adhd-bot"
[env.production]
name = "adhd-bot-prod"
[[env.production.d1_databases]]
binding = "DB"
database_name = "adhd-prod"
database_id = "${id}"
`;

describe("3.3 реліз: prod D1 створено?", () => {
  it("заглушка REPLACE_WITH_PROD_D1_ID — не створено, з причиною", () => {
    const s = prodD1State(toml("REPLACE_WITH_PROD_D1_ID"));
    expect(s).toMatchObject({ created: false, name: "adhd-prod" });
    expect(s.reason).toContain("REPLACE_WITH_PROD_D1_ID");
  });
  it("порожній id — не створено", () => {
    expect(prodD1State(toml("")).created).toBe(false);
  });
  it("справжній id — створено", () => {
    expect(prodD1State(toml("1f12ad7f-3cc4-4124-9179-fc15d598cfeb"))).toMatchObject({ created: true, name: "adhd-prod" });
  });
});

describe("3.3 реліз: ворота git", () => {
  const main = "a".repeat(40);
  it("чисте дерево й HEAD = origin/main — без проблем", () => {
    expect(checkGit({ porcelain: "", head: main, originMain: main, dryRun: false })).toEqual({ fatal: [], warn: [] });
  });
  it("гілка (HEAD ≠ origin/main) без --dry-run — СТОП із обома sha", () => {
    const r = checkGit({ porcelain: "", head: "b".repeat(40), originMain: main, dryRun: false });
    expect(r.fatal).toEqual(["HEAD bbbbbbb ≠ origin/main aaaaaaa"]);
  });
  it("брудне дерево без --dry-run — СТОП", () => {
    expect(checkGit({ porcelain: " M src/app.ts\n", head: main, originMain: main, dryRun: false }).fatal).toHaveLength(1);
  });
  it("--dry-run: ті самі проблеми — лише попередження", () => {
    const r = checkGit({ porcelain: "?? x\n", head: "b".repeat(40), originMain: main, dryRun: true });
    expect(r.fatal).toEqual([]);
    expect(r.warn).toHaveLength(2);
  });
  it("не прочитали origin/main — СТОП, а не «збігається»", () => {
    expect(checkGit({ porcelain: "", head: main, originMain: "", dryRun: false }).fatal).toHaveLength(1);
  });
  it("CLI git-check real на гілці: exit 1 і «СТОП» у stderr (так відмовляє release.sh)", () => {
    const r = spawnSync(process.execPath, ["scripts/release-lib.mjs", "git-check", "real"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, GIT_PORCELAIN: "", GIT_HEAD: "b".repeat(40), GIT_ORIGIN_MAIN: main },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("СТОП: HEAD bbbbbbb ≠ origin/main aaaaaaa");
  });
});

describe("3.3 реліз: розбір виводу wrangler", () => {
  it("bookmark з time-travel info --json", () => {
    expect(parseBookmark(TT_JSON)).toBe(BOOKMARK);
    expect(parseBookmark(`банер\n${TT_JSON}`)).toBe(BOOKMARK);
  });
  it("bookmark: не JSON або не схожий на bookmark — помилка, а не порожній відкат", () => {
    expect(() => parseBookmark("✘ [ERROR] Couldn't find DB")).toThrow();
    expect(() => parseBookmark('{"bookmark": ""}')).toThrow();
    expect(() => parseBookmark('{"bookmark": "latest"}')).toThrow();
  });
  it("migrations list: нічого / п'ять / невідомий вивід", () => {
    expect(parsePendingMigrations(ML_NONE)).toEqual([]);
    expect(parsePendingMigrations(ML_FIVE)).toEqual([
      "0001_init.sql",
      "0002_items.sql",
      "0003_points.sql",
      "0004_reminders.sql",
      "0005_digests.sql",
    ]);
    expect(parsePendingMigrations("✘ [ERROR] A request to the Cloudflare API failed")).toBeNull();
  });
  it("секрети: назви НФ-8, яких бракує", () => {
    expect(REQUIRED_SECRETS).toEqual(["BOT_TOKEN", "WEBHOOK_SECRET", "ALLOWED_TG_IDS", "MONITOR_PING_URL", "ANTHROPIC_API_KEY"]);
    expect(missingSecrets(secretsJson([...REQUIRED_SECRETS]))).toEqual([]);
    expect(missingSecrets(secretsJson(["BOT_TOKEN", "WEBHOOK_SECRET", "ALLOWED_TG_IDS"]))).toEqual(["MONITOR_PING_URL", "ANTHROPIC_API_KEY"]);
    // назви з промпту 3.3 не рахуються за назви коду (S3.10 п. 2)
    expect(missingSecrets(secretsJson(["TELEGRAM_BOT_TOKEN", "HEALTHCHECK_URL", "WEBHOOK_SECRET", "ALLOWED_TG_IDS", "ANTHROPIC_API_KEY"]))).toEqual([
      "BOT_TOKEN",
      "MONITOR_PING_URL",
    ]);
  });
  it("deployments status: version_id на 100 %, без Worker-а — null", () => {
    expect(parseDeployedVersion(DEPLOYMENTS)).toBe("da2f32a9-9d89-4732-af5f-fedfb336f35d");
    expect(parseDeployedVersion("✘ [ERROR] This Worker does not exist on your account.")).toBeNull();
  });
  it("deploy: адреса prod, cron активний, id версії", () => {
    expect(parseDeploy(DEPLOY_OK)).toEqual({
      url: "https://adhd-bot-prod.example-sub.workers.dev",
      cronActive: true,
      versionId: "b8c9b7ae-8459-426c-b26f-f2db972f1633",
      problems: [],
    });
  });
  it("deploy без schedule — проблема cron; адреса preview за prod не рахується", () => {
    expect(parseDeploy(DEPLOY_OK.replace("  schedule: * * * * *\n", "")).problems).toEqual([
      "у виводі деплою немає «schedule: * * * * *» — cron не активний",
    ]);
    const p = parseDeploy(DEPLOY_OK.replaceAll("adhd-bot-prod", "adhd-bot-preview"));
    expect(p.url).toBeNull();
    expect(p.problems).toHaveLength(1);
  });
});

describe("3.10.a /health prod після деплою", () => {
  it("ok, env production, sha = HEAD, cron свіжий — без проблем", () => {
    expect(verifyHealth(health(), SHA)).toEqual([]);
  });
  it("старий sha (деплой ще не доїхав) — проблема", () => {
    expect(verifyHealth(health({ sha: "0".repeat(40) }), SHA)).toHaveLength(1);
  });
  it("cron stale або ще не бився (stale:true, last_run_at null) — проблема", () => {
    expect(verifyHealth(health({}, { stale: true }), SHA)).toHaveLength(1);
    expect(verifyHealth(health({}, { stale: undefined }), SHA)).toHaveLength(1);
  });
  it("monitor missing — дві проблеми (ok:false і monitor)", () => {
    const p = verifyHealth(health({ ok: false, monitor: "missing" }), SHA);
    expect(p).toHaveLength(2);
    expect(p.join(" ")).toContain("MONITOR_PING_URL");
  });
  it("відповів preview, а не prod — проблема", () => {
    expect(verifyHealth(health({ env: "preview" }), SHA)).toHaveLength(1);
  });
  it("503 {ok:false,error:db} і не JSON — проблема", () => {
    expect(verifyHealth('{"ok":false,"error":"db"}', SHA).length).toBeGreaterThan(0);
    expect(verifyHealth("error code: 1042", SHA)).toEqual(["/health повернув не JSON"]);
  });
  it("healthSha для перевірки «preview не зачеплено»", () => {
    expect(healthSha(health())).toBe(SHA);
    expect(healthSha("<html>")).toBeNull();
  });
});

describe("3.3 рядок docs/releases.md", () => {
  it("дата, короткий sha, міграції без .sql, bookmark, чекліст ще не пройдено", () => {
    expect(releaseLine({ date: "2026-11-25", sha: SHA, bookmark: BOOKMARK, migrations: ["0001_init.sql", "0005_digests.sql"] })).toBe(
      `| 2026-11-25 | \`c729d55\` | 0001_init, 0005_digests | \`${BOOKMARK}\` | ⏳ чекліст RUNBOOK |`,
    );
    expect(releaseLine({ date: "d", sha: SHA, bookmark: BOOKMARK, migrations: [] })).toContain("| — |");
  });
});

describe("3.3 release.sh: порядок кроків і межі dry-run", () => {
  const sh = readFileSync(path.join(ROOT, "scripts/release.sh"), "utf8");
  const at = (s: string) => {
    const i = sh.indexOf(s);
    expect(i, s).toBeGreaterThan(-1);
    return i;
  };

  it("git → тести → bookmark → migrations apply → deploy → Telegram → /health", () => {
    const order = [
      at("git-check"),
      at("npm test"),
      at("d1 time-travel info"),
      at("d1 migrations apply"),
      at("deploy --env $ENV"),
      at("set-commands.mjs"),
      at('/health" > "$LOG_DIR/health.json"'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("обидва виходи dry-run стоять до першого apply/deploy/Telegram", () => {
    const dryExits = [...sh.matchAll(/DRY-RUN завершено[^\n]*\n\s*exit 0/g)].map((m) => m.index!);
    expect(dryExits).toHaveLength(2);
    const firstWrite = Math.min(at("d1 migrations apply"), at("deploy --env $ENV"), at("read -r -s"), at("set-commands.mjs"));
    for (const i of dryExits) expect(i).toBeLessThan(firstWrite);
  });

  it("секрети зі змінних оболонки не успадковуються (токен preview не потрапить у prod)", () => {
    expect(at("unset BOT_TOKEN WEBHOOK_SECRET")).toBeLessThan(at("read -r -s"));
    expect(sh).toMatch(/BOT_TOKEN="\$PROD_TOKEN" node scripts\/set-commands\.mjs/);
  });

  it("npm run release запускає саме цей скрипт; bash-синтаксис валідний", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.release).toBe("bash scripts/release.sh");
    execFileSync("bash", ["-n", "scripts/release.sh"], { cwd: ROOT });
  });
});
