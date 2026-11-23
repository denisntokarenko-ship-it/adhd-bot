// Шар даних рутин і планувальник (docs/spec/phase-4.md, S4.4, S4.6, 4.1.d) + охоронець промптів (4.3.g).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiClient, AiRequest } from "../../src/ai/client";
import { openDb } from "../../src/db/index";
import { answerSlot, getDraft, getRoutine, insertRoutineRoot, listLogs, listRoutines, logMissed, pauseRoutine, resumeRoutine, saveDraft, startDraft, takeTitleInput } from "../../src/db/routines";
import { planRoutines } from "../../src/routines/planner";
import { WEEKDAYS } from "../../src/routines/schedule";
import { runScheduled } from "../../src/scheduled";
import { baseEnv, deps, mockTelegram, seedRoutine, send, textUpdate } from "./helpers";

const DB = env.DB!;
const db = () => openDb(baseEnv());
const MIN = 60_000;
const T0 = Date.parse("2026-11-20T05:00:00Z"); // п'ятниця 07:00 Київ
const S8 = Date.parse("2026-11-20T06:00:00Z"); // 08:00 Київ
const S20 = Date.parse("2026-11-20T18:00:00Z"); // 20:00 Київ

const rows = async <R = Record<string, unknown>>(sql: string, ...args: unknown[]) => (await DB.prepare(sql).bind(...args).all<R>()).results;
const roots = () => rows<{ routine_id: number; slot_at: number; fire_at: number; max_attempts: number; status: string }>(
  "SELECT routine_id, slot_at, fire_at, max_attempts, status FROM reminders WHERE kind = 'routine' ORDER BY routine_id, slot_at, id",
);

async function user(tg: number): Promise<number> {
  return (await DB.prepare("INSERT INTO users (tg_id, created_at, last_seen_at) VALUES (?, ?, ?) RETURNING id").bind(tg, T0, T0).first<{ id: number }>())!.id;
}
const med = (u: number, over: Partial<Parameters<typeof seedRoutine>[2]> = {}, now = T0) =>
  seedRoutine(u, db(), { kind: "med", title: "Вітамін D", times: ["08:00", "20:00"], daysMask: 127, ...over }, now).then((id) => id!);

// Ланцюг слота: рядки з відправками (attempt 1..n), останній — зі статусом `last`.
async function chain(u: number, rid: number, slot: number, max: number, sentAts: number[], last = "sent"): Promise<number[]> {
  const ids: number[] = [];
  for (const [i, sentAt] of sentAts.entries()) {
    const status = i === sentAts.length - 1 ? last : "sent";
    const sent = status === "sent" || status === "answered";
    const row = await DB.prepare(
      `INSERT INTO reminders (user_id, kind, fire_at, attempt, max_attempts, status, parent_id, root_id, sent_at, sent_as, created_at, routine_id, slot_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(u, i === 0 ? "routine" : "repeat", sentAt, i + 1, max, status, ids.at(-1) ?? null, ids[0] ?? null, sent ? sentAt : null, sent ? "single" : null, slot, rid, slot)
      .first<{ id: number }>();
    ids.push(row!.id);
  }
  return ids;
}

beforeEach(async () => {
  for (const t of ["points_ledger", "routine_logs", "reminders", "routine_drafts", "routine_inputs", "routines", "ai_calls", "items", "capture_fixes", "captures", "users"])
    await DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => vi.restoreAllMocks());

describe("S4.4 корінь найближчого слота", () => {
  it("4.4.a: med 08:00/20:00, 07:00 Київ → один корінь 08:00 (4 спроби); habit — 1 спроба", async () => {
    const u = await user(111);
    const m = await med(u);
    const h = (await seedRoutine(u, db(), { kind: "habit", title: "Прогулянка", times: ["19:00"], daysMask: 127 }, T0))!;
    expect(await planRoutines(db(), T0)).toEqual({ missed: 0, roots: 2 });
    expect(await roots()).toEqual([
      { routine_id: m, slot_at: S8, fire_at: S8, max_attempts: 4, status: "pending" },
      { routine_id: h, slot_at: Date.parse("2026-11-20T17:00:00Z"), fire_at: Date.parse("2026-11-20T17:00:00Z"), max_attempts: 1, status: "pending" },
    ]);
    expect(await rows("SELECT item_id, attempt, parent_id, user_id FROM reminders WHERE routine_id = ?", m)).toEqual([{ item_id: null, attempt: 1, parent_id: null, user_id: u }]);
  });

  it("08:00 і 20:00 Пн–Пт: у суботу нічого — ні кореня суботи, ні неділі, тики цілу добу", async () => {
    const u = await user(111);
    const r = await med(u, { daysMask: WEEKDAYS });
    const satStart = Date.parse("2026-11-20T22:00:00Z"); // 00:00 суботи Київ
    for (let t = satStart; t < satStart + 24 * 60 * MIN; t += 30 * MIN) await planRoutines(db(), t);
    expect(await roots()).toEqual([{ routine_id: r, slot_at: Date.parse("2026-11-23T06:00:00Z"), fire_at: Date.parse("2026-11-23T06:00:00Z"), max_attempts: 4, status: "pending" }]);
  });

  it("4.4.c: два тики підряд і два одночасно → один корінь", async () => {
    const u = await user(111);
    await med(u);
    await planRoutines(db(), T0);
    await planRoutines(db(), T0 + MIN);
    await Promise.all([planRoutines(db(), T0 + 2 * MIN), planRoutines(db(), T0 + 2 * MIN)]);
    expect(await roots()).toHaveLength(1);
  });

  it("4.4.c: відповідь о 08:02 — другого кореня 08:00 немає, 20:00 з'являється лише після 08:05", async () => {
    const u = await user(111);
    const r = await med(u);
    await planRoutines(db(), T0);
    await DB.prepare("UPDATE reminders SET status = 'sent', sent_at = ?1, sent_as = 'single' WHERE routine_id = ?2").bind(S8, r).run();
    const [root] = await rows<{ id: number }>("SELECT id FROM reminders WHERE routine_id = ?", r);
    expect(await answerSlot(u, db(), root!.id, r, S8, "taken", S8 + 2 * MIN)).toBe(true);
    for (const t of [S8 + 2 * MIN, S8 + 5 * MIN]) await planRoutines(db(), t);
    expect((await roots()).map((x) => x.slot_at)).toEqual([S8]);
    await planRoutines(db(), S8 + 6 * MIN);
    expect((await roots()).map((x) => x.slot_at)).toEqual([S8, S20]);
  });

  it("4.5.k (БД): скасований корінь слота не дає нового кореня тих самих 08:00", async () => {
    const u = await user(111);
    const r = await med(u);
    await planRoutines(db(), T0);
    await DB.prepare("UPDATE reminders SET status = 'cancelled' WHERE routine_id = ?").bind(r).run(); // 403 на корені
    for (let t = S8 + MIN; t <= S8 + 5 * MIN; t += MIN) await planRoutines(db(), t);
    expect(await roots()).toEqual([{ routine_id: r, slot_at: S8, fire_at: S8, max_attempts: 4, status: "cancelled" }]);
    expect(await insertRoutineRoot(u, db(), r, S8, S8 + 2 * MIN)).toBe(false);
  });

  it("4.4.d: створено о 08:03 → корінь 08:00; о 08:06 → наступний слот", async () => {
    const u = await user(111);
    const a = await med(u, {}, S8 + 3 * MIN);
    await planRoutines(db(), S8 + 3 * MIN);
    await DB.prepare("DELETE FROM reminders").run();
    await DB.prepare("DELETE FROM routines").run();
    const b = await med(u, {}, S8 + 6 * MIN);
    await planRoutines(db(), S8 + 6 * MIN);
    expect(a).not.toBe(b);
    expect((await roots()).map((x) => [x.routine_id, x.slot_at])).toEqual([[b, S20]]);
  });

  it("4.4.d: …і корінь 08:03 — саме 08:00", async () => {
    const u = await user(111);
    const r = await med(u, {}, S8 + 3 * MIN);
    await planRoutines(db(), S8 + 3 * MIN);
    expect((await roots()).map((x) => [x.routine_id, x.slot_at, x.fire_at])).toEqual([[r, S8, S8]]);
  });

  it("4.4.e: на паузі — нових коренів немає; ▶️ — найближчий слот наступним тиком", async () => {
    const u = await user(111);
    const r = await med(u);
    expect(await pauseRoutine(u, db(), r, T0)).toBe(true);
    await planRoutines(db(), T0);
    expect(await roots()).toEqual([]);
    expect(await resumeRoutine(u, db(), r, T0 + MIN)).toBe(true);
    await planRoutines(db(), T0 + MIN);
    expect((await roots()).map((x) => x.slot_at)).toEqual([S8]);
  });

  it("cron: runScheduled планує корінь рутини в тому ж тику, що й огляди", async () => {
    mockTelegram();
    const u = await user(111);
    const r = await med(u);
    await runScheduled(baseEnv(), { now: () => T0 }, { ai: null, stt: null, rand: () => 0 });
    expect((await roots()).map((x) => [x.routine_id, x.slot_at])).toEqual([[r, S8]]);
    expect(await rows("SELECT COUNT(*) AS n FROM reminders WHERE kind LIKE 'digest_%'")).toEqual([{ n: 3 }]);
  });
});

describe("одна відповідь на слот (UNIQUE, не if): answerSlot і logMissed — прод-шляхи", () => {
  it("двічі «taken» → один рядок; другий виклик нічого не змінює", async () => {
    const u = await user(111);
    const r = await med(u);
    expect(await answerSlot(u, db(), 0, r, S8, "taken", S8 + MIN)).toBe(true);
    expect(await answerSlot(u, db(), 0, r, S8, "taken", S8 + 2 * MIN)).toBe(false);
    expect(await rows("SELECT status, answered_at FROM routine_logs")).toEqual([{ status: "taken", answered_at: S8 + MIN }]);
  });

  it("4.6.b: missed → taken (answered_at = now) один раз; taken/skipped — назавжди; missed поверх відповіді — ні", async () => {
    const u = await user(111);
    const r = await med(u);
    const id = await logMissed(u, db(), r, S8, S8 + 60 * MIN);
    expect(id).toBeGreaterThan(0);
    expect(await rows("SELECT status, answered_at FROM routine_logs")).toEqual([{ status: "missed", answered_at: null }]);
    expect(await logMissed(u, db(), r, S8, S8 + 61 * MIN)).toBeNull();
    expect(await answerSlot(u, db(), 0, r, S8, "taken", S8 + 90 * MIN)).toBe(true);
    expect(await answerSlot(u, db(), 0, r, S8, "skipped", S8 + 91 * MIN)).toBe(false);
    expect(await logMissed(u, db(), r, S8, S8 + 92 * MIN)).toBeNull();
    expect(await rows("SELECT id, status, answered_at FROM routine_logs")).toEqual([{ id, status: "taken", answered_at: S8 + 90 * MIN }]);

    expect(await answerSlot(u, db(), 0, r, S20, "skipped", S20 + MIN)).toBe(true);
    expect(await answerSlot(u, db(), 0, r, S20, "taken", S20 + 2 * MIN)).toBe(false);
    expect((await listLogs(u, db(), S8, S20 + 1)).map((l) => l.status)).toEqual(["taken", "skipped"]);
  });
});

describe("4.1.d НФ-3: чужий routine_id нічого не читає й не змінює", () => {
  it("get / list / чернетка зміни / save / pause / resume / answer / missed / root", async () => {
    const me = await user(111);
    const other = await user(222);
    const theirs = await med(other);
    await planRoutines(db(), T0);
    const before = await rows("SELECT * FROM routines");
    const remBefore = await rows("SELECT * FROM reminders ORDER BY id");

    expect(await getRoutine(me, db(), theirs)).toBeNull();
    expect(await listRoutines(me, db())).toEqual([]);
    for (const step of ["title", "confirm"] as const)
      expect(await startDraft(me, db(), { routineId: theirs, step, kind: "med", title: "Чуже", times: ["09:00"], daysMask: 1 }, T0 + MIN)).toBe(false);
    expect(await getDraft(me, db())).toBeNull();
    expect(await takeTitleInput(me, db(), 9001, "Чуже", T0 + MIN)).toBe(true); // забрано як дані, але без чернетки — нічого
    expect(await saveDraft(me, db(), T0 + MIN)).toEqual({ kind: "none" });
    expect(await pauseRoutine(me, db(), theirs, T0 + MIN)).toBe(false);
    expect(await resumeRoutine(me, db(), theirs, T0 + MIN)).toBe(false);
    expect(await answerSlot(me, db(), 0, theirs, S8, "taken", T0 + MIN)).toBe(false);
    expect(await logMissed(me, db(), theirs, S8, T0 + MIN)).toBeNull();
    expect(await insertRoutineRoot(me, db(), theirs, S20, T0 + MIN)).toBe(false);
    expect(await listLogs(me, db(), 0, Number.MAX_SAFE_INTEGER)).toEqual([]);

    expect(await rows("SELECT * FROM routines")).toEqual(before);
    expect(await rows("SELECT * FROM reminders ORDER BY id")).toEqual(remBefore);
    expect(await rows("SELECT * FROM routine_logs")).toEqual([]);
    expect(await rows("SELECT COUNT(*) AS n FROM points_ledger")).toEqual([{ n: 0 }]);
  });
});

// Створення й зміна — лише прод-шляхом чернетки (рев'ю R-4, В3): `saveDraft`, `takeTitleInput`.
describe("створення, зміна, пауза", () => {
  it("escalate за замовчуванням — лише med (saveDraft); назва-сміття → RangeError у takeTitleInput, нічого не змінено", async () => {
    const u = await user(111);
    const m = await med(u);
    const h = (await seedRoutine(u, db(), { kind: "habit", title: "Йога", times: ["07:00"], daysMask: 1 }, T0))!;
    expect(await getRoutine(u, db(), m)).toMatchObject({ kind: "med", escalate: true, active: true, times: ["08:00", "20:00"], days_mask: 127 });
    expect(await getRoutine(u, db(), h)).toMatchObject({ kind: "habit", escalate: false });
    await startDraft(u, db(), { routineId: null, step: "title", kind: "med", title: null, times: [], daysMask: null }, T0);
    await expect(takeTitleInput(u, db(), 9001, "a\nb", T0 + MIN)).rejects.toThrow(RangeError);
    await expect(takeTitleInput(u, db(), 9002, "х".repeat(65), T0 + MIN)).rejects.toThrow(RangeError);
    expect(await getDraft(u, db())).toMatchObject({ step: "title", title: null });
    expect(await rows("SELECT COUNT(*) AS n FROM routine_inputs")).toEqual([{ n: 0 }]);
    expect(await listRoutines(u, db())).toHaveLength(2);
  });

  it("ROUTINES_MAX (saveDraft): 20 рутин з паузою включно, 21-ша «Зберегти» → limit, рутини немає, чернетку прибрано", async () => {
    const u = await user(111);
    for (let i = 0; i < 20; i++) expect(await med(u, { title: `Р${i}` })).toBeGreaterThan(0);
    await pauseRoutine(u, db(), (await listRoutines(u, db()))[0]!.id, T0);
    await startDraft(u, db(), { routineId: null, step: "confirm", kind: "habit", title: "Зайва", times: ["09:00"], daysMask: 1 }, T0);
    expect(await saveDraft(u, db(), T0)).toEqual({ kind: "limit" });
    expect(await listRoutines(u, db())).toHaveLength(20);
    expect(await getDraft(u, db())).toBeNull();
  });

  it("4.7.b–c: назва (takeTitleInput) — корінь лишається; час (saveDraft) — невідправлений корінь DELETE, ланцюг, що йде, не чіпається", async () => {
    const u = await user(111);
    const r = await med(u);
    const [sentRoot, pendingRepeat] = await chain(u, r, S8 - 24 * 60 * MIN, 4, [S8 - 24 * 60 * MIN, S8 - 24 * 60 * MIN + 5 * MIN], "pending");
    await planRoutines(db(), T0);
    const edit = { routineId: r, kind: "med", title: "Вітамін D", daysMask: 127 } as const;
    expect(await startDraft(u, db(), { ...edit, step: "title", times: ["08:00", "20:00"] }, T0 + MIN)).toBe(true);
    expect(await takeTitleInput(u, db(), 9001, "Вітамін D3", T0 + MIN)).toBe(true);
    expect(await getDraft(u, db())).toBeNull(); // ✏️ Назва закриває чернетку одразу
    expect((await roots()).filter((x) => x.status === "pending").map((x) => x.slot_at)).toEqual([S8]);

    expect(await startDraft(u, db(), { ...edit, step: "confirm", times: ["09:00"] }, T0 + 2 * MIN)).toBe(true);
    expect(await saveDraft(u, db(), T0 + 2 * MIN)).toEqual({ kind: "updated", id: r });
    expect(await getRoutine(u, db(), r)).toMatchObject({ title: "Вітамін D3", times: ["09:00"], updated_at: T0 + 2 * MIN });
    expect(await rows<{ id: number; status: string }>("SELECT id, status FROM reminders ORDER BY id")).toEqual([
      { id: sentRoot, status: "sent" },
      { id: pendingRepeat, status: "pending" },
    ]);
    await planRoutines(db(), T0 + 3 * MIN);
    expect((await roots()).filter((x) => x.status === "pending").map((x) => x.slot_at)).toEqual([Date.parse("2026-11-20T07:00:00Z")]);
  });

  it("4.7.d: ⏸ — невідправлений корінь DELETE, pending-повтор → cancelled", async () => {
    const u = await user(111);
    const r = await med(u);
    const [, rep] = await chain(u, r, S8 - 24 * 60 * MIN, 4, [S8 - 24 * 60 * MIN, S8 - 24 * 60 * MIN + 5 * MIN], "pending");
    await planRoutines(db(), T0);
    expect(await pauseRoutine(u, db(), r, T0 + MIN)).toBe(true);
    expect(await getRoutine(u, db(), r)).toMatchObject({ active: false });
    expect(await rows("SELECT id, status FROM reminders WHERE status <> 'sent' ORDER BY id")).toEqual([{ id: rep, status: "cancelled" }]);
  });
});

describe("S4.6 без відповіді — missed, мовчки", () => {
  it("4.6.a/e: med — 4 відправки, через 30 хв після останньої missed; раніше — ні; двічі — один рядок; reminders без змін", async () => {
    const u = await user(111);
    const r = await med(u);
    const sends = [S8, S8 + 5 * MIN, S8 + 20 * MIN, S8 + 50 * MIN];
    await chain(u, r, S8, 4, sends);
    const last = sends.at(-1)!;
    const rem = await rows("SELECT * FROM reminders ORDER BY id");
    expect((await planRoutines(db(), last + 29 * MIN)).missed).toBe(0);
    expect((await planRoutines(db(), last + 30 * MIN)).missed).toBe(1);
    expect((await planRoutines(db(), last + 31 * MIN)).missed).toBe(0);
    expect(await rows("SELECT routine_id, scheduled_for, status, answered_at FROM routine_logs")).toEqual([{ routine_id: r, scheduled_for: S8, status: "missed", answered_at: null }]);
    expect(await rows("SELECT * FROM reminders WHERE routine_id = ? AND slot_at = ? ORDER BY id", r, S8)).toEqual(rem);
    expect(await rows("SELECT COUNT(*) AS n FROM points_ledger")).toEqual([{ n: 0 }]);
  });

  it("4.6.a: habit — 1 відправка + 30 хв → missed", async () => {
    const u = await user(111);
    const h = (await seedRoutine(u, db(), { kind: "habit", title: "Прогулянка", times: ["08:00"], daysMask: 127 }, T0))!;
    await chain(u, h, S8, 1, [S8]);
    await planRoutines(db(), S8 + 30 * MIN);
    expect(await rows("SELECT status FROM routine_logs")).toEqual([{ status: "missed" }]);
  });

  it("4.6.c/d: обірваний ланцюг (1 з 4, повтор cancelled), pending ще є, відповідь уже є — missed немає", async () => {
    const u = await user(111);
    const a = await med(u, { title: "A" });
    const b = await med(u, { title: "B" });
    const c = await med(u, { title: "C" });
    await chain(u, a, S8, 4, [S8, S8 + 5 * MIN], "cancelled"); // ⏸ о 08:10 — повтор скасовано
    await chain(u, b, S8, 4, [S8, S8 + 5 * MIN, S8 + 20 * MIN, S8 + 50 * MIN], "pending"); // остання ще не пішла
    const cChain = await chain(u, c, S8, 4, [S8, S8 + 5 * MIN, S8 + 20 * MIN, S8 + 50 * MIN]);
    expect(await answerSlot(u, db(), cChain[3]!, c, S8, "skipped", S8 + 60 * MIN)).toBe(true);
    await planRoutines(db(), S8 + 5 * 60 * MIN);
    expect(await rows("SELECT routine_id, status FROM routine_logs ORDER BY routine_id")).toEqual([{ routine_id: c, status: "skipped" }]);
  });

  it("4.6.d: «+15 хв» після вичерпаного ланцюга — останній за sent_at уже не вичерпний, missed лише після нового ланцюга", async () => {
    const u = await user(111);
    const r = await med(u);
    await chain(u, r, S8, 4, [S8, S8 + 5 * MIN, S8 + 20 * MIN, S8 + 50 * MIN], "answered"); // «+15 хв» на 4-й
    await chain(u, r, S8, 4, [S8 + 65 * MIN]); // новий корінь того ж слота, 1 з 4
    await planRoutines(db(), S8 + 5 * 60 * MIN);
    expect(await rows("SELECT COUNT(*) AS n FROM routine_logs")).toEqual([{ n: 0 }]);
  });
});

// ── 4.3.g: охоронець промптів — мок Claude фіксує витік назви чи часу засіяної рутини ───────────────────────

const SECRET_TITLE = "Магне B6 таємне";
const SECRET_TIME = "07:13";
const FRI = Date.parse("2026-11-20T13:00:00Z"); // 15:00 п'ятниці Київ — now_local не містить 07:13

function guardedAi(forbidden: string[]) {
  const leaks: string[] = [];
  const requests: AiRequest[] = [];
  let down = false;
  const client: AiClient = {
    async complete(req) {
      requests.push(req);
      for (const f of forbidden) if (req.system.includes(f) || req.user.includes(f)) leaks.push(f);
      if (leaks.length > 0) throw new Error("routine data leaked into AI prompt");
      if (down) throw new Error("down");
      const items = [{ kind: "task", title: "Корм коту", body: null, due_local: null, all_day: false, priority: "normal", date_unclear: false }];
      return { text: JSON.stringify({ items }), stopReason: "end_turn", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
  };
  return { client, leaks, requests, setDown: (v: boolean) => void (down = v) };
}

const callback = (data: string, updateId: number) => ({
  update_id: updateId,
  callback_query: { id: `cb${updateId}`, chat_instance: "x", from: { id: 111, is_bot: false, first_name: "T" }, data, message: { message_id: 1, date: 0, chat: { id: 111, type: "private" } } },
});

describe("4.3.g охоронець промптів", () => {
  it("захоплення, повтор pending і «Не так» — 0 витоків назви й часу активної рутини", async () => {
    mockTelegram();
    const u = await user(111);
    await seedRoutine(u, db(), { kind: "med", title: SECRET_TITLE, times: [SECRET_TIME, "21:40"], daysMask: 127 }, FRI);
    const ai = guardedAi([SECRET_TITLE, SECRET_TIME]);

    await send(textUpdate("купити корм коту"), baseEnv(), deps({ now: FRI, ai: ai.client }));
    ai.setDown(true);
    await send(textUpdate("завтра лікар"), baseEnv(), deps({ now: FRI + MIN, ai: ai.client }));
    expect(await rows("SELECT status FROM captures ORDER BY id")).toEqual([{ status: "parsed" }, { status: "pending" }]);
    ai.setDown(false);
    await runScheduled(baseEnv(), { now: () => FRI + 6 * MIN }, { ai: ai.client, stt: null, rand: () => 0 });
    expect(await rows("SELECT status FROM captures ORDER BY id")).toEqual([{ status: "parsed" }, { status: "parsed" }]);

    const capId = (await rows<{ id: number }>("SELECT id FROM captures ORDER BY id LIMIT 1"))[0]!.id;
    await send(callback(`fix:${capId}`, 9001), baseEnv(), deps({ now: FRI + 7 * MIN, ai: ai.client }));
    await send(textUpdate("ні, корм собаці"), baseEnv(), deps({ now: FRI + 8 * MIN, ai: ai.client }));
    expect(await rows("SELECT COUNT(*) AS n FROM capture_fixes")).toEqual([{ n: 1 }]);

    expect(ai.requests.length).toBeGreaterThanOrEqual(4); // захоплення, невдала спроба, повтор, виправлення — промпти справді будувались
    expect(ai.leaks).toEqual([]);
  });

  it("охоронець не сліпий: текст людини з назвою (4.3.h — звичайний запис) він бачить", async () => {
    mockTelegram();
    const u = await user(111);
    await seedRoutine(u, db(), { kind: "med", title: SECRET_TITLE, times: [SECRET_TIME], daysMask: 127 }, FRI);
    const ai = guardedAi([SECRET_TITLE]);
    await send(textUpdate(`купити ${SECRET_TITLE}`), baseEnv(), deps({ now: FRI, ai: ai.client }));
    expect(ai.leaks).toEqual([SECRET_TITLE]);
  });

  it("routines немає в items_fts: жоден тригер чи віртуальна таблиця FTS не читає рутин", async () => {
    const fts = await rows<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE sql LIKE '%items_fts%'");
    expect(fts.length).toBeGreaterThan(0);
    expect(fts.filter((o) => /routine/i.test(o.sql)).map((o) => o.name)).toEqual([]);
    expect(await rows("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('routines','routine_logs','routine_drafts')")).toEqual([]);
  });
});
