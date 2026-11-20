import { describe, expect, it } from "vitest";
import { exportedFunctions, findViolations, readSources, userIdViolations, type SourceFile } from "./guard-lib";

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

  it("0.4.e: Date.now() і new Date() без аргументів — лише в clock.ts", () => {
    const timeViolations = findViolations(files).filter((v) => v.rule === "Date.now()" || v.rule.startsWith("new Date"));
    expect(timeViolations).toEqual([]);
    expect(findViolations([file("src/x.ts", "const t = Date.now();")])).toHaveLength(1);
    expect(findViolations([file("src/x.ts", "const d = new Date();")])).toHaveLength(1);
    expect(findViolations([file("src/x.ts", "const d = new Date(ms);")])).toEqual([]);
    expect(findViolations([file("src/clock.ts", "now: () => Date.now()")])).toEqual([]);
  });
});
