import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  REQUIRED_SECRETS,
  checkGit,
  countReleases,
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
    expect(checkGit({ porcelain: "", head: main, originMain: "", dryRun: false }).fatal).toEqual(["не вдалося прочитати HEAD або origin/main"]);
    // git не відповів зовсім: "" === "" не має стати «HEAD = origin/main» (мутант M3)
    expect(checkGit({ porcelain: "", head: "", originMain: "", dryRun: false }).fatal).toEqual(["не вдалося прочитати HEAD або origin/main"]);
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
    // таблиця імен без заголовка — невідомий формат, не «список до застосування» (мутант M6 після В2)
    expect(parsePendingMigrations(ML_FIVE.replace("Migrations to be applied:", ""))).toBeNull();
  });
  it("рев'ю 3.3 В2: заголовок є, а ім'я не впізнано (чи рядків нема) — null (стоп), а не «нових немає»", () => {
    expect(parsePendingMigrations("Migrations to be applied:\n│ 0006_digests.v2.sql │\n")).toBeNull();
    expect(parsePendingMigrations("Migrations to be applied:\n0006_digests.sql\n")).toBeNull(); // формат таблиці змінився
    // одне ім'я впізнано, друге ні — теж стоп: список для журналу й відкату має бути повним
    expect(parsePendingMigrations(ML_FIVE.replace("0003_points.sql   ", "0003_points.v2.sql"))).toBeNull();
    expect(parsePendingMigrations(ML_FIVE.replaceAll("\n", "\r\n"))).toHaveLength(5); // CRLF з Windows — не збій
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
  it("рев'ю 3.3 Д3: поступова викатка (жодної на 100 %) — null: ціллю відкату могла б стати нова версія", () => {
    const split = JSON.stringify({ versions: [ { version_id: "new-50", percentage: 50 }, { version_id: "old-50", percentage: 50 } ] });
    expect(parseDeployedVersion(split)).toBeNull();
  });
  it("рев'ю 3.3 Д2: журнал викаток — рахуються лише рядки з датою", () => {
    // Порожній журнал = справжній файл без рядків викаток (після першого релізу файл уже не порожній).
    const journal = readFileSync(path.join(ROOT, "docs/releases.md"), "utf8").split("\n").filter((l) => !/^\| \d{4}-\d{2}-\d{2} /.test(l)).join("\n");
    expect(countReleases(journal)).toBe(0); // заголовок і |---| — не викатки
    expect(countReleases(`${journal}| 2026-11-25 | \`c729d55\` | 0001_init | \`b\` | ✅ |\n`)).toBe(1);
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
    expect(at("unset BOT_TOKEN WEBHOOK_SECRET API_ROOT")).toBeLessThan(at("read -r -s"));
    expect(sh).toMatch(/BOT_TOKEN="\$PROD_TOKEN" node scripts\/set-commands\.mjs/);
  });

  it("npm run release запускає саме цей скрипт; bash-синтаксис валідний", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.release).toBe("bash scripts/release.sh");
    execFileSync("bash", ["-n", "scripts/release.sh"], { cwd: ROOT });
  });
});

// Обв'язка bash, а не лише чисті функції: release.sh з підмінними git/npm/npx у PATH (без мережі, без prod).
// git каже «гілка»: HEAD bbbb… ≠ origin/main aaaa…; npx віддає канонічний вивід wrangler і пише свої виклики в журнал.
describe("3.3 release.sh на гілці (підмінні git/npm/npx)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-sh-"));
  const shim = (name: string, body: string) => writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const log = (name: string) => path.join(dir, `${name}.calls`).split(path.sep).join("/");
  shim("git", `case "$*" in
  "rev-parse HEAD") echo ${"b".repeat(40)} ;;
  "rev-parse origin/main") echo ${"a".repeat(40)} ;;
  *) : ;;
esac`);
  shim("npm", `echo "$*" >> "${log("npm")}"; echo "      Tests  1 passed (1)"`);
  shim("npx", `echo "$*" >> "${log("npx")}"
case "$*" in
  *"secret list"*) printf '%s' '${JSON.stringify(REQUIRED_SECRETS.map((name) => ({ name, type: "secret_text" })))}' ;;
  *"time-travel info"*) echo '{"bookmark": "${BOOKMARK}"}' ;;
  *"migrations list"*) echo "No migrations to apply!" ;;
  *) echo "{}" ;;
esac`);
  const run = (args: string[]) =>
    spawnSync("bash", ["scripts/release.sh", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, RELEASE_LOG_DIR: path.join(dir, "logs") },
    });
  const calls = (name: string) => (existsSync(log(name)) ? readFileSync(log(name), "utf8") : "");

  it("без --dry-run: СТОП на кроці git, до тестів і до будь-якої команди wrangler", { timeout: 60_000 }, () => {
    const r = run([]);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain("СТОП: HEAD bbbbbbb ≠ origin/main aaaaaaa");
    expect(r.stdout).toContain("нічого (prod не чіпав)");
    expect(calls("npm")).toBe("");
    expect(calls("npx")).toBe("");
  });

  it("--dry-run: попередження git, тести прогнано, жодного apply/deploy/Telegram", { timeout: 60_000 }, () => {
    const r = run(["--dry-run"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("ПОПЕРЕДЖЕННЯ (dry-run): HEAD bbbbbbb ≠ origin/main aaaaaaa");
    expect(r.stdout).toContain("DRY-RUN завершено");
    expect(calls("npm")).toContain("test");
    const npx = calls("npx");
    // prod D1 ще не створено → жодної prod-команди; створено → лише читання (secret list, status, info, list)
    if (prodD1State(readFileSync(path.join(ROOT, "wrangler.toml"), "utf8")).created) {
      expect(npx).toContain("time-travel info");
      expect(r.stdout).toContain(BOOKMARK);
    } else {
      expect(npx).toBe("");
      expect(r.stdout).toContain("prod D1 «adhd-prod» ще не створено");
    }
    expect(npx).not.toMatch(/migrations apply|deploy --env|rollback|secret put|restore/);
    expect(r.stdout).not.toContain("BOT_TOKEN prod-бота");
  });
});

// Справжній шлях (рев'ю 3.3, В4): не dry, HEAD = origin/main, prod D1 створено — кроки 4–10 до кінця.
// Копія скрипта в теці під node_modules (release-lib.mjs імпортує smol-toml — Node знайде його вгору по дереву)
// з wrangler.toml, де prod D1 має id, і з заглушкою set-commands.mjs: жодної мережі, prod, Telegram.
// release.sh і release-lib.mjs копіюються з репо в момент тесту — мутанти scripts/mutate.py ловляться.
// Прапорці сценарію — файли в теці: status-fail, bookmark-bad, apply-noop, deploy-no-cron, deploy-touches-preview, health-bad.
describe("3.3 release.sh: справжній шлях (підмінні git/npm/npx/curl/sleep)", () => {
  const MAIN = "c".repeat(40);
  const PREV = "da2f32a9-9d89-4732-af5f-fedfb336f35d";
  const PREVIEW_V1 = "11111111-aaaa-4bbb-8ccc-000000000001";
  const PREVIEW_V2 = "22222222-aaaa-4bbb-8ccc-000000000002";
  const JOURNAL = readFileSync(path.join(ROOT, "docs/releases.md"), "utf8").split("\n").filter((l) => !/^\| \d{4}-\d{2}-\d{2} /.test(l)).join("\n"); // порожній журнал: без рядків викаток
  const ONE_RELEASE = `${JOURNAL}| 2026-11-25 | \`ccccccc\` | 0001_init | \`${BOOKMARK}\` | ✅ |\n`;
  const sandboxes: string[] = [];
  afterAll(() => sandboxes.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const posix = (p: string) => p.split(path.sep).join("/");

  function sandbox(flags: string[] = [], journal = ONE_RELEASE) {
    const w = mkdtempSync(path.join(ROOT, "node_modules", ".release-e2e-"));
    sandboxes.push(w);
    const W = posix(w);
    for (const d of ["scripts", "docs", "bin"]) mkdirSync(path.join(w, d));
    for (const f of ["release.sh", "release-lib.mjs"]) writeFileSync(path.join(w, "scripts", f), readFileSync(path.join(ROOT, "scripts", f)));
    writeFileSync(
      path.join(w, "scripts/set-commands.mjs"),
      `import { appendFileSync } from "node:fs";\nappendFileSync("${W}/calls.log", \`set-commands token=\${process.env.BOT_TOKEN ?? ""} api_root=\${process.env.API_ROOT ?? ""}\\n\`);\n`,
    );
    writeFileSync(
      path.join(w, "wrangler.toml"),
      readFileSync(path.join(ROOT, "wrangler.toml"), "utf8").replace("REPLACE_WITH_PROD_D1_ID", "9e0c3a51-1b2c-4d3e-8f40-5a6b7c8d9e0f"),
    );
    writeFileSync(path.join(w, "docs/releases.md"), journal);
    for (const f of flags) writeFileSync(path.join(w, f), "");
    const shim = (name: string, body: string) => writeFileSync(path.join(w, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const has = (f: string) => `[ -f "${W}/${f}" ]`;
    const version = (id: string) => `echo '{"versions":[{"version_id":"${id}","percentage":100}]}'`;
    shim("git", `case "$*" in "rev-parse HEAD"|"rev-parse origin/main") echo ${MAIN} ;; *) : ;; esac`);
    shim("npm", `echo "      Tests  1 passed (1)"`);
    shim("sleep", ":");
    shim(
      "npx",
      `echo "npx $*" >> "${W}/calls.log"
case "$*" in
  *"secret list"*) printf '%s' '${JSON.stringify(REQUIRED_SECRETS.map((name) => ({ name, type: "secret_text" })))}' ;;
  *"deployments status --env preview"*) if ${has("deployed")} && ${has("deploy-touches-preview")}; then ${version(PREVIEW_V2)}; else ${version(PREVIEW_V1)}; fi ;;
  *"deployments status"*) if ${has("status-fail")}; then echo "✘ [ERROR] A request to the Cloudflare API failed (code 10000)"; exit 1; fi; ${version(PREV)} ;;
  *"time-travel info"*) if ${has("bookmark-bad")}; then echo '{"bookmark": "latest"}'; else echo '{"bookmark": "${BOOKMARK}"}'; fi ;;
  *"migrations list"*) if ${has("applied")}; then echo "No migrations to apply!"; else printf 'Migrations to be applied:\\n│ Name          │\\n│ 0006_next.sql │\\n'; fi ;;
  *"migrations apply"*) ${has("apply-noop")} || touch "${W}/applied" ;;
  *"deploy --env"*) touch "${W}/deployed"; echo "Uploaded adhd-bot-prod"; echo "  https://adhd-bot-prod.example-sub.workers.dev"
    ${has("deploy-no-cron")} || echo "  schedule: * * * * *"; echo "Current Version ID: b8c9b7ae-8459-426c-b26f-f2db972f1633" ;;
esac`,
    );
    // curl: prod /health; і preview /health — його читав старий код (до виправлення В3), тож заглушка чесна для обох
    shim(
      "curl",
      `echo "curl $*" >> "${W}/calls.log"
case "$*" in
  *adhd-bot-preview*) if ${has("deployed")} && ${has("deploy-touches-preview")}; then S=${"e".repeat(40)}; else S=${"d".repeat(40)}; fi
    echo "{\\"ok\\":true,\\"env\\":\\"preview\\",\\"sha\\":\\"$S\\",\\"cron\\":{\\"stale\\":false}}" ;;
  *) if ${has("health-bad")}; then ST=true; else ST=false; fi
    echo "{\\"ok\\":true,\\"env\\":\\"production\\",\\"sha\\":\\"${MAIN}\\",\\"cron\\":{\\"last_run_at\\":1,\\"age_s\\":30,\\"stale\\":$ST}}" ;;
esac`,
    );
    const run = (args: string[], input: string) => {
      const r = spawnSync("bash", ["scripts/release.sh", ...args], {
        cwd: w,
        input,
        encoding: "utf8",
        timeout: 90_000,
        // API_ROOT і BOT_TOKEN з оболонки не мають дійти до set-commands (Д4, M17)
        env: {
          ...process.env,
          PATH: `${path.join(w, "bin")}${path.delimiter}${process.env.PATH}`,
          RELEASE_LOG_DIR: path.join(w, "logs"),
          API_ROOT: "http://127.0.0.1:9",
          BOT_TOKEN: "PREVIEW-TOKEN",
        },
      });
      const calls = existsSync(path.join(w, "calls.log")) ? readFileSync(path.join(w, "calls.log"), "utf8") : "";
      const logs = path.join(w, "logs");
      const rb = existsSync(logs) ? readdirSync(logs).map((d) => path.join(logs, d, "rollback.txt")).find((f) => existsSync(f)) : undefined;
      return { ...r, out: r.stdout + r.stderr, calls, rollback: rb ? readFileSync(rb, "utf8") : "" };
    };
    return { run };
  }
  const T = { timeout: 120_000 };
  const YES = "так\nTEST-TOKEN\n";

  it("«так»: усі 10 кроків, rollback.txt на попередню версію, меню з токеном prod і без API_ROOT", T, () => {
    const r = sandbox().run([], YES);
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain("== Готово");
    expect(r.stdout).toContain("/health prod: ok");
    expect(r.stdout).toContain("preview не зачеплено");
    expect(r.calls).toContain("migrations apply adhd-prod --env production --remote");
    expect(r.calls).toContain(`deploy --env production --var GIT_SHA:${MAIN}`);
    expect(r.calls).toContain("set-commands token=TEST-TOKEN api_root=\n");
    expect(r.rollback).toContain(`npx wrangler rollback ${PREV} --env production`);
    expect(r.rollback).toContain(`--bookmark=${BOOKMARK}`);
    expect(r.rollback).not.toContain("deleteWebhook");
    expect(r.stdout).toContain("| 0006_next |");
  });

  it("R4: відповідь «ні» — стоп до міграцій і деплою", T, () => {
    const r = sandbox().run([], "ні\n");
    expect(r.status, r.out).toBe(1);
    expect(r.stderr).toContain("людина не підтвердила");
    expect(r.calls).not.toMatch(/migrations apply|deploy --env/);
  });

  it("R1: після apply міграції лишились — стоп до деплою", T, () => {
    const r = sandbox(["apply-noop"]).run([], YES);
    expect(r.status, r.out).toBe(1);
    expect(r.stderr).toContain("після apply лишились: 0006_next.sql");
    expect(r.calls).not.toContain("deploy --env");
  });

  it("R3: bookmark не розібрано — стоп до міграцій (без точки відкату БД не застосовую)", T, () => {
    const r = sandbox(["bookmark-bad"]).run([], YES);
    expect(r.status, r.out).toBe(1);
    expect(r.stderr).toContain("не розібрав bookmark");
    expect(r.calls).not.toMatch(/migrations apply|deploy --env/);
  });

  it("R2: /health prod stale усі 4 спроби — стоп, а не «Готово»", T, () => {
    const r = sandbox(["health-bad"]).run([], YES);
    expect(r.status, r.out).toBe(1);
    expect(r.stdout).toContain("спроба 4");
    expect(r.stderr).toContain("/health prod: cron.stale = true");
    expect(r.stdout).not.toContain("== Готово");
  });

  it("рев'ю 3.3 В1: збій deployments status без --first — стоп до міграцій, а не «перша викатка → deleteWebhook»", T, () => {
    const r = sandbox(["status-fail"]).run([], YES);
    expect(r.status, r.out).toBe(1);
    expect(r.stderr).toContain("не визначив версію prod на 100 %");
    expect(r.calls).not.toMatch(/migrations apply|deploy --env/);
    expect(r.rollback).not.toContain("deleteWebhook");
  });

  it("рев'ю 3.3 В3: деплой зачепив preview — стоп «3.10.a не доведено», а не «✓ preview не зачеплено»", T, () => {
    const r = sandbox(["deploy-touches-preview"]).run([], YES);
    expect(r.status, r.out).toBe(1);
    expect(r.stdout).not.toContain("preview не зачеплено");
    expect(r.stderr).toContain(`версія preview до міграцій «${PREVIEW_V1}», після /health «${PREVIEW_V2}»`);
    // «до» знято раніше за перший запис у prod
    expect(r.calls.indexOf("deployments status --env preview")).toBeLessThan(r.calls.indexOf("migrations apply"));
  });

  it("рев'ю 3.3 Д1: деплой пройшов, cron не прив'язався — у «Зроблено» сказано, що код може бути живим", T, () => {
    const r = sandbox(["deploy-no-cron"]).run([], YES);
    expect(r.status, r.out).toBe(1);
    expect(r.stderr).toContain("cron не активний");
    expect(r.stdout).toMatch(/Зроблено до зупинки:[\s\S]*нова версія може бути вже живою/);
  });

  it("рев'ю 3.3 Д2: журнал порожній, а --first забули — стоп до міграцій (інакше відкат на заглушку secret put)", T, () => {
    const r = sandbox([], JOURNAL).run([], YES);
    expect(r.status, r.out).toBe(1);
    expect(r.stderr).toContain("у docs/releases.md жодної викатки");
    expect(r.calls).not.toMatch(/migrations apply|deploy --env/);
  });

  it("--first на порожньому журналі: Worker-а ще нема (status падає) — реліз іде, відкат = deleteWebhook, друкує setWebhook", T, () => {
    const r = sandbox(["status-fail"], JOURNAL).run(["--first"], YES);
    expect(r.status, r.out).toBe(0);
    expect(r.rollback).toContain("deleteWebhook");
    expect(r.rollback).not.toContain("wrangler rollback");
    expect(r.stdout).toContain("node scripts/set-webhook.mjs https://adhd-bot-prod.example-sub.workers.dev/webhook");
  });
});
