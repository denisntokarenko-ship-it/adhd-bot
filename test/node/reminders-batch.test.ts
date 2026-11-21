// Чисті правила відправки (docs/spec/phase-2.md S2.6, S2.4.g): без БД і без «зараз» усередині.
import { describe, expect, it } from "vitest";
import { LATE_MS, selectBatch, snoozeAt, type BatchCtx, type BatchRow } from "../../src/reminders/plan";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const MIN = 60_000;
const row = (id: number, ago = 1000, over: Partial<BatchRow> = {}): BatchRow => ({ id, fireAt: NOW - ago, important: false, parentSentAs: null, ...over });
const ctx = (over: Partial<BatchCtx> = {}): BatchCtx => ({ now: NOW, singlesLastHour: 0, summariesLastHour: 0, ...over });
const ids = (rs: BatchRow[]) => rs.map((r) => r.id);

describe("S2.6 selectBatch (чиста функція)", () => {
  it("2.6.a: 8 свіжих → 6 окремих + зведення з двома (поріг 6)", () => {
    const p = selectBatch(Array.from({ length: 8 }, (_, k) => row(k + 1, 1000 - k)), ctx());
    expect(p.singles).toHaveLength(6);
    expect(ids(p.summary)).toEqual([7, 8]);
    expect(p.wait).toEqual([]);
  });

  it("2.6.a: 9-й у ту ж годину (вікно зайняте) чекає; після 6 окремих і зведення нічого не йде", () => {
    const p = selectBatch([row(9)], ctx({ singlesLastHour: 6, summariesLastHour: 1 }));
    expect(p).toEqual({ singles: [], summary: [], wait: [row(9)] });
  });

  it("2.6.g (R-2, Б2): вікно зведення зайняте — «час виходити» (noWait) іде окремо навіть понад ліміт, решта чекає", () => {
    const leave = row(4, 1000, { noWait: true });
    // п.1: 2 повтори зі зведення → «усе чекає», крім noWait
    const p1 = selectBatch([row(1, 10 * MIN, { parentSentAs: "summary" }), row(2, 10 * MIN, { parentSentAs: "summary" }), leave], ctx({ summariesLastHour: 1 }));
    expect(ids(p1.singles)).toEqual([4]);
    expect(ids(p1.wait)).toEqual([1, 2]);
    // п.3: ліміт окремих вичерпано, вікно зайняте → noWait однаково йде, звичайний чекає
    const p3 = selectBatch([row(5), leave], ctx({ singlesLastHour: 6, summariesLastHour: 1 }));
    expect(ids(p3.singles)).toEqual([4]);
    expect(ids(p3.wait)).toEqual([5]);
    // вікно вільне → noWait у зведенні разом з усіма (виняток лише замість «чекають»)
    const pf = selectBatch([row(1, 10 * MIN), row(2, 10 * MIN), leave], ctx());
    expect(ids(pf.summary)).toEqual([1, 2, 4]);
  });

  it("2.6.e: 2 запізнілих + 1 свіжий → одне зведення з трьох", () => {
    const p = selectBatch([row(1, 10 * MIN), row(2, 8 * MIN), row(3)], ctx());
    expect(p.singles).toEqual([]);
    expect(ids(p.summary)).toEqual([1, 2, 3]);
  });

  it("2.6.e: 1 запізнілий + 7 свіжих → 6 окремих + зведення з двох", () => {
    const rows = [row(1, 10 * MIN), ...Array.from({ length: 7 }, (_, k) => row(k + 2, 1000 - k))];
    const p = selectBatch(rows, ctx());
    expect(p.singles).toHaveLength(6);
    expect(p.summary).toHaveLength(2);
  });

  it("межа «запізнілого»: fire_at = now − LATE_MS уже запізнілий (≤), на мілісекунду пізніше — ні", () => {
    expect(selectBatch([row(1, LATE_MS), row(2, LATE_MS)], ctx()).summary).toHaveLength(2);
    expect(selectBatch([row(1, LATE_MS - 1), row(2, LATE_MS - 1)], ctx()).singles).toHaveLength(2);
  });

  it("2.6.f: нащадки рядків-зі-зведення (≥ 2) не розсипаються на окремі пуші; зведення за годину було — чекають", () => {
    const kids = [1, 2, 3].map((id) => row(id, 1000, { parentSentAs: "summary" }));
    expect(selectBatch(kids, ctx()).summary).toHaveLength(3);
    expect(selectBatch(kids, ctx({ summariesLastHour: 1 }))).toMatchObject({ singles: [], summary: [], wait: kids });
    // без parentSentAs ті самі рядки пішли б трьома пушами (мутант: п.1 без parentSentAs — червоніє)
    expect(selectBatch(kids.map((k) => ({ ...k, parentSentAs: "single" as const })), ctx()).singles).toHaveLength(3);
  });

  it("важливе перед звичайним, далі fire_at, id", () => {
    const p = selectBatch([row(1, 3000), row(2, 1000, { important: true }), row(3, 2000)], ctx());
    expect(ids(p.singles)).toEqual([2, 1, 3]);
  });

  it("порожнього зведення не буває; залишок вікна враховано (4 уже пішло → 2 окремих + зведення)", () => {
    expect(selectBatch([], ctx())).toEqual({ singles: [], summary: [], wait: [] });
    const p = selectBatch([row(1), row(2), row(3), row(4)], ctx({ singlesLastHour: 4 }));
    expect(p.singles).toHaveLength(2);
    expect(p.summary).toHaveLength(2);
  });
});

describe("S2.4.g snoozeAt", () => {
  const user = { tz: "Europe/Kyiv", morning_at: 540 };
  it("+15 хв, +1 год", () => {
    expect(snoozeAt("s15", NOW, user)).toBe(NOW + 15 * MIN);
    expect(snoozeAt("s60", NOW, user)).toBe(NOW + 60 * MIN);
  });
  it("«завтра» о 00:30 суботи (22:30Z пт) → неділя 09:00 Київ (07:00Z), а не сьогодні о 09:00", () => {
    expect(snoozeAt("tom", Date.parse("2026-11-20T22:30:00Z"), user)).toBe(Date.parse("2026-11-22T07:00:00Z"));
  });
  it("літній перехід: 00:00 сб 28.03 → нд 29.03 09:00 за місцевим, уже літній (06:00Z)", () => {
    expect(snoozeAt("tom", Date.parse("2026-03-27T22:00:00Z"), user)).toBe(Date.parse("2026-03-29T06:00:00Z"));
  });
  it("«завтра» бере morning_at користувача", () => {
    expect(snoozeAt("tom", NOW, { tz: "Europe/Kyiv", morning_at: 8 * 60 + 30 })).toBe(Date.parse("2026-11-21T06:30:00Z"));
  });
});
