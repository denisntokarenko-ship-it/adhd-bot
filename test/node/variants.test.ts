// S2.10.a: розмір пулів. Тон (заборонені слова, емодзі, рядки) стереже tone.test.ts на ВСІХ пулах автоматично.
import { describe, expect, it } from "vitest";
import * as texts from "../../src/texts";

const AT_LEAST_5 = [
  "REMIND_DUE_POOL",
  "REMIND_REPEAT2_POOL",
  "REMIND_REPEAT3_POOL",
  "REMIND_REPEAT4_POOL",
  "REMIND_EVE_POOL",
  "REMIND_LEAVE_POOL",
  "TRAVEL_ASK_POOL", // борг 2.3
  "ACK_TRAVEL_POOL", // борг 2.3
  "SUMMARY_HEAD_POOL",
  "ACK_OK_POOL",
  "ACK_LATER_POOL",
  "ACK_REL_POOL",
  "ACK_PAUSE_POOL",
  "ACK_RESUME_POOL",
  "DIGEST_MORNING_POOL",
  "DIGEST_WARM_POOL",
  "DIGEST_EVENING_POOL",
  "DIGEST_WEEKLY_POOL",
  "WK_TODAY_POOL",
] as const;

describe("S2.10.a пули ≥ 5 варіантів, без дублів", () => {
  for (const name of AT_LEAST_5) {
    it(name, () => {
      const pool = (texts as Record<string, unknown>)[name] as readonly string[];
      expect(pool.length).toBeGreaterThanOrEqual(5);
      expect(new Set(pool).size).toBe(pool.length);
    });
  }

  it("ACK_PAUSE_POOL: кожен варіант має рівно один `{t}` (час, до якого тиша)", () => {
    for (const t of texts.ACK_PAUSE_POOL) expect(t.split("{t}")).toHaveLength(2);
  });
});
