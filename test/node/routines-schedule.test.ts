// Розклад рутин (docs/spec/phase-4.md, S4.4) і межа з ШІ на рівні імпортів (S4.3, 4.3.g).
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_DAYS, MISSED_AFTER_MS, WEEKDAYS, dayBit, nextRoutineSlot, normalizeTimes, slotsOfDay, validTitle } from "../../src/routines/schedule";
import { readSources } from "./guard-lib";

const K = "Europe/Kyiv";
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const at = (s: string) => Date.parse(s);
const MED = { times: ["08:00", "20:00"], days_mask: ALL_DAYS };
const WEEK = { times: ["08:00", "20:00"], days_mask: WEEKDAYS };

describe("slotsOfDay: days_mask і локальна дата", () => {
  it("08:00 і 20:00 Пн–Пт: у суботу й неділю нічого, у п'ятницю й понеділок — обидва", () => {
    expect(slotsOfDay(WEEK, "2026-11-21", K)).toEqual([]); // субота
    expect(slotsOfDay(WEEK, "2026-11-22", K)).toEqual([]); // неділя
    expect(slotsOfDay(WEEK, "2026-11-20", K).map(iso)).toEqual(["2026-11-20T06:00:00Z", "2026-11-20T18:00:00Z"]);
    expect(slotsOfDay(WEEK, "2026-11-23", K).map(iso)).toEqual(["2026-11-23T06:00:00Z", "2026-11-23T18:00:00Z"]);
  });

  it("біт 0 = понеділок … біт 6 = неділя", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(dayBit)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(slotsOfDay({ times: ["09:00"], days_mask: dayBit(6) }, "2026-11-21", K)).toHaveLength(1); // лише субота
    expect(slotsOfDay({ times: ["09:00"], days_mask: dayBit(6) }, "2026-11-22", K)).toEqual([]);
  });

  it("НФ-1: перехід на літній час не зсуває 08:00 за Києвом (UTC-мить зсувається на годину)", () => {
    const r = { times: ["08:00"], days_mask: ALL_DAYS };
    expect(slotsOfDay(r, "2026-03-28", K).map(iso)).toEqual(["2026-03-28T06:00:00Z"]); // зима +2
    expect(slotsOfDay(r, "2026-03-29", K).map(iso)).toEqual(["2026-03-29T05:00:00Z"]); // літо +3
    expect(slotsOfDay(r, "2026-10-24", K).map(iso)).toEqual(["2026-10-24T05:00:00Z"]);
    expect(slotsOfDay(r, "2026-10-25", K).map(iso)).toEqual(["2026-10-25T06:00:00Z"]);
  });

  it("4.4.f: 03:30 на 2026-03-29 → 04:30 Київ; на 2026-10-25 — перше входження; 03:30 і 04:30 у день стрибка — один слот", () => {
    expect(slotsOfDay({ times: ["03:30"], days_mask: ALL_DAYS }, "2026-03-29", K).map(iso)).toEqual(["2026-03-29T01:30:00Z"]);
    expect(slotsOfDay({ times: ["03:30"], days_mask: ALL_DAYS }, "2026-10-25", K).map(iso)).toEqual(["2026-10-25T00:30:00Z"]);
    expect(slotsOfDay({ times: ["03:30", "04:30"], days_mask: ALL_DAYS }, "2026-03-29", K).map(iso)).toEqual(["2026-03-29T01:30:00Z"]);
  });
});

describe("nextRoutineSlot (S4.4)", () => {
  it("4.4.a: 07:00 Київ → сьогоднішнє 08:00", () => {
    expect(iso(nextRoutineSlot(MED, K, at("2026-11-20T05:00:00Z")))).toBe("2026-11-20T06:00:00Z");
  });

  it("4.4.b: Пн–Пт, п'ятниця 21:00 → понеділок 08:00 (субота й неділя пропущені)", () => {
    expect(iso(nextRoutineSlot(WEEK, K, at("2026-11-20T19:00:00Z")))).toBe("2026-11-23T06:00:00Z");
    expect(iso(nextRoutineSlot(WEEK, K, at("2026-11-21T05:00:00Z")))).toBe("2026-11-23T06:00:00Z"); // субота 07:00
  });

  it("4.4.d: слот, що настав ≤ 5 хв тому, ще найближчий; о 08:06 — наступний", () => {
    expect(iso(nextRoutineSlot(MED, K, at("2026-11-20T06:03:00Z")))).toBe("2026-11-20T06:00:00Z");
    expect(iso(nextRoutineSlot(MED, K, at("2026-11-20T06:05:00Z")))).toBe("2026-11-20T06:00:00Z"); // рівно LATE_MS — ще так
    expect(iso(nextRoutineSlot(MED, K, at("2026-11-20T06:06:00Z")))).toBe("2026-11-20T18:00:00Z");
    expect(iso(nextRoutineSlot(MED, K, at("2026-11-20T18:06:00Z")))).toBe("2026-11-21T06:00:00Z");
  });

  it("4.4.f: день тижня — локальний: субота 00:30 Київ (UTC ще п'ятниця), «лише сб 00:45» → сьогодні", () => {
    expect(iso(nextRoutineSlot({ times: ["00:45"], days_mask: dayBit(6) }, K, at("2026-11-20T22:30:00Z")))).toBe("2026-11-20T22:45:00Z");
  });

  it("4.4.f: 03:30 у ніч переходів — по одній миті щоразу", () => {
    const r = { times: ["03:30"], days_mask: ALL_DAYS };
    expect(iso(nextRoutineSlot(r, K, at("2026-03-28T22:00:00Z")))).toBe("2026-03-29T01:30:00Z");
    expect(iso(nextRoutineSlot(r, K, at("2026-10-24T21:00:00Z")))).toBe("2026-10-25T00:30:00Z");
    expect(iso(nextRoutineSlot(r, K, at("2026-10-25T00:36:00Z")))).toBe("2026-10-26T01:30:00Z"); // друге входження 03:30 — не слот
  });

  it("константа missed — 30 хв", () => expect(MISSED_AFTER_MS).toBe(30 * 60_000));
});

describe("валідація назви й часів (код, не лише CHECK)", () => {
  it("normalizeTimes: сортує, прибирає повтори; порожньо, 7 часів, не HH:MM → null", () => {
    expect(normalizeTimes(["20:00", "08:00", "20:00"])).toEqual(["08:00", "20:00"]);
    expect(normalizeTimes([])).toBeNull();
    expect(normalizeTimes(["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"])).toBeNull();
    for (const bad of ["8:00", "24:00", "08:60", "08:00 ", "0800"]) expect(normalizeTimes([bad]), bad).toBeNull();
  });

  it("validTitle: 1..64 символи (кодові точки), один рядок", () => {
    expect(validTitle("Вітамін D")).toBe(true);
    expect(validTitle("💊".repeat(64))).toBe(true); // 64 кодові точки = 128 UTF-16 одиниць
    expect(validTitle("х".repeat(65))).toBe(false);
    expect(validTitle("")).toBe(false);
    expect(validTitle("a\nb")).toBe(false);
    expect(validTitle("a\rb")).toBe(false);
  });
});

// ── 4.3.g (статичний): модулі, що збирають промпт, не дістають src/db/routines ні прямо, ні через ланцюг імпортів ──

const files = readSources();
const byPath = new Map(files.map((f) => [f.path, f.text]));
const specifiers = (text: string) => [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);

function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // пакети (grammy, SDK) — не наш код
  const base = path.posix.join(path.posix.dirname(from), spec).replace(/\.(js|ts)$/, "");
  for (const cand of [`${base}.ts`, `${base}/index.ts`]) if (byPath.has(cand)) return cand;
  return null;
}

// Усі файли src/, досяжні імпортами з `start` (включно з ним).
function reachable(start: string): Set<string> {
  const seen = new Set<string>();
  const todo = [start];
  while (todo.length > 0) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const s of specifiers(byPath.get(f) ?? "")) {
      const r = resolve(f, s);
      if (r !== null) todo.push(r);
    }
  }
  return seen;
}

describe("4.3.g межа з ШІ: src/ai/** не імпортує src/db/routines", () => {
  const aiFiles = files.map((f) => f.path).filter((p) => p.startsWith("src/ai/"));

  it("жоден файл src/ai/ — ні прямо, ні транзитивно", () => {
    expect(aiFiles).toEqual(expect.arrayContaining(["src/ai/parse.ts", "src/ai/prompt.ts", "src/ai/client.ts"]));
    expect(byPath.has("src/db/routines.ts")).toBe(true); // охоронець не сліпий: модуль існує
    const leaks = aiFiles.flatMap((f) => [...reachable(f)].filter((r) => /^src\/db\/routines/.test(r)).map((r) => `${f} → ${r}`));
    expect(leaks).toEqual([]);
  });

  it("охоронець бачить і прямий, і транзитивний імпорт (самоперевірка на підставних файлах)", () => {
    byPath.set("src/ai/__probe_direct.ts", 'import { listRoutines } from "../db/routines";');
    byPath.set("src/ai/__probe_via.ts", 'import { x } from "../__probe_mid";');
    byPath.set("src/__probe_mid.ts", 'export * from "./db/routines";');
    try {
      expect([...reachable("src/ai/__probe_direct.ts")]).toContain("src/db/routines.ts");
      expect([...reachable("src/ai/__probe_via.ts")]).toContain("src/db/routines.ts");
    } finally {
      for (const p of ["src/ai/__probe_direct.ts", "src/ai/__probe_via.ts", "src/__probe_mid.ts"]) byPath.delete(p);
    }
  });
});
