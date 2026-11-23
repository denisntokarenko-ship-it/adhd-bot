import { describe, expect, it } from "vitest";
import { exportedFunctions, readSources, unrecognizedExports } from "./guard-lib";

// S1.9.e + S2.4.k: журнал очок має рівно ці експорти: +1 за захоплення (Фаза 1) і +10 «зроблено» (крок 2.2), +10 за «✅» на слот рутини (крок 4.2). Нова функція
// (інша причина очок, від'ємний delta/redeem) — свідома правка цього списку у кроці своєї фази (5.2, 6.1), а не тихе доповнення.
describe("S1.9.e src/db/points.ts", () => {
  const src = readSources().find((f) => f.path === "src/db/points.ts")!;

  it("експорти — лише captureStatement, doneStatement, routineDoneStatement (4.2), balance, listForExport", () => {
    expect(exportedFunctions(src.text).map((f) => f.name).sort()).toEqual(["balance", "captureStatement", "doneStatement", "listForExport", "routineDoneStatement"]);
    expect(unrecognizedExports(src.text)).toEqual([]);
  });

  it("жодна функція не приймає delta чи reason від викликача і не пише redeem чи від'ємного значення", () => {
    const params = [...src.text.matchAll(/export\s+(?:async\s+)?function\s+\w+\s*\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(params.length).toBe(5);
    for (const p of params) expect(p).not.toMatch(/\b(delta|reason)\b/); // ні delta, ні reason від викликача
    expect(src.text).not.toMatch(/'redeem'/);
    expect(src.text).not.toMatch(/VALUES\s*\([^)]*-\d/);
  });
});
