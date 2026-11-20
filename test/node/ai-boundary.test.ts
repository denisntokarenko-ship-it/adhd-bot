import { describe, expect, it } from "vitest";
import { aiConfig, DEFAULT_AI_DAILY_LIMIT, DEFAULT_AI_MODEL_PARSE } from "../../src/config";
import { localToUtc } from "../../src/time";
import { readSources } from "./guard-lib";

const files = readSources();
const importsOf = (text: string) => [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);

describe("S1.2 межі модулів ШІ", () => {
  it("SDK імпортується лише в src/ai/client.ts", () => {
    expect(files.length).toBeGreaterThan(5);
    const users = files.filter((f) => importsOf(f.text).some((s) => s.startsWith("@anthropic-ai/"))).map((f) => f.path);
    expect(users).toEqual(["src/ai/client.ts"]);
  });

  it("1.2.f: конструктор промпту не імпортує нічого з src/db/", () => {
    const prompt = files.find((f) => f.path === "src/ai/prompt.ts")!;
    expect(importsOf(prompt.text).filter((s) => /\bdb\b/.test(s))).toEqual([]);
    expect(importsOf(prompt.text)).toEqual([]); // чиста функція: жодних імпортів узагалі
  });

  it("схема відповіді не має полів-«дій» (НФ-2)", async () => {
    const { PARSE_SCHEMA } = await import("../../src/ai/schema");
    const item = PARSE_SCHEMA.properties.items.items;
    expect(Object.keys(item.properties).sort()).toEqual(
      ["all_day", "body", "date_unclear", "due_local", "kind", "priority", "title"],
    );
    expect(item.additionalProperties).toBe(false);
    expect(PARSE_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("aiConfig", () => {
  it("за замовчуванням: Haiku 5.5 і 100 викликів на добу", () => {
    expect(aiConfig({})).toEqual({ model: DEFAULT_AI_MODEL_PARSE, dailyLimit: DEFAULT_AI_DAILY_LIMIT });
    expect(DEFAULT_AI_MODEL_PARSE).toBe("claude-haiku-5-5");
    expect(DEFAULT_AI_DAILY_LIMIT).toBe(100);
  });

  it("змінні перекривають; сміття й від'ємне — не «безліміт»", () => {
    expect(aiConfig({ AI_MODEL_PARSE: "x-model", AI_DAILY_LIMIT: "5" })).toEqual({ model: "x-model", dailyLimit: 5 });
    for (const bad of ["abc", "-3", "", " ", "1.5"]) expect(aiConfig({ AI_DAILY_LIMIT: bad }).dailyLimit).toBe(100);
  });
});

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().replace(".000Z", "Z"));
const K = "Europe/Kyiv";

describe("localToUtc (S1.3 1.3.a–c, НФ-1)", () => {
  it("1.3.a: зима +2, літо +3", () => {
    expect(iso(localToUtc("2026-11-21T10:00", K))).toBe("2026-11-21T08:00:00Z");
    expect(iso(localToUtc("2026-07-01T10:00", K))).toBe("2026-07-01T07:00:00Z");
  });

  it("1.3.b: неіснуюча година 03:30 29.03 зсувається вперед; подвійна 03:30 25.10 — перше (літнє) входження", () => {
    expect(iso(localToUtc("2026-03-29T03:30", K))).toBe("2026-03-29T01:30:00Z");
    expect(iso(localToUtc("2026-10-25T03:30", K))).toBe("2026-10-25T00:30:00Z");
  });

  it("лише дата — початок локальної доби", () => {
    expect(iso(localToUtc("2026-11-21", K))).toBe("2026-11-20T22:00:00Z");
    expect(iso(localToUtc("2026-03-29", K))).toBe("2026-03-28T22:00:00Z");
  });

  it.each(["2026-02-30T10:00", "2026-13-01", "2026-11-21T25:00", "2026-11-21T10:60", "завтра", "2026-11-21T10:00:00Z", "2026-11-21T10:00+02:00", ""])(
    "1.3.c: %j → null",
    (bad) => {
      expect(localToUtc(bad, K)).toBeNull();
    },
  );
});
