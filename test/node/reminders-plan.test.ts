// Чисті функції черги нагадувань (docs/spec/phase-2.md S2.1, S2.2, S2.9.d): без БД, час — параметром.
import { describe, expect, it } from "vitest";
import { LATE_MS, nextLocalMinute, nextRepeat, plannedFor, shiftForQuiet, type PlanItem } from "../../src/reminders/plan";

const KYIV = "Europe/Kyiv";
const user = { tz: KYIV, morning_at: 540 };
const quiet = { tz: KYIV, quiet_from: 1380, quiet_to: 480, pause_until: null }; // 23:00–08:00
const at = (iso: string) => Date.parse(iso);
const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  kind: "task", due_at: at("2026-11-20T12:00:00Z"), all_day: 0, priority: "normal", status: "open", travel_min: null, ...over,
});

// Ланцюг до кінця: кожну спробу «відправлено» о `sendAt(fireAt)`; повертає миті всіх спроб.
function chain(first: number, max: number, eventDueAt: number | null = null, sendAt = (f: number) => f): number[] {
  const sent: number[] = [];
  let row = { attempt: 1, max_attempts: max, sent_at: sendAt(first) };
  sent.push(row.sent_at);
  for (let next = nextRepeat(row, eventDueAt); next !== null; next = nextRepeat(row, eventDueAt)) {
    row = { attempt: next.attempt, max_attempts: max, sent_at: sendAt(next.fireAt) };
    sent.push(row.sent_at);
    if (sent.length > 10) break; // запобіжник від нескінченного ланцюга під мутантом
  }
  return sent;
}

describe("S2.2 nextRepeat — рівно 4 для важливого, 1 для звичайного", () => {
  it("2.2.a/b: important → рівно 4 спроби: 10:00, 10:05, 10:20, 10:50 — ніколи 5", () => {
    const [due] = plannedFor(item({ priority: "important", due_at: at("2026-11-20T08:00:00Z") }), at("2026-11-20T07:00:00Z"), user);
    expect(due).toEqual({ kind: "due", fireAt: at("2026-11-20T08:00:00Z"), maxAttempts: 4 });
    expect(chain(due!.fireAt, due!.maxAttempts).map((t) => new Date(t).toISOString())).toEqual([
      "2026-11-20T08:00:00.000Z", "2026-11-20T08:05:00.000Z", "2026-11-20T08:20:00.000Z", "2026-11-20T08:50:00.000Z",
    ]);
    expect(nextRepeat({ attempt: 4, max_attempts: 4, sent_at: at("2026-11-20T08:50:00Z") })).toBeNull();
  });

  it("2.2.c: normal → 1 спроба, нащадка немає", () => {
    const [due] = plannedFor(item(), at("2026-11-20T07:00:00Z"), user);
    expect(due!.maxAttempts).toBe(1);
    expect(chain(due!.fireAt, due!.maxAttempts)).toHaveLength(1);
  });

  it("2.2.d: затримка від фактичної відправки — due 10:00 пішло о 10:07 → друга о 10:12", () => {
    expect(nextRepeat({ attempt: 1, max_attempts: 4, sent_at: at("2026-11-20T08:07:00Z") })).toEqual({
      attempt: 2, fireAt: at("2026-11-20T08:12:00Z"),
    });
  });

  it("2.2.e: leave_now події о 10:30 з дорогою 15 → 10:00, 10:05, 10:20; 10:50 > 10:30 не створюється", () => {
    const due = at("2026-11-20T08:30:00Z");
    const rows = plannedFor(item({ kind: "event", due_at: due, travel_min: 15 }), at("2026-11-20T07:00:00Z"), user);
    const leave = rows.find((r) => r.kind === "leave_now")!;
    expect(leave).toEqual({ kind: "leave_now", fireAt: at("2026-11-20T08:00:00Z"), maxAttempts: 4 });
    expect(chain(leave.fireAt, leave.maxAttempts, due)).toEqual([at("2026-11-20T08:00:00Z"), at("2026-11-20T08:05:00Z"), at("2026-11-20T08:20:00Z")]);
  });
});

describe("S2.1 plannedFor — таблиця «Звідки береться нагадування»", () => {
  const now = at("2026-11-20T10:00:00Z"); // 12:00 пт 20.11 Київ

  it("закритий запис, без дати → нічого", () => {
    expect(plannedFor(item({ status: "done" }), now, user)).toEqual([]);
    expect(plannedFor(item({ status: "released" }), now, user)).toEqual([]);
    expect(plannedFor(item({ due_at: null, kind: "note" }), now, user)).toEqual([]);
  });

  it("2.1.d: all_day → due о morning_at тієї локальної доби; 29.03 (перехід) — 09:00 літнього часу", () => {
    const day = (iso: string, prio: PlanItem["priority"] = "normal") =>
      plannedFor(item({ all_day: 1, due_at: at(iso), priority: prio }), at("2026-03-01T00:00:00Z"), user);
    expect(day("2026-11-20T22:00:00Z", "important")).toEqual([{ kind: "due", fireAt: at("2026-11-21T07:00:00Z"), maxAttempts: 4 }]);
    expect(day("2026-03-28T22:00:00Z")).toEqual([{ kind: "due", fireAt: at("2026-03-29T06:00:00Z"), maxAttempts: 1 }]);
    // all_day-подія — теж «due о morning_at», не eve/leave
    expect(plannedFor(item({ kind: "event", all_day: 1, due_at: at("2026-11-20T22:00:00Z") }), now, user)).toEqual([
      { kind: "due", fireAt: at("2026-11-21T07:00:00Z"), maxAttempts: 1 },
    ]);
  });

  it("2.1.e: межа LATE_MS — fire_at = now − 60 с створюється, рівно now − LATE_MS теж, на мс раніше — ні", () => {
    expect(plannedFor(item({ due_at: now - 60_000 }), now, user)).toHaveLength(1);
    expect(plannedFor(item({ due_at: now - LATE_MS }), now, user)).toHaveLength(1);
    expect(plannedFor(item({ due_at: now - LATE_MS - 1 }), now, user)).toEqual([]);
  });

  it("2.7.d: подія завтра 10:00, travel 30 — створена о 12:00 → eve 20:00 і leave 09:15; о 22:00 → лише leave; завтра 09:50 → нічого", () => {
    const ev = item({ kind: "event", due_at: at("2026-11-21T08:00:00Z"), travel_min: 30 });
    expect(plannedFor(ev, now, user)).toEqual([
      { kind: "eve_before", fireAt: at("2026-11-20T18:00:00Z"), maxAttempts: 1 },
      { kind: "leave_now", fireAt: at("2026-11-21T07:15:00Z"), maxAttempts: 4 },
    ]);
    expect(plannedFor(ev, at("2026-11-20T20:00:00Z"), user)).toEqual([{ kind: "leave_now", fireAt: at("2026-11-21T07:15:00Z"), maxAttempts: 4 }]);
    // eve_before лише якщо 20:00 ще попереду більш ніж на 5 хв: 19:56 — уже ні
    expect(plannedFor(ev, at("2026-11-20T17:56:00Z"), user).map((r) => r.kind)).toEqual(["leave_now"]);
    // тик планувальника після створення о 09:50 (09:50:30): leave 09:45 уже старше LATE_MS
    expect(plannedFor({ ...ev, travel_min: null }, at("2026-11-21T07:50:30Z"), user)).toEqual([]);
  });

  it("2.7.c/e: дорога NULL = 0 (due − 15 хв); 60 хв, due 10:00 → 08:45; подія не стає important, leave_now ескалюється завжди", () => {
    const ev = (travel: number | null, prio: PlanItem["priority"] = "normal") =>
      plannedFor(item({ kind: "event", due_at: at("2026-11-21T08:00:00Z"), travel_min: travel, priority: prio }), now, user);
    expect(ev(null).find((r) => r.kind === "leave_now")!.fireAt).toBe(at("2026-11-21T07:45:00Z"));
    expect(ev(60).find((r) => r.kind === "leave_now")!.fireAt).toBe(at("2026-11-21T06:45:00Z"));
    for (const prio of ["normal", "important"] as const)
      expect(ev(0, prio).map((r) => [r.kind, r.maxAttempts])).toEqual([["eve_before", 1], ["leave_now", 4]]);
  });

  it("перехід на літній час (29.03, Київ): подія 10:00 → eve 28.03 20:00 зимового (18:00Z), leave 09:30 літнього (06:30Z)", () => {
    const ev = item({ kind: "event", due_at: at("2026-03-29T07:00:00Z"), travel_min: 15 });
    expect(plannedFor(ev, at("2026-03-28T10:00:00Z"), user)).toEqual([
      { kind: "eve_before", fireAt: at("2026-03-28T18:00:00Z"), maxAttempts: 1 },
      { kind: "leave_now", fireAt: at("2026-03-29T06:30:00Z"), maxAttempts: 4 },
    ]);
    // осінній перехід (25.10): подія 10:00 зимового → eve 24.10 20:00 літнього (17:00Z)
    expect(plannedFor(item({ kind: "event", due_at: at("2026-10-25T08:00:00Z") }), at("2026-10-24T10:00:00Z"), user)[0]).toEqual({
      kind: "eve_before", fireAt: at("2026-10-24T17:00:00Z"), maxAttempts: 1,
    });
  });
});

describe("S2.9 shiftForQuiet — «коли можна слати», за годинником tz", () => {
  it("тиха ніч 23:00–08:00 Київ: 07:59 → 08:00; 23:30 → 08:00 наступного дня; 02:00 → 08:00; 08:00 і 08:30 — без змін", () => {
    expect(shiftForQuiet(at("2026-11-21T05:59:00Z"), quiet)).toBe(at("2026-11-21T06:00:00Z"));
    expect(shiftForQuiet(at("2026-11-20T21:30:00Z"), quiet)).toBe(at("2026-11-21T06:00:00Z"));
    expect(shiftForQuiet(at("2026-11-21T00:00:00Z"), quiet)).toBe(at("2026-11-21T06:00:00Z"));
    expect(shiftForQuiet(at("2026-11-21T06:00:00Z"), quiet)).toBe(at("2026-11-21T06:00:00Z"));
    expect(shiftForQuiet(at("2026-11-21T06:30:00Z"), quiet)).toBe(at("2026-11-21T06:30:00Z"));
  });

  it("2.9.d: тиша в ніч переходу закінчується о 08:00 за місцевим — 29.03 (05:00Z) і 25.10 (06:00Z)", () => {
    expect(shiftForQuiet(at("2026-03-29T00:00:00Z"), quiet)).toBe(at("2026-03-29T05:00:00Z"));
    expect(shiftForQuiet(at("2026-03-28T21:30:00Z"), quiet)).toBe(at("2026-03-29T05:00:00Z"));
    expect(shiftForQuiet(at("2026-10-24T23:00:00Z"), quiet)).toBe(at("2026-10-25T06:00:00Z"));
  });

  it("Д1 (рев'ю 2.1): кінець тиші о 03:xx у ніч осіннього переходу — не раніше за вхідну мить (друге входження 03:00–03:59)", () => {
    const night = { tz: KYIV, quiet_from: 60, quiet_to: 210, pause_until: null }; // 01:00–03:30
    // 25.10 03:15 удруге (EET, 01:15Z) — у тиші; кінець — 03:30 удруге = 01:30Z, а не 03:30 вперше (00:30Z, раніше за вхід)
    expect(shiftForQuiet(at("2026-10-25T01:15:00Z"), night)).toBe(at("2026-10-25T01:30:00Z"));
    // 03:15 вперше (EEST, 00:15Z) — кінець тиші 03:30 вперше = 00:30Z
    expect(shiftForQuiet(at("2026-10-25T00:15:00Z"), night)).toBe(at("2026-10-25T00:30:00Z"));
    // контракт «найраніша мить ≥ fireAt» на кожній хвилині ночі
    for (let t = at("2026-10-24T22:00:00Z"); t < at("2026-10-25T03:00:00Z"); t += 60_000) expect(shiftForQuiet(t, night)).toBeGreaterThanOrEqual(t);
  });

  it("пауза: до pause_until; пауза, що закінчується в тиші, → кінець тиші; рівні межі — тиші немає", () => {
    const pause = (until: string) => ({ ...quiet, pause_until: at(until) });
    expect(shiftForQuiet(at("2026-11-21T07:00:00Z"), pause("2026-11-21T08:00:00Z"))).toBe(at("2026-11-21T08:00:00Z"));
    expect(shiftForQuiet(at("2026-11-20T19:00:00Z"), pause("2026-11-20T21:30:00Z"))).toBe(at("2026-11-21T06:00:00Z"));
    expect(shiftForQuiet(at("2026-11-21T09:00:00Z"), pause("2026-11-21T08:00:00Z"))).toBe(at("2026-11-21T09:00:00Z"));
    expect(shiftForQuiet(at("2026-11-21T00:00:00Z"), { ...quiet, quiet_from: 600, quiet_to: 600 })).toBe(at("2026-11-21T00:00:00Z"));
    // денне вікно 13:00–15:00 (не через північ): 14:00 → 15:00 того ж дня
    expect(shiftForQuiet(at("2026-11-21T12:00:00Z"), { ...quiet, quiet_from: 780, quiet_to: 900 })).toBe(at("2026-11-21T13:00:00Z"));
  });
});

describe("S2.9.e nextLocalMinute — «до ранку» = наступне quiet_to у tz, строго після now", () => {
  const KYIV = "Europe/Kyiv";
  it("07:59 → сьогодні 08:00; рівно 08:00:00 → завтра; 12:00 → завтра 08:00", () => {
    expect(nextLocalMinute(at("2026-11-21T05:59:00Z"), 480, KYIV)).toBe(at("2026-11-21T06:00:00Z"));
    expect(nextLocalMinute(at("2026-11-21T06:00:00Z"), 480, KYIV)).toBe(at("2026-11-22T06:00:00Z"));
    expect(nextLocalMinute(at("2026-11-20T10:00:00Z"), 480, KYIV)).toBe(at("2026-11-21T06:00:00Z"));
  });
  it("00:30 за Києвом (UTC-дата ще вчорашня) → 08:00 тієї ж локальної доби, а не наступної", () => {
    expect(nextLocalMinute(at("2026-11-20T22:30:00Z"), 480, KYIV)).toBe(at("2026-11-21T06:00:00Z"));
  });
  it("перехід на літній час 29.03: 22:00 28-го → 08:00 29-го за EEST (05:00Z)", () => {
    expect(nextLocalMinute(at("2026-03-28T20:00:00Z"), 480, KYIV)).toBe(at("2026-03-29T05:00:00Z"));
  });
});
