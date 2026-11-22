import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOT_COMMANDS, verifyCommands } from "../../scripts/set-commands.mjs";
import { parseTz } from "../../src/settings/tz";

// S3.9: меню команд. Висновок «ГОТОВО» — за ВІДПОВІДДЮ getMyCommands; токен скрипт не друкує (як set-webhook.mjs).
describe("scripts/set-commands.mjs", () => {
  it("меню: /today · /settings · /pause · /resume · /export; /start, /quiet, /tz працюють, але не в меню", () => {
    expect(BOT_COMMANDS.map((c) => c.command)).toEqual(["today", "settings", "pause", "resume", "export"]);
    for (const hidden of ["start", "quiet", "tz"]) expect(BOT_COMMANDS.map((c) => c.command)).not.toContain(hidden);
  });

  it("формат Telegram: команда [a-z0-9_]{1,32}, опис 1–256, без слів-звинувачень (НФ-4)", () => {
    for (const c of BOT_COMMANDS) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThanOrEqual(1);
      expect(c.description.length).toBeLessThanOrEqual(256);
      for (const w of ["прострочен", "пропустив", "забув", "знову", "провал"]) expect(c.description.toLowerCase()).not.toContain(w);
    }
  });

  it("verifyCommands: збігається — без проблем; інший склад, порядок чи опис — кожне червоне; порожня відповідь — не «ГОТОВО»", () => {
    expect(verifyCommands(BOT_COMMANDS)).toEqual([]);
    expect(verifyCommands(BOT_COMMANDS.slice(1))).toHaveLength(1);
    expect(verifyCommands([...BOT_COMMANDS].reverse()).length).toBeGreaterThan(0);
    expect(verifyCommands(BOT_COMMANDS.map((c, i) => (i === 0 ? { ...c, description: "інший" } : c)))).toHaveLength(1);
    expect(verifyCommands(undefined)).toHaveLength(1);
    expect(verifyCommands([])).toHaveLength(1);
  });

  it("токен ніде не друкується: жодного console.* з token у скрипті", () => {
    const src = readFileSync(new URL("../../scripts/set-commands.mjs", import.meta.url), "utf8");
    for (const line of src.split("\n").filter((l) => /console\.(log|error|warn)/.test(l))) expect(line).not.toMatch(/token|TOKEN/);
  });
});

describe("parseTz (S3.7.c)", () => {
  it("приймає назви IANA, виправляє регістр; відхиляє невідоме, зсуви, сміття й задовге", () => {
    expect(parseTz("Europe/Lisbon")).toBe("Europe/Lisbon");
    expect(parseTz("  europe/lisbon ")).toBe("Europe/Lisbon");
    expect(parseTz("Asia/Tokyo")).toBe("Asia/Tokyo");
    for (const bad of ["", "   ", "Mars/Olympus", "+02:00", "UTC+2", "Europe/Kyiv; DROP", "Europe Kyiv", "x".repeat(65), "<b>"]) expect(parseTz(bad), bad).toBeNull();
  });
});
