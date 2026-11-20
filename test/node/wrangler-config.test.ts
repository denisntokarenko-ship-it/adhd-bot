import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { ROOT } from "./guard-lib";

type Cfg = {
  name?: string;
  account_id?: string;
  d1_databases?: unknown;
  triggers?: unknown;
  env: Record<string, { name?: string; vars?: Record<string, string>; triggers?: { crons?: string[] }; d1_databases?: { binding: string; database_name: string; database_id: string }[] }>;
};
const cfg = parse(readFileSync(path.join(ROOT, "wrangler.toml"), "utf8")) as unknown as Cfg;
const preview = cfg.env.preview!;
const prod = cfg.env.production!;

describe("S0.5 два оточення (wrangler.toml)", () => {
  it("0.5.a: account_id угорі; різні name й database_name; різні database_id; верхній рівень без D1", () => {
    expect(cfg.account_id).toBeTypeOf("string");
    expect(cfg.account_id!.length).toBeGreaterThan(0);
    expect(cfg.d1_databases).toBeUndefined();
    expect(preview.name).toBeTruthy();
    expect(prod.name).toBeTruthy();
    expect(preview.name).not.toBe(prod.name);
    const pDb = preview.d1_databases!;
    const qDb = prod.d1_databases!;
    expect(pDb).toHaveLength(1);
    expect(qDb).toHaveLength(1);
    expect(pDb[0]!.binding).toBe("DB");
    expect(qDb[0]!.binding).toBe("DB");
    expect(pDb[0]!.database_name).not.toBe(qDb[0]!.database_name);
    expect(pDb[0]!.database_id).not.toBe(qDb[0]!.database_id);
  });

  it("0.5.b: cron «* * * * *» оголошений у кожному оточенні окремо", () => {
    expect(preview.triggers?.crons).toEqual(["* * * * *"]);
    expect(prod.triggers?.crons).toEqual(["* * * * *"]);
  });

  it("змінна ENV різна в оточеннях і збігається з назвою", () => {
    expect(preview.vars?.ENV).toBe("preview");
    expect(prod.vars?.ENV).toBe("production");
  });
});

describe("0.5.c секрети не в репозиторії", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  it("жодного .env / .dev.vars / secret у трекнутих файлах", () => {
    expect(tracked.filter((f) => /(\.env|\.dev\.vars|secret)/i.test(path.basename(f)))).toEqual([]);
  });

  it("жодного рядка, схожого на токен бота, у трекнутих текстових файлах", () => {
    const re = /\d{8,}:[\w-]{30,}/;
    const hits = tracked
      .filter((f) => /\.(ts|toml|json|md|sql|sh|yml|yaml)$/.test(f) && !f.endsWith("package-lock.json"))
      .filter((f) => re.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
