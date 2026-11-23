import { describe, expect, it } from "vitest";
import { parseAllowlist } from "../../src/config";
import * as texts from "../../src/texts";
import { pickVariant } from "../../src/texts";

// НФ-4: слова-звинувачення, яких у репліках бота немає. Список ростиме разом з пулами.
const FORBIDDEN = ["прострочен", "пропустив", "пропустила", "пропущено", "не прийняв", "не прийняла", "забув", "забула", "знову", "ніколи не", "провал", "не зробив", "не виконав", "❌", "🔴"];

// Пули збираються з усіх експортів src/texts.ts автоматично: новий пул не можна «забути» вписати (НФ-4).
function collectPools(mod: Record<string, unknown>): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const [name, v] of Object.entries(mod)) {
    if (typeof v === "string") out[name] = [v];
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[name] = v as string[];
    else if (typeof v !== "function") throw new Error(`НФ-4: експорт ${name} має невідомий тип — тон не перевіряється`);
  }
  return out;
}

function forbiddenHits(pools: Record<string, readonly string[]>): string[] {
  const hits: string[] = [];
  for (const [name, pool] of Object.entries(pools)) {
    for (const text of pool) for (const w of FORBIDDEN) if (text.toLowerCase().includes(w)) hits.push(`${name}: «${text}» містить «${w}»`);
  }
  return hits;
}

const pools = collectPools(texts);

describe("НФ-4 тон текстів", () => {
  it("збирач бачить усі пули src/texts.ts, а новий пул з забороненими словами — червоний", () => {
    expect(Object.keys(pools)).toEqual(expect.arrayContaining(["GREET_POOL", "SOON_POOL", "PRIVATE_BOT_TEXT"]));
    const evil = collectPools({ ...texts, RECEIPT_POOL: ["Ти знову забув", "Прострочено", "Провал"] });
    const hits = forbiddenHits(evil).join("\n");
    for (const t of ["Ти знову забув", "Прострочено", "Провал"]) expect(hits).toContain(`«${t}»`);
    expect(() => collectPools({ X: 5 })).toThrow(/невідомий тип/);
  });

  it("кожен повторюваний пул (*_POOL) має ≥ 3 варіантів без дублів", () => {
    const repeating = Object.entries(pools).filter(([name]) => name.endsWith("_POOL"));
    expect(repeating.length).toBeGreaterThanOrEqual(2);
    for (const [, pool] of repeating) {
      expect(pool.length).toBeGreaterThanOrEqual(3);
      expect(new Set(pool).size).toBe(pool.length);
    }
  });

  it("жодного забороненого слова в жодному пулі", () => {
    expect(forbiddenHits(pools)).toEqual([]);
  });

  it("до 2 емодзі й до 4 рядків на повідомлення", () => {
    const emoji = /\p{Extended_Pictographic}/gu;
    for (const pool of Object.values(pools)) {
      for (const text of pool) {
        expect((text.match(emoji) ?? []).length).toBeLessThanOrEqual(2);
        expect(text.split("\n").length).toBeLessThanOrEqual(4);
      }
    }
  });

  it("pickVariant ніколи не повертає попередній індекс", () => {
    for (const last of [null, 0, 1, 2]) {
      for (const r of [0, 0.34, 0.5, 0.99]) {
        const idx = pickVariant(3, last, () => r);
        expect(idx).not.toBe(last);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(3);
      }
    }
  });
});

describe("parseAllowlist (0.6.b–c)", () => {
  it("розбирає «111, 222» і відхиляє порожнє, сміття, змішане", () => {
    expect(parseAllowlist("111, 222")).toEqual(new Set([111, 222]));
    expect(parseAllowlist("111")).toEqual(new Set([111]));
    for (const bad of [undefined, "", "  ", " , ", "abc", "111, abc", "-5", "1.5", "111,,222"]) {
      expect(parseAllowlist(bad), String(bad)).toBeNull();
    }
  });
});
