import { describe, expect, it } from "vitest";
import { TOKEN_RE, exportedFunctions, findViolations, readSources, scannableTextFiles, userIdViolations, type SourceFile } from "./guard-lib";

const files = readSources();
const file = (p: string, text: string): SourceFile => ({ path: p, text });

describe("S0.4 огорожа шару даних", () => {
  it("0.4.c: у src/ поза src/db/ немає env.DB, .prepare( і D1Database", () => {
    expect(files.length).toBeGreaterThan(5); // сканер справді бачить код
    expect(findViolations(files).filter((v) => v.rule !== "Date.now()" && !v.rule.startsWith("new Date"))).toEqual([]);
  });

  it("0.4.c: навмисний порушник у src/bot.ts червоніє (сканер ловить)", () => {
    const evil = [...files.filter((f) => f.path !== "src/bot.ts"), file("src/bot.ts", "const x = env.DB;")];
    expect(findViolations(evil)).toContainEqual({ file: "src/bot.ts", rule: "env.DB / .DB" });
    expect(findViolations([file("src/x.ts", "db.prepare('SELECT 1')")])).toHaveLength(1);
    expect(findViolations([file("src/x.ts", "let d: D1Database;")])).toHaveLength(1);
    // той самий код у src/db/ — дозволений
    expect(findViolations([file("src/db/x.ts", "env.DB.prepare('SELECT 1'); let d: D1Database;")])).toEqual([]);
  });

  it("0.4.d: кожна експортована функція users.ts має userId першим, окрім ensureUser", () => {
    expect(userIdViolations(files)).toEqual([]);
    const names = exportedFunctions(files.find((f) => f.path === "src/db/users.ts")!.text).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["ensureUser", "getById", "setVariantIdx"]));
  });

  it("0.4.d: новий експорт без userId і не з винятків — червоний", () => {
    const bad = file("src/db/users.ts", "export async function listAll(db: Db) {}\nexport async function ensureUser(tgId: number) {}");
    expect(userIdViolations([bad])).toEqual(["src/db/users.ts: listAll(db)"]);
    expect(userIdViolations([file("src/db/users.ts", "export function ok(userId: number, db: Db) {}")])).toEqual([]);
  });

  it("0.4.d (R5): system.ts — закритий список імен, а не виняток для цілого файлу", () => {
    const sys = files.find((f) => f.path === "src/db/system.ts")!;
    expect(userIdViolations([sys])).toEqual([]); // реальний файл чистий
    expect(exportedFunctions(sys.text).map((f) => f.name).sort()).toEqual(["claimDuePendingCaptures", "countPending", "heartbeat", "markPingOk", "readHeartbeat"]);
    // новий експорт без userId і поза списком — червоний, навіть у «системному» файлі
    const leak = file("src/db/system.ts", [sys.text, "export async function allUserTgIds(db: Db) {}"].join("\n"));
    expect(userIdViolations([leak])).toEqual(["src/db/system.ts: allUserTgIds(db)"]);
    // з userId першим — дозволено і в system.ts
    expect(userIdViolations([file("src/db/system.ts", "export async function pendingFor(userId: number, db: Db) {}")])).toEqual([]);
    // експорт, якого сканер не вміє розібрати, — теж червоний
    expect(userIdViolations([file("src/db/system.ts", "export { readHeartbeat } from './x';")])).toEqual(["src/db/system.ts: export { … } (експорт не розпізнано)"]);
  });

  it("0.4.e: Date.now() і new Date() без аргументів — лише в clock.ts", () => {
    const timeViolations = findViolations(files).filter((v) => v.rule === "Date.now()" || v.rule.startsWith("new Date"));
    expect(timeViolations).toEqual([]);
    expect(findViolations([file("src/x.ts", "const t = Date.now();")])).toHaveLength(1);
    expect(findViolations([file("src/x.ts", "const d = new Date();")])).toHaveLength(1);
    expect(findViolations([file("src/x.ts", "const d = new Date(ms);")])).toEqual([]);
    expect(findViolations([file("src/clock.ts", "now: () => Date.now()")])).toEqual([]);
  });
  it("В1: обхід через деструктуризацію, env[\"DB\"], db.d1 і d1Of поза src/db/ — червоний", () => {
    for (const code of [
      "const { DB } = env; void DB;",
      'const d = env["DB"];',
      'if (update.update_id < 0) await db.d1.exec("DELETE FROM users");',
      "const raw = d1Of(db);",
    ]) {
      expect(findViolations([file("src/bot.ts", code)]), code).not.toEqual([]);
      expect(findViolations([file("src/db/x.ts", code)]), `у src/db/: ${code}`).toEqual([]);
    }
  });

  it("В2: експорт-стрілка без userId червоний, також у index.ts; openDb і d1Of — явні винятки", () => {
    const arrow = file("src/db/users.ts", "export const listAll = async (db: Db) => db.d1.prepare('SELECT 1').all();");
    expect(userIdViolations([arrow])).toEqual(["src/db/users.ts: listAll(db)"]);
    for (const code of [
      "export const a = (db: Db) => 1;",
      "export const a = async function (db: Db) {};",
      "export const a = db => 1;",
      "export const a = async <T>(db: Db) => 1;",
      "export const a: Fn = (db: Db) => 1;",
      "export const a = ({ x }: P) => 1;",
    ]) {
      expect(userIdViolations([file("src/db/users.ts", code)]), code).not.toEqual([]);
    }
    expect(userIdViolations([file("src/db/users.ts", "export const ok = async (userId: number, db: Db) => 1;")])).toEqual([]);
    // index.ts більше не виняток цілого файлу
    expect(userIdViolations([file("src/db/index.ts", "export async function allUsers(db: Db) {}")])).toEqual(["src/db/index.ts: allUsers(db)"]);
    expect(userIdViolations([file("src/db/index.ts", "export function openDb(env: E) {}\nexport function d1Of(db: Db) {}")])).toEqual([]);
  });

  it("В2: непізнаваний експорт (alias, re-export, default) — fail-closed", () => {
    for (const code of ["export const f = other;", "export { a } from './x';", "export * from './x';", "export default function (db) {}"]) {
      expect(userIdViolations([file("src/db/users.ts", code)]), code).not.toEqual([]);
    }
    // літерали, типи й інтерфейси — не функції
    expect(userIdViolations([file("src/db/users.ts", 'export const COLS = "a, b";\nexport interface U {}\nexport type K = "a";')])).toEqual([]);
  });

  it("В5: токеноподібний рядок шукається в усіх трекнутих текстових файлах, крім lock і .d.ts", () => {
    const picked = scannableTextFiles(["scripts/set-webhook.mjs", "x.py", "Dockerfile", ".github/workflows/ci.yml", "package-lock.json", "worker-configuration.d.ts", "src/a.ts"]);
    expect(picked).toEqual(["scripts/set-webhook.mjs", "x.py", "Dockerfile", ".github/workflows/ci.yml", "src/a.ts"]);
    const fake = `// default: ${"1".repeat(9)}:${"A".repeat(35)}`; // зібрано в коді: у самому файлі токена немає
    expect(TOKEN_RE.test(fake)).toBe(true);
    expect(TOKEN_RE.test("123456789:TESTTOKEN")).toBe(false);
  });
});
