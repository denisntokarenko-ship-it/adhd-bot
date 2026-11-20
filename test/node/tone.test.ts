import { describe, expect, it } from "vitest";
import { parseAllowlist } from "../../src/config";
import { GREET_POOL, PRIVATE_BOT_TEXT, SOON_POOL, pickVariant } from "../../src/texts";

// НФ-4: слова-звинувачення, яких у репліках бота немає. Список ростиме разом з пулами.
const FORBIDDEN = ["прострочен", "пропустив", "пропустила", "забув", "забула", "знову", "ніколи не", "провал", "не зробив", "не виконав", "❌", "🔴"];

const pools: Record<string, readonly string[]> = { GREET_POOL, SOON_POOL, PRIVATE: [PRIVATE_BOT_TEXT] };

describe("НФ-4 тон текстів", () => {
  it("кожен повторюваний пул має ≥ 3 варіантів без дублів", () => {
    for (const pool of [GREET_POOL, SOON_POOL]) {
      expect(pool.length).toBeGreaterThanOrEqual(3);
      expect(new Set(pool).size).toBe(pool.length);
    }
  });

  it("жодного забороненого слова в жодному пулі", () => {
    for (const [name, pool] of Object.entries(pools)) {
      for (const text of pool) {
        for (const w of FORBIDDEN) expect(text.toLowerCase(), `${name}: «${text}» містить «${w}»`).not.toContain(w);
      }
    }
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
