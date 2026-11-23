// Крок 4.2: майстер /routines, межа з ШІ, нагадування рутин і кнопки, missed, огляди (docs/spec/phase-4.md, S4.2–S4.9).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiClient } from "../../src/ai/client";
import type { Stt } from "../../src/ai/stt";
import { openDb } from "../../src/db/index";
import { createRoutine } from "../../src/db/routines";
import { applySetting } from "../../src/db/settings";
import { ensureUser } from "../../src/db/users";
import { morningRoutines, eveningRoutines } from "../../src/routines/digest";
import { planRoutines } from "../../src/routines/planner";
import { runScheduled } from "../../src/scheduled";
import { ACK_SKIP_POOL, ACK_TAKEN_POOL, RW_ALREADY_SAVED, RW_DEAD, RW_LIMIT, RW_TITLE_BAD, RW_TITLE_TEXT_ONLY } from "../../src/texts";
import { baseEnv, deps, forwardText, mockTelegram, send, textUpdate, voiceUpdate, type TgCall } from "./helpers";

const DB = env.DB!;
const db = () => openDb(baseEnv());
const MIN = 60_000;
const T0 = Date.parse("2026-11-20T05:00:00Z"); // п'ятниця 07:00 Київ
const S8 = Date.parse("2026-11-20T06:00:00Z"); // 08:00 Київ

const rows = async <R = Record<string, unknown>>(sql: string, ...args: unknown[]) => (await DB.prepare(sql).bind(...args).all<R>()).results;
const count = async (table: string) => (await DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const textOf = (c: TgCall) => String(c.body.text);
const kbOf = (c: TgCall) => (c.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;

// Мок Claude і Whisper, що рахують виклики: шлях рутини не має кликати жоден (4.2.i). Виклик Claude кидає —
// розбір його ковтає (запасна нотатка), тож доказ — лічильник, а не падіння.
function spies() {
  const calls = { ai: 0, stt: 0 };
  const ai: AiClient = {
    async complete() {
      calls.ai += 1;
      throw new Error("Claude must not be called in the routine path");
    },
  };
  const stt: Stt = {
    async transcribe() {
      calls.stt += 1;
      throw new Error("Whisper must not be called in the routine path");
    },
  };
  return { calls, ai, stt };
}

// Звичайний розбір (для «Не так» і захоплення поза майстром).
function parsingAi() {
  const calls = { n: 0 };
  const ai: AiClient = {
    async complete() {
      calls.n += 1;
      const items = [{ kind: "task", title: "Корм коту", body: null, due_local: null, all_day: false, priority: "normal", date_unclear: false }];
      return { text: JSON.stringify({ items }), stopReason: "end_turn", inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
  };
  return { calls, ai };
}

let cbId = 50_000;
const callback = (data: string, from = 111) => ({
  update_id: ++cbId,
  callback_query: {
    id: `cb${cbId}`,
    chat_instance: "x",
    from: { id: from, is_bot: false, first_name: "T" },
    data,
    message: { message_id: 1, date: 0, chat: { id: from, type: "private" } },
  },
});

const sp = { current: spies() };
const at = (now: number, ai: AiClient = sp.current.ai, stt: Stt = sp.current.stt) => deps({ now, ai, stt });
const press = (data: string, now = T0, ai?: AiClient) => send(callback(data), baseEnv(), at(now, ai));
const say = (update: unknown, now = T0, ai?: AiClient) => send(update, baseEnv(), at(now, ai));
// Пуші рутин (з кнопками `rt:`), без оглядів, що теж ідуть у ці тики (тепла фраза ранку тощо).
const pushes = (tg: ReturnType<typeof mockTelegram>) => tg.sent().filter((c) => JSON.stringify(c.body.reply_markup ?? "").includes('"rt:'));
const toast = (tg: ReturnType<typeof mockTelegram>) => tg.calls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text;
const tick = (now: number) => runScheduled(baseEnv(), { now: () => now }, { ai: null, stt: null, rand: () => 0 });

const user = async (tg = 111) => (await ensureUser(tg, db(), T0)).id;
const draft = async () => (await rows<Record<string, unknown>>("SELECT * FROM routine_drafts"))[0];
const routineRows = () => rows<Record<string, unknown>>("SELECT kind, title, times, days_mask, escalate, active FROM routines ORDER BY id");
const remRows = () =>
  rows<{ id: number; kind: string; fire_at: number; attempt: number; max_attempts: number; status: string; slot_at: number; sent_at: number | null; tg_message_id: number | null }>(
    "SELECT id, kind, fire_at, attempt, max_attempts, status, slot_at, sent_at, tg_message_id FROM reminders WHERE routine_id IS NOT NULL ORDER BY id",
  );
const logs = () => rows<{ status: string; answered_at: number | null; scheduled_for: number }>("SELECT status, answered_at, scheduled_for FROM routine_logs ORDER BY id");
const med = async (u: number, over: Partial<Parameters<typeof createRoutine>[2]> = {}) =>
  (await createRoutine(u, db(), { kind: "med", title: "Вітамін D", times: ["08:00"], daysMask: 127, ...over }, T0 - 60 * MIN))!;

beforeEach(async () => {
  for (const t of ["points_ledger", "routine_logs", "reminders", "routine_drafts", "routine_inputs", "routines", "ai_calls", "items", "capture_fixes", "captures", "users"])
    await DB.prepare(`DELETE FROM ${t}`).run();
  sp.current = spies();
});
afterEach(() => vi.restoreAllMocks());

// Майстер до кроку `title` (➕ 💊 Ліки).
async function toTitle(now = T0) {
  await say(textUpdate("/routines"), now);
  await press("rw:new:med", now);
}

describe("S4.2 нова рутина кнопками", () => {
  it("4.2.a–f, 4.2.i: /routines → 💊 → назва → 08:00, 20:00 → дні → Зберегти; Claude і Whisper не викликані", async () => {
    const tg = mockTelegram();
    await say(textUpdate("/routines"));
    expect(kbOf(tg.sent().at(-1)!).flat().map((b) => b.callback_data)).toEqual(["rw:new:med", "rw:new:habit"]);
    await press("rw:new:med");
    expect(await draft()).toMatchObject({ kind: "med", step: "title", routine_id: null, expires_at: T0 + 15 * MIN });
    await say(textUpdate("  Вітамін D  "), T0 + MIN);
    expect(await draft()).toMatchObject({ title: "Вітамін D", step: "times", times: "[]", expires_at: T0 + 16 * MIN });
    expect(kbOf(tg.sent().at(-1)!).slice(0, 4).map((r) => r.length)).toEqual([6, 6, 6, 6]); // сітка годин 6×4
    for (const b of ["rw:h:20", "rw:m:2000", "rw:more", "rw:h:08", "rw:m:0800", "rw:more", "rw:h:08", "rw:m:0800"]) await press(b, T0 + 2 * MIN);
    expect(await draft()).toMatchObject({ times: '["08:00","20:00"]', step: "times" }); // сортування, повтор ігнорується
    await press("rw:next", T0 + 2 * MIN);
    expect(await draft()).toMatchObject({ step: "days", days_mask: 127 });
    await press("rw:d:6", T0 + 2 * MIN); // Нд вимкнено
    expect(await draft()).toMatchObject({ days_mask: 63 });
    await press("rw:dall", T0 + 2 * MIN);
    await press("rw:next", T0 + 2 * MIN);
    const summary = tg.calls.filter((c) => c.method === "editMessageText").at(-1)!;
    expect(textOf(summary)).toBe("💊 Вітамін D · 08:00, 20:00 · щодня");
    await press("rw:save", T0 + 3 * MIN);
    expect(await routineRows()).toEqual([{ kind: "med", title: "Вітамін D", times: '["08:00","20:00"]', days_mask: 127, escalate: 1, active: 1 }]);
    expect(await draft()).toBeUndefined();
    await press("rw:save", T0 + 3 * MIN); // 4.2.f: подвійний тап
    expect(toast(tg)).toBe(RW_ALREADY_SAVED);
    expect(await count("routines")).toBe(1);
    expect(sp.current.calls).toEqual({ ai: 0, stt: 0 });
    expect([await count("captures"), await count("ai_calls"), await count("items"), await count("routine_inputs")]).toEqual([0, 0, 0, 1]);
  });

  it("4.2.d: 0 днів → тост «хоч один день», крок не змінюється; 4.2.e — час у тихих годинах → дописка", async () => {
    const tg = mockTelegram();
    const u = await user();
    await DB.prepare("UPDATE users SET quiet_from = 1380, quiet_to = 480 WHERE id = ?").bind(u).run();
    await toTitle();
    await say(textUpdate("Магній"));
    for (const b of ["rw:h:23", "rw:m:2330", "rw:next", "rw:dwk"]) await press(b);
    for (const i of [0, 1, 2, 3, 4]) await press(`rw:d:${i}`);
    await press("rw:next");
    expect(toast(tg)).toBe("хоч один день");
    expect(await draft()).toMatchObject({ step: "days", days_mask: 0 });
    await press("rw:d:5");
    await press("rw:next");
    expect(textOf(tg.calls.filter((c) => c.method === "editMessageText").at(-1)!)).toBe("💊 Магній · 23:30 · Сб\nнагадаю й у тихі години: це ти обрав сам");
  });

  it("4.2.g: ✖ → чернетку видалено; кнопка мертвої чернетки → «майстер закрився», без змін", async () => {
    const tg = mockTelegram();
    await toTitle();
    await press("rw:x");
    expect(await draft()).toBeUndefined();
    expect(textOf(tg.calls.filter((c) => c.method === "editMessageText").at(-1)!)).toBe("скасував, нічого не зберіг");
    await press("rw:h:08");
    expect(toast(tg)).toBe(RW_DEAD);
    await press("rw:new:habit");
    await press("rw:next", T0 + 16 * MIN); // TTL минув
    expect(toast(tg)).toBe(RW_DEAD);
    expect(await count("routines")).toBe(0);
  });

  it("4.2.h: 20 рутин → ➕ дає тост про ліміт, чернетка не створюється", async () => {
    const tg = mockTelegram();
    const u = await user();
    for (let i = 0; i < 20; i++) await med(u, { title: `р${i}` });
    await press("rw:new:med");
    expect(toast(tg)).toBe(RW_LIMIT);
    expect(await draft()).toBeUndefined();
  });
});

describe("S4.3 межа з ШІ: назва — не запис", () => {
  it("4.3.a майстер не викликає Claude: текст на кроці title → назва, routine_inputs, без captures", async () => {
    mockTelegram();
    await toTitle();
    await say(textUpdate("Магне B6 два рази"), T0 + MIN);
    expect(sp.current.calls.ai).toBe(0);
    expect(await draft()).toMatchObject({ title: "Магне B6 два рази", step: "times" });
    expect([await count("captures"), await count("capture_fixes"), await count("items"), await count("ai_calls"), await count("points_ledger")]).toEqual([0, 0, 0, 0, 0]);
    expect(await count("routine_inputs")).toBe(1);
  });

  it("4.2.b: 65 символів чи перенос рядка → «трохи коротше», крок той самий, але update забрано", async () => {
    const tg = mockTelegram();
    await toTitle();
    await say(textUpdate("я".repeat(65)));
    expect(textOf(tg.sent().at(-1)!)).toBe(RW_TITLE_BAD);
    await say(textUpdate("Вітамін\nD"));
    expect(await draft()).toMatchObject({ step: "title", title: null });
    expect(await count("routine_inputs")).toBe(2);
    expect([sp.current.calls.ai, await count("captures")]).toEqual([0, 0]);
  });

  it("4.3.e: голосове чи пересилання на кроці title → routine_inputs, не у Whisper і не захоплення; чернетка жива", async () => {
    const tg = mockTelegram();
    await toTitle();
    await say(voiceUpdate(5));
    await say(forwardText("Вітамін D двічі на день"));
    expect(tg.sent().slice(-2).map(textOf)).toEqual([RW_TITLE_TEXT_ONLY, RW_TITLE_TEXT_ONLY]);
    expect(sp.current.calls).toEqual({ ai: 0, stt: 0 });
    expect([await count("routine_inputs"), await count("captures")]).toEqual([2, 0]);
    expect(await draft()).toMatchObject({ step: "title" });
  });

  it("4.3.b: повтор доставки (назва після Зберегти, відхилена й голосове після ✖) → 0 captures, мок не викликано, 200", async () => {
    mockTelegram();
    await toTitle();
    const name = textUpdate("Вітамін D");
    await say(name);
    for (const b of ["rw:h:08", "rw:m:0800", "rw:next", "rw:next", "rw:save"]) await press(b);
    expect((await say(name, T0 + 2 * MIN)).status).toBe(200);
    expect((await routineRows())[0]).toMatchObject({ title: "Вітамін D" });

    await press("rw:new:habit");
    const long = textUpdate("я".repeat(70));
    const voice = voiceUpdate(5);
    await say(long);
    await say(voice);
    await press("rw:x");
    expect((await say(long, T0 + 3 * MIN)).status).toBe(200);
    expect((await say(voice, T0 + 3 * MIN)).status).toBe(200);
    expect(sp.current.calls).toEqual({ ai: 0, stt: 0 });
    expect([await count("captures"), await count("capture_fixes"), await count("routine_inputs")]).toEqual([0, 0, 3]);
  });

  it("4.3.c: на кроці times текст — звичайне захоплення, чернетка жива", async () => {
    mockTelegram();
    await toTitle();
    await say(textUpdate("Вітамін D"));
    const p = parsingAi();
    await say(textUpdate("купити корм коту"), T0 + MIN, p.ai);
    expect(p.calls.n).toBe(1);
    expect(await count("captures")).toBe(1);
    expect(await draft()).toMatchObject({ step: "times" });
  });

  it("4.3.d: о expires_at − 1 с текст — назва; о expires_at + 1 с — захоплення", async () => {
    mockTelegram();
    await toTitle();
    await say(textUpdate("Вітамін D"), T0 + 15 * MIN - 1000);
    expect(await draft()).toMatchObject({ title: "Вітамін D" });
    await press("rw:x", T0 + 15 * MIN);
    await toTitle(T0 + 20 * MIN);
    const p = parsingAi();
    await say(textUpdate("Вітамін D"), T0 + 35 * MIN + 1000, p.ai);
    expect(p.calls.n).toBe(1);
    expect(await count("captures")).toBe(1);
  });

  it("4.3.f: «Не так» і майстер — виграє останній намір (обидва порядки)", async () => {
    mockTelegram();
    const p = parsingAi();
    await say(textUpdate("купити корм коту"), T0, p.ai);
    const capId = (await rows<{ id: number }>("SELECT id FROM captures"))[0]!.id;

    // майстер ➕ після «Не так» → вікно «Не так» скинуто, текст — назва
    await press(`fix:${capId}`, T0 + MIN, p.ai);
    await toTitle(T0 + 2 * MIN);
    expect((await rows<{ f: number | null }>("SELECT fix_requested_at AS f FROM captures"))[0]!.f).toBeNull();
    await say(textUpdate("Вітамін D"), T0 + 3 * MIN, p.ai);
    expect(p.calls.n).toBe(1);
    expect(await draft()).toMatchObject({ title: "Вітамін D" });

    // «Не так» після майстра → чернетку видалено, текст — виправлення
    await press("rw:x", T0 + 4 * MIN);
    await toTitle(T0 + 5 * MIN);
    await press(`fix:${capId}`, T0 + 6 * MIN, p.ai);
    expect(await draft()).toBeUndefined();
    await say(textUpdate("корм собаці"), T0 + 7 * MIN, p.ai);
    expect(p.calls.n).toBe(2);
    expect(await count("capture_fixes")).toBe(1);
  });
});

describe("S4.5–S4.6 нагадування рутин, кнопки, missed", () => {
  it("4.5.a, 4.6.a: med без відповіді → рівно 4 спроби (5→15→30 від sent_at) → через 30 хв missed, мовчки", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    await med(u);
    for (const t of [S8, S8 + MIN, S8 + 5 * MIN, S8 + 20 * MIN, S8 + 50 * MIN, S8 + 79 * MIN]) await tick(t);
    expect(pushes(tg)).toHaveLength(4);
    expect((await remRows()).filter((r) => r.slot_at === S8).map((r) => [r.kind, r.attempt, r.status, (r.sent_at! - S8) / MIN])).toEqual([
      ["routine", 1, "sent", 0],
      ["repeat", 2, "sent", 5],
      ["repeat", 3, "sent", 20],
      ["repeat", 4, "sent", 50],
    ]);
    expect(await logs()).toEqual([]);
    await tick(S8 + 80 * MIN);
    expect(await logs()).toEqual([{ status: "missed", answered_at: null, scheduled_for: S8 }]);
    await tick(S8 + 120 * MIN);
    expect(pushes(tg)).toHaveLength(4); // жодного повідомлення про missed
    expect(await count("points_ledger")).toBe(0);
    expect(textOf(pushes(tg)[0]!)).toContain("Вітамін D");
    expect(kbOf(pushes(tg)[0]!)[0]!.map((b) => b.text)).toEqual(["✅ прийняв", "пропущу", "+15 хв"]);
  });

  it("4.5.a від sent_at: корінь пішов о 08:02 (тик запізнився) → повтор о 08:07, а не о 08:05", async () => {
    mockTelegram({ seqIds: true });
    const u = await user();
    await med(u);
    await planRoutines(db(), S8 - MIN);
    await tick(S8 + 2 * MIN);
    const rep = (await remRows()).find((r) => r.kind === "repeat")!;
    expect([(rep.fire_at - S8) / MIN, rep.attempt]).toEqual([7, 2]);
  });

  it("4.5.a, 4.6.a: habit — одна відправка, без нащадка; +30 хв → missed", async () => {
    const tg = mockTelegram();
    const u = await user();
    await createRoutine(u, db(), { kind: "habit", title: "Прогулянка", times: ["08:00"], daysMask: 127 }, T0);
    for (const t of [S8, S8 + 5 * MIN, S8 + 29 * MIN]) await tick(t);
    expect(pushes(tg)).toHaveLength(1);
    expect(kbOf(pushes(tg)[0]!)[0]![0]!.text).toBe("✅ зробив");
    await tick(S8 + 30 * MIN);
    expect((await logs()).map((l) => l.status)).toEqual(["missed"]);
  });

  it("4.5.d: «пропущу» → skipped, повтори скасовано, 0 очок; далі ні пушів, ні missed", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    await med(u);
    await tick(S8);
    const root = (await remRows())[0]!;
    await press(`rt:${root.id}:skip`, S8 + 2 * MIN);
    expect(ACK_SKIP_POOL).toContain(toast(tg));
    expect(await logs()).toEqual([{ status: "skipped", answered_at: S8 + 2 * MIN, scheduled_for: S8 }]);
    expect((await remRows()).map((r) => [r.kind, r.status])).toEqual([
      ["routine", "answered"],
      ["repeat", "cancelled"],
    ]);
    for (const t of [S8 + 5 * MIN, S8 + 20 * MIN, S8 + 90 * MIN]) await tick(t);
    expect(pushes(tg)).toHaveLength(1);
    expect(await count("points_ledger")).toBe(0);
    expect((await logs()).map((l) => l.status)).toEqual(["skipped"]);
  });

  it("4.5.b–c, 4.5.f: «✅» → taken +10 з routine_log_id; подвійний тап і ✅ з другого повідомлення → один рядок, одне +10", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    await med(u);
    await tick(S8);
    await tick(S8 + 5 * MIN);
    const [root, rep] = await remRows();
    await press(`rt:${rep!.id}:ok`, S8 + 6 * MIN);
    expect(ACK_TAKEN_POOL).toContain(toast(tg));
    await press(`rt:${rep!.id}:ok`, S8 + 6 * MIN);
    expect(toast(tg)).toBe("уже записав");
    await press(`rt:${root!.id}:ok`, S8 + 7 * MIN);
    expect(toast(tg)).toBe("уже записав");
    await press(`rt:${root!.id}:s15`, S8 + 7 * MIN);
    expect(toast(tg)).toBe("уже записав");
    expect(await logs()).toEqual([{ status: "taken", answered_at: S8 + 6 * MIN, scheduled_for: S8 }]);
    const ledger = await rows<{ delta: number; reason: string; routine_log_id: number; item_id: number | null }>("SELECT delta, reason, routine_log_id, item_id FROM points_ledger");
    expect(ledger).toEqual([{ delta: 10, reason: "done", routine_log_id: expect.any(Number), item_id: null }]);
    expect((await remRows()).map((r) => r.status)).toEqual(["sent", "answered", "cancelled"]);
  });

  it("4.6.b: пізнє «✅» на старому повідомленні після missed → taken, +10 один раз", async () => {
    mockTelegram({ seqIds: true });
    const u = await user();
    await createRoutine(u, db(), { kind: "habit", title: "Прогулянка", times: ["08:00"], daysMask: 127 }, T0);
    await tick(S8);
    await tick(S8 + 30 * MIN);
    const root = (await remRows())[0]!;
    await press(`rt:${root.id}:ok`, S8 + 3 * 60 * MIN);
    await press(`rt:${root.id}:ok`, S8 + 3 * 60 * MIN);
    expect(await logs()).toEqual([{ status: "taken", answered_at: S8 + 180 * MIN, scheduled_for: S8 }]);
    expect(await count("points_ledger")).toBe(1);
  });

  it("4.5.e: «+15 хв» → натиснутий answered, повтор cancelled, новий корінь того ж слота fire_at = now + 15; подвійний тап — без дубля", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    await med(u);
    await tick(S8);
    const root = (await remRows())[0]!;
    await press(`rt:${root.id}:s15`, S8 + 2 * MIN);
    expect(toast(tg)).toBe("нагадаю о 08:17");
    await press(`rt:${root.id}:s15`, S8 + 3 * MIN);
    expect((await remRows()).map((r) => [r.kind, r.status, r.attempt, (r.fire_at - S8) / MIN, r.slot_at === S8])).toEqual([
      ["routine", "answered", 1, 0, true],
      ["repeat", "cancelled", 2, 5, true],
      ["routine", "pending", 1, 17, true],
    ]);
    await tick(S8 + 17 * MIN);
    expect(pushes(tg)).toHaveLength(2);
  });

  it("Д1/X1 (S4.6): «+15 хв» на першому повідомленні вичерпаного ланцюга → routine_logs порожньо, доки корінь pending", async () => {
    mockTelegram({ seqIds: true });
    const u = await user();
    await med(u);
    for (const t of [S8, S8 + 5 * MIN, S8 + 20 * MIN, S8 + 50 * MIN]) await tick(t);
    const root = (await remRows())[0]!;
    await press(`rt:${root.id}:s15`, S8 + 70 * MIN); // новий корінь о 08:85 = 09:25
    expect(await planRoutines(db(), S8 + 80 * MIN)).toMatchObject({ missed: 0 });
    expect(await logs()).toEqual([]);
  });

  it("4.5.h: тиха ніч рутин не стосується; пауза — так: після паузи в межах 3 год іде, пізніше — cancelled без routine_logs", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    await DB.prepare("UPDATE users SET quiet_from = 1380, quiet_to = 480 WHERE id = ?").bind(u).run();
    const night = Date.parse("2026-11-20T21:30:00Z"); // 23:30 Київ
    await med(u, { times: ["23:30"], kind: "habit" });
    await tick(night);
    expect(pushes(tg)).toHaveLength(1); // у тихих годинах — вчасно

    await DB.prepare("DELETE FROM reminders").run();
    await DB.prepare("DELETE FROM routines").run();
    await med(u, { times: ["08:00"] });
    await DB.prepare("UPDATE users SET pause_until = ? WHERE id = ?").bind(S8 + 60 * MIN, u).run();
    await tick(S8);
    expect(pushes(tg)).toHaveLength(1); // пауза: чекає
    await tick(S8 + 61 * MIN);
    expect(pushes(tg)).toHaveLength(2); // після паузи, у межах ROUTINE_TTL_MS
    await DB.prepare("DELETE FROM reminders").run();
    await DB.prepare("UPDATE users SET pause_until = ? WHERE id = ?").bind(S8 + 24 * 60 * MIN, u).run();
    await tick(S8 + 23 * 60 * MIN); // корінь завтрашнього слота 08:00 чекає
    await DB.prepare("UPDATE users SET pause_until = NULL WHERE id = ?").bind(u).run();
    await tick(S8 + 24 * 60 * MIN + 3 * 60 * MIN + MIN); // > fire_at + 3 год
    expect(pushes(tg)).toHaveLength(2);
    expect((await remRows()).map((r) => r.status)).toContain("cancelled");
    expect(await logs()).toEqual([]);
  });

  it("4.5.k: 403 на корені 08:00, тики 08:01…08:05 → 1 виклик Telegram і 1 корінь", async () => {
    const tg = mockTelegram({ sendError: { code: 403, description: "Forbidden: bot was blocked by the user" } });
    const u = await user();
    await med(u);
    for (let m = 0; m <= 5; m++) await tick(S8 + m * MIN);
    expect(pushes(tg)).toHaveLength(1);
    expect((await remRows()).map((r) => [r.kind, r.status, r.slot_at])).toEqual([["routine", "cancelled", S8]]);
  });

  it("4.5.g: рутина на паузі в мить відправки → cancelled, нічого не надіслано", async () => {
    const tg = mockTelegram();
    const u = await user();
    const id = await med(u);
    await planRoutines(db(), S8 - MIN);
    await DB.prepare("UPDATE routines SET active = 0 WHERE id = ?").bind(id).run();
    await tick(S8);
    expect(pushes(tg)).toHaveLength(0);
    expect((await remRows()).map((r) => r.status)).toEqual(["cancelled"]);
  });
});

describe("S4.7 /routines: список, картка, пауза, редагування", () => {
  it("4.7.a, 4.7.d, 4.7.f: список → картка → ⏸ (корінь видалено) → ▶️; чужий id → «не знайшов»", async () => {
    const tg = mockTelegram();
    const u = await user();
    const id = await med(u, { times: ["08:00", "20:00"] });
    const other = await med(await user(222), { title: "чуже" });
    await planRoutines(db(), T0);
    await say(textUpdate("/routines"));
    expect(textOf(tg.sent().at(-1)!)).toBe("Твої рутини:\n💊 Вітамін D · 08:00, 20:00 · щодня");
    await press(`rl:o:${id}`);
    expect(kbOf(tg.calls.filter((c) => c.method === "editMessageText").at(-1)!).flat().map((b) => b.callback_data)).toEqual([`rl:t:${id}`, `rl:d:${id}`, `rl:n:${id}`, `rl:p:${id}`, "rl:l"]);
    await press(`rl:p:${id}`);
    expect((await routineRows())[0]).toMatchObject({ active: 0 });
    expect((await rows("SELECT id FROM reminders WHERE routine_id = ?", id)).length).toBe(0);
    await press(`rl:r:${id}`);
    expect((await routineRows())[0]).toMatchObject({ active: 1 });
    await press(`rl:p:${other}`);
    expect(toast(tg)).toBe("не знайшов");
    expect((await rows<{ active: number }>("SELECT active FROM routines WHERE id = ?", other))[0]!.active).toBe(1);
  });

  it("4.7.d: ⏸ о 07:50, ▶️ о 08:03 → слот 08:00, що минув під час паузи, не нагадується; корінь — наступний слот", async () => {
    const tg = mockTelegram();
    const u = await user();
    const id = await med(u, { times: ["08:00", "20:00"] });
    await press(`rl:p:${id}`, S8 - 10 * MIN);
    await press(`rl:r:${id}`, S8 + 3 * MIN);
    await tick(S8 + 3 * MIN);
    expect(pushes(tg)).toHaveLength(0);
    expect((await remRows()).map((r) => [r.status, (r.slot_at - S8) / MIN])).toEqual([["pending", 720]]);
  });

  it("4.7.b: ✏️ Назва → текст → UPDATE title без Claude; чернетку закрито", async () => {
    mockTelegram();
    const u = await user();
    const id = await med(u);
    await press(`rl:n:${id}`);
    await say(textUpdate("Магній"), T0 + MIN);
    expect((await routineRows())[0]).toMatchObject({ title: "Магній" });
    expect(await draft()).toBeUndefined();
    expect([sp.current.calls.ai, await count("captures")]).toEqual([0, 0]);
  });

  it("4.7.c, Д2/X2: ⏰ Час → Зберегти: невідправлений корінь видалено; корінь «+15» ланцюга, що вже йде, лишився", async () => {
    mockTelegram({ seqIds: true });
    const u = await user();
    const id = await med(u, { times: ["08:00", "20:00"] });
    await planRoutines(db(), T0);
    expect((await remRows()).map((r) => [r.status, r.slot_at])).toEqual([["pending", S8]]); // невідправлений
    for (const b of [`rl:t:${id}`, "rw:h:09", "rw:m:0900", "rw:next", "rw:save"]) await press(b, T0);
    expect((await routineRows())[0]).toMatchObject({ times: '["09:00"]' });
    expect(await remRows()).toEqual([]); // DELETE, не cancelled: слот лишився б у розкладі — планується знову

    const S9 = S8 + 60 * MIN;
    await tick(S9);
    const root = (await remRows())[0]!;
    await press(`rt:${root.id}:s15`, S9 + MIN); // корінь «+15» у слоті, де вже є відправка
    for (const b of [`rl:t:${id}`, "rw:h:10", "rw:m:1000", "rw:next", "rw:save"]) await press(b, S9 + 2 * MIN);
    expect((await routineRows())[0]).toMatchObject({ times: '["10:00"]' });
    expect((await remRows()).filter((r) => r.status === "pending").map((r) => [r.kind, r.slot_at, r.fire_at])).toEqual([["routine", S9, S9 + 16 * MIN]]);
  });

  it("4.7.e: зміна поясу → невідправлений корінь DELETE і новий за новим tz тим самим batch", async () => {
    mockTelegram();
    const u = await user();
    await med(u);
    await planRoutines(db(), T0);
    expect((await remRows()).map((r) => r.slot_at)).toEqual([S8]);
    await applySetting(u, db(), { field: "tz", value: "Europe/London" }, T0);
    expect((await remRows()).map((r) => [r.status, r.slot_at])).toEqual([["pending", Date.parse("2026-11-20T08:00:00Z")]]);
  });
});

describe("S4.8–S4.9 огляди", () => {
  const DAY0 = Date.parse("2026-11-19T22:00:00Z"); // 00:00 20.11 Київ
  const DAY1 = Date.parse("2026-11-20T22:00:00Z");
  const log = (u: number, r: number, slot: number, status: string) =>
    DB.prepare("INSERT INTO routine_logs (user_id, routine_id, scheduled_for, status, answered_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(u, r, slot, status, status === "missed" ? null : slot, slot)
      .run();

  it("4.8.a–b: ранок — один рядок за першим часом, ✓ лише біля taken; понад 5 → «…ще N»", async () => {
    const u = await user();
    const m = await med(u, { times: ["08:00", "20:00"] });
    await createRoutine(u, db(), { kind: "habit", title: "Прогулянка", times: ["19:00"], daysMask: 127 }, T0);
    await createRoutine(u, db(), { kind: "habit", title: "Вихідний", times: ["07:00"], daysMask: 64 }, T0); // лише Нд
    await log(u, m, S8, "taken");
    expect(await morningRoutines(u, db(), "Europe/Kyiv", DAY0, DAY1)).toBe("💊 Сьогодні: Вітамін D 08:00 ✓, 20:00 · 🔁 Прогулянка 19:00");
    for (let i = 0; i < 5; i++) await med(u, { title: `р${i}`, times: [`1${i}:00`] });
    expect(await morningRoutines(u, db(), "Europe/Kyiv", DAY0, DAY1)).toMatch(/ · …ще 2$/);
  });

  it("4.9.a–b: вечір «N з M ✅» / «усі ✅»; N = 0 → рядка немає; жодного «пропустив», «не прийняв»", async () => {
    const u = await user();
    const m = await med(u, { times: ["08:00", "12:00", "16:00", "20:00"] });
    expect(await eveningRoutines(u, db(), DAY0, DAY1)).toBeNull();
    await log(u, m, S8, "missed");
    await log(u, m, S8 + 4 * 60 * MIN, "skipped");
    expect(await eveningRoutines(u, db(), DAY0, DAY1)).toBeNull(); // N = 0 — жодного «0 з 2»
    await log(u, m, S8 + 8 * 60 * MIN, "taken");
    await log(u, m, S8 + 12 * 60 * MIN, "taken");
    await log(u, m, DAY0 - 2 * 60 * MIN, "taken"); // учорашній слот — не в цій добі (4.9.d)
    const line = await eveningRoutines(u, db(), DAY0, DAY1);
    expect(line).toBe("💊 рутини: 2 з 4 ✅");
    for (const w of ["пропуст", "пропущ", "не прийня", "missed"]) expect(line!.toLowerCase()).not.toContain(w);
    await DB.prepare("DELETE FROM routine_logs WHERE status <> 'taken'").run();
    expect(await eveningRoutines(u, db(), DAY0, DAY1)).toBe("💊 рутини: усі ✅");
  });

  it("4.9: вечірній огляд несе рядок рутин; 4.8.c — ранок лише з рутинами не надсилається", async () => {
    const tg = mockTelegram();
    const u = await user();
    const m = await med(u, { times: ["08:00", "12:00"] });
    await log(u, m, S8, "taken");
    await log(u, m, S8 + 4 * 60 * MIN, "missed");
    await tick(Date.parse("2026-11-20T18:59:00Z"));
    await tick(Date.parse("2026-11-20T19:00:00Z"));
    const eve = tg.sent().map(textOf).find((t) => t.includes("рутини"));
    expect(eve).toContain("💊 рутини: 1 з 2 ✅");
    expect(eve).not.toMatch(/пропуст|не прийня/i);
    await tick(Date.parse("2026-11-21T05:59:00Z"));
    const before = tg.sent().length;
    await tick(Date.parse("2026-11-21T06:00:00Z")); // ранок 08:00: подій і справ немає → огляду немає
    expect(tg.sent().slice(before).map(textOf).filter((t) => t.includes("Сьогодні:"))).toEqual([]);
  });
});
