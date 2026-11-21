// Тиша, пауза, зведення й варіації (docs/spec/phase-2-dates-texts.md S2.9.e–g, S2.10, S2.11; крок 2.4).
// Час фіксований (`vi.setSystemTime`), D1 справжній, Telegram — мок. Відправку з тиші/паузи вже тримає claim (2.2) —
// тут перевіряємо команди, їхній ефект на cron і те, що тексти не повторюються.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../../src/db/index";
import { create, type NewItem } from "../../src/db/items";
import { ensureUser } from "../../src/db/users";
import { runScheduled } from "../../src/scheduled";
import {
  ACK_PAUSE_POOL,
  ACK_RESUME_POOL,
  NO_PAUSE,
  PAUSE_ASK,
  PAUSE_HINT,
  QUIET_NONE,
  REMIND_DUE_POOL,
  REMIND_EVE_POOL,
  REMIND_LEAVE_POOL,
  REMIND_REPEAT2_POOL,
  SUMMARY_HEAD_POOL,
} from "../../src/texts";
import { NOW, baseEnv, deps, mockTelegram, send, textUpdate, type TgCall } from "./helpers";

const DB = env.DB!;
const db = () => openDb(baseEnv());
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (iso: string) => Date.parse(iso);

beforeEach(async () => {
  for (const t of ["reminders", "points_ledger", "ai_calls", "items", "capture_fixes", "captures", "users"]) await DB.prepare(`DELETE FROM ${t}`).run();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW); // 12:00 пт 20.11 Київ — не тиша
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const clock = { now: () => Date.now() };
const cron = () => runScheduled(baseEnv(), clock, { rand: () => 0 });
const at$ = (ms: number) => vi.setSystemTime(ms);

const user = async (tgId = 111) => (await ensureUser(tgId, db(), Date.now())).id;
const mkItem = async (userId: number, over: Partial<NewItem> = {}) =>
  (await create(userId, db(), { kind: "task", title: "подзвонити мамі", source: "text", ...over }, Date.now())).id;

async function rem(userId: number, itemId: number, over: Record<string, unknown> = {}): Promise<number> {
  const all: Record<string, unknown> = { user_id: userId, item_id: itemId, kind: "due", fire_at: NOW - 1000, attempt: 1, max_attempts: 1, created_at: NOW, ...over };
  if (all.status === "sent" || all.status === "answered") {
    all.sent_at ??= NOW - MIN;
    all.sent_as ??= "single";
    all.tg_message_id ??= 5;
  }
  const keys = Object.keys(all);
  return (await DB.prepare(`INSERT INTO reminders (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")}) RETURNING id`).bind(...Object.values(all)).first<{ id: number }>())!.id;
}

interface Rem {
  id: number;
  status: string;
  fire_at: number;
  attempt: number;
  sent_as: string | null;
  variant_idx: number | null;
  tg_message_id: number | null;
}
const rems = async (where = "1=1") => (await DB.prepare(`SELECT * FROM reminders WHERE ${where} ORDER BY id`).all<Rem>()).results;
const usr = async () => (await DB.prepare("SELECT pause_until, quiet_from, quiet_to FROM users WHERE tg_id = 111").first<{ pause_until: number | null; quiet_from: number; quiet_to: number }>())!;

const sent = (tg: ReturnType<typeof mockTelegram>) => tg.calls.filter((c) => c.method === "sendMessage");
const kbOf = (c: TgCall) => (c.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
const say = (text: string) => send(textUpdate(text), baseEnv(), deps({ now: Date.now() }));

let cbId = 9000;
const press = (data: string) =>
  send(
    {
      update_id: ++cbId,
      callback_query: { id: `cb${cbId}`, chat_instance: "x", from: { id: 111, is_bot: false, first_name: "T" }, data, message: { message_id: 1, date: 0, chat: { id: 111, type: "private" } } },
    },
    baseEnv(),
    deps({ now: Date.now() }),
  );
const lastEdit = (tg: ReturnType<typeof mockTelegram>) => tg.calls.filter((c) => c.method === "editMessageText").at(-1);

describe("S2.9.e /pause", () => {
  it("без аргументів — кнопки 1 год · 2 год · 4 год · до ранку; нічого не змінено", async () => {
    const tg = mockTelegram();
    await user();
    await say("/pause");
    const m = sent(tg)[0]!;
    expect(m.body.text).toBe(PAUSE_ASK);
    expect(kbOf(m)[0]!.map((b) => [b.text, b.callback_data])).toEqual([["1 год", "pz:60"], ["2 год", "pz:120"], ["4 год", "pz:240"], ["до ранку", "pz:m"]]);
    expect((await usr()).pause_until).toBeNull();
  });

  it("/pause 2 → pause_until = now + 2 год; відповідь з пулу називає час 14:00", async () => {
    const tg = mockTelegram();
    await user();
    await say("/pause 2");
    expect((await usr()).pause_until).toBe(NOW + 2 * HOUR);
    expect(ACK_PAUSE_POOL.map((t) => t.replace("{t}", "14:00"))).toContain(sent(tg)[0]!.body.text);
  });

  it("N поза 1–24 або не число → підказка без змін; нова пауза замінює стару", async () => {
    const tg = mockTelegram();
    await user();
    for (const bad of ["0", "25", "-1", "abc", "2.5", "2 години", "99999"]) {
      await say(`/pause ${bad}`);
      expect(sent(tg).at(-1)!.body.text, bad).toBe(PAUSE_HINT);
      expect((await usr()).pause_until, bad).toBeNull();
    }
    await say("/pause 24");
    expect((await usr()).pause_until).toBe(NOW + 24 * HOUR); // межа вмикається
    await say("/pause 1");
    expect((await usr()).pause_until).toBe(NOW + HOUR); // замінила, а не додалась
  });

  it("кнопки: pz:120 → +2 год, pz:m → наступне quiet_to (08:00 Київ = 06:00Z наступної доби); повідомлення редагується без кнопок", async () => {
    const tg = mockTelegram();
    await user();
    await press("pz:120");
    expect((await usr()).pause_until).toBe(NOW + 2 * HOUR);
    expect(kbOf(lastEdit(tg)!)).toEqual([]);
    await press("pz:m");
    expect((await usr()).pause_until).toBe(at("2026-11-21T06:00:00Z"));
    expect(lastEdit(tg)!.body.text).toContain("завтра 08:00");
  });

  it("2.10.b: дві паузи підряд — відповіді різні (колонка ack_pause_idx), навіть коли rand «хоче» повтор", async () => {
    const tg = mockTelegram();
    await user();
    await say("/pause 1");
    await say("/pause 1");
    const [a, b] = sent(tg).map((c) => c.body.text);
    expect(a).not.toBe(b);
  });
});

describe("S2.9.f /resume", () => {
  it("без активної паузи — «паузи й не було»; з простроченою — теж", async () => {
    const tg = mockTelegram();
    const u = await user();
    await say("/resume");
    expect(sent(tg)[0]!.body.text).toBe(NO_PAUSE);
    await DB.prepare("UPDATE users SET pause_until = ? WHERE id = ?").bind(NOW - 1, u).run();
    await say("/resume");
    expect(sent(tg)[1]!.body.text).toBe(NO_PAUSE);
  });

  it("активна пауза → pause_until = NULL, відповідь з пулу; дві підряд — різні тексти", async () => {
    const tg = mockTelegram();
    await user();
    await say("/pause 3");
    await say("/resume");
    expect((await usr()).pause_until).toBeNull();
    await say("/pause 3");
    await say("/resume");
    const resumes = sent(tg).filter((c) => (ACK_RESUME_POOL as readonly string[]).includes(String(c.body.text))).map((c) => c.body.text);
    expect(resumes).toHaveLength(2);
    expect(resumes[0]).not.toBe(resumes[1]);
  });
});

describe("S2.9.g пауза й зведення", () => {
  async function threeInPause() {
    const u = await user();
    const ids: number[] = [];
    for (const m of [20, 30, 40]) ids.push(await rem(u, await mkItem(u, { title: `справа ${m}` }), { fire_at: NOW + m * MIN }));
    return { u, ids };
  }
  const bullets = (c: TgCall) => String(c.body.text).split("\n").filter((l) => l.startsWith("•"));

  it("пауза 2 год із трьома нагадуваннями всередині → 0 повідомлень під час паузи, рядки без змін; після неї рівно 1 зведення з трьох", async () => {
    const tg = mockTelegram();
    const { ids } = await threeInPause();
    await say("/pause 2");
    tg.calls.length = 0;
    for (const m of [21, 45, 90, 119]) {
      at$(NOW + m * MIN);
      await cron();
    }
    expect(sent(tg)).toHaveLength(0);
    expect((await rems()).map((r) => [r.status, r.attempt, r.fire_at])).toEqual([20, 30, 40].map((m) => ["pending", 1, NOW + m * MIN])); // зсув не переписує fire_at
    at$(NOW + 121 * MIN); // пауза скінчилась
    await cron();
    const msgs = sent(tg);
    expect(msgs).toHaveLength(1);
    expect(bullets(msgs[0]!)).toHaveLength(3);
    expect((await rems()).map((r) => [r.id, r.status, r.sent_as])).toEqual(ids.map((id) => [id, "sent", "summary"]));
    at$(NOW + 130 * MIN);
    await cron();
    expect(sent(tg)).toHaveLength(1); // слідом за зведенням пуша немає
  });

  it("/resume раніше терміну → найближчий тик віддає зведення одразу, а не о 14:00", async () => {
    const tg = mockTelegram();
    await threeInPause();
    await say("/pause 2");
    tg.calls.length = 0;
    at$(NOW + 50 * MIN);
    await cron();
    expect(sent(tg)).toHaveLength(0);
    await say("/resume");
    tg.calls.length = 0;
    await cron();
    expect(sent(tg)).toHaveLength(1);
    expect(bullets(sent(tg)[0]!)).toHaveLength(3);
  });

  it("пауза поверх тихих годин: діє довша — пауза до 23:30 (вже тиша) → мовчання до 08:00; відповідь називає 08:00, не 23:30", async () => {
    const tg = mockTelegram();
    const u = await user();
    at$(at("2026-11-20T19:30:00Z")); // 21:30 Київ
    await rem(u, await mkItem(u), { fire_at: Date.now() + 30 * MIN });
    await say("/pause 2"); // до 23:30 Київ, а тиша 23:00–08:00
    expect(String(sent(tg)[0]!.body.text)).toContain("завтра 08:00");
    tg.calls.length = 0;
    at$(at("2026-11-20T21:45:00Z")); // 23:45 Київ: пауза скінчилась, але тиша
    await cron();
    expect(sent(tg)).toHaveLength(0);
    at$(at("2026-11-21T06:00:00Z")); // 08:00
    await cron();
    expect(sent(tg)).toHaveLength(1);
  });
});

describe("S2.11 /quiet", () => {
  it("два кроки кнопками без стану: початок 22/23/00 + «без тихих годин»; кінець 07/08/09; відповідь називає вікно", async () => {
    const tg = mockTelegram();
    await user();
    await say("/quiet");
    const m = sent(tg)[0]!;
    expect(kbOf(m).flat().map((b) => [b.text, b.callback_data])).toEqual([["22:00", "qt:f:1320"], ["23:00", "qt:f:1380"], ["00:00", "qt:f:0"], ["без тихих годин", "qt:n"]]);
    await press("qt:f:1380");
    expect(kbOf(lastEdit(tg)!).flat().map((b) => b.callback_data)).toEqual(["qt:t:1380:420", "qt:t:1380:480", "qt:t:1380:540"]);
    expect(await usr()).toMatchObject({ quiet_from: 1380, quiet_to: 480 }); // поки нічого не змінено
    await press("qt:t:1380:540");
    expect(lastEdit(tg)!.body.text).toContain("23:00–09:00");
    expect(await usr()).toMatchObject({ quiet_from: 1380, quiet_to: 540 });
  });

  it("«без тихих годин» → quiet_from = quiet_to; о 01:00 нагадування йде; зіпсовані callback-и нічого не міняють", async () => {
    const tg = mockTelegram();
    const u = await user();
    await press("qt:n");
    expect(lastEdit(tg)!.body.text).toBe(QUIET_NONE);
    expect(await usr()).toMatchObject({ quiet_from: 480, quiet_to: 480 });
    for (const bad of ["qt:f:999", "qt:t:1380:600", "qt:t:60:480", "qt:x", "pz:5"]) await press(bad);
    expect(await usr()).toMatchObject({ quiet_from: 480, quiet_to: 480 });
    at$(at("2026-11-20T23:00:00Z")); // 01:00 Київ
    await rem(u, await mkItem(u), { fire_at: Date.now() - 1000 });
    tg.calls.length = 0;
    await cron();
    expect(sent(tg)).toHaveLength(1);
  });

  it("зміна діє з наступного тика, fire_at не переписується: 00:00–09:00 → о 08:30 мовчить, о 09:00 шле", async () => {
    const tg = mockTelegram();
    const u = await user();
    await press("qt:f:0");
    await press("qt:t:0:540");
    const id = await rem(u, await mkItem(u), { fire_at: at("2026-11-20T21:00:00Z") }); // 23:00 Київ
    tg.calls.length = 0;
    at$(at("2026-11-21T06:30:00Z")); // 08:30 Київ — раніше було б уже можна
    await cron();
    expect(sent(tg)).toHaveLength(0);
    expect((await rems(`id = ${id}`))[0]).toMatchObject({ status: "pending", fire_at: at("2026-11-20T21:00:00Z") });
    at$(at("2026-11-21T07:00:00Z")); // 09:00
    await cron();
    expect(sent(tg)).toHaveLength(1);
  });
});

describe("S2.10 варіації: підряд не повторюються", () => {
  const headOf = (c: TgCall) => String(c.body.text).split("\n")[0]!;

  it("два нагадування поспіль (rand «хоче» повтор) — різні тексти: due, eve_before, leave_now, repeat", async () => {
    const tg = mockTelegram();
    const u = await user();
    const ev = at("2026-11-21T08:00:00Z"); // сб 10:00 Київ
    const cases: { kind: string; pool: readonly string[]; item?: Partial<NewItem> }[] = [
      { kind: "due", pool: REMIND_DUE_POOL },
      { kind: "eve_before", pool: REMIND_EVE_POOL, item: { kind: "event", dueAt: ev } },
      { kind: "leave_now", pool: REMIND_LEAVE_POOL, item: { kind: "event", dueAt: ev } },
    ];
    for (const c of cases) {
      tg.calls.length = 0;
      const a = await rem(u, await mkItem(u, { title: "А", ...c.item }), { kind: c.kind, fire_at: Date.now() - 1000 });
      const b = await rem(u, await mkItem(u, { title: "Б", ...c.item }), { kind: c.kind, fire_at: Date.now() - 900 });
      await cron();
      const [m1, m2] = sent(tg);
      expect(headOf(m1!), c.kind).not.toBe(headOf(m2!));
      expect(c.pool, c.kind).toContain(headOf(m1!));
      expect(c.pool, c.kind).toContain(headOf(m2!));
      const rows = await rems(`id IN (${a}, ${b})`);
      expect(rows[0]!.variant_idx).not.toBe(rows[1]!.variant_idx);
    }
    // repeat (спроба 2): окремий пул, пам'ять — за номером спроби
    at$(NOW + 3 * HOUR); // вікно «6 окремих на годину» звільнилось: шість попередніх відправок позаду
    tg.calls.length = 0;
    for (const [title, tgId, ago] of [["В", 5, 1000], ["Г", 6, 900]] as const) {
      const itemId = await mkItem(u, { title, priority: "important" });
      const parent = await rem(u, itemId, { status: "sent", max_attempts: 4, sent_at: Date.now() - 6 * MIN, tg_message_id: tgId });
      await rem(u, itemId, { kind: "repeat", attempt: 2, max_attempts: 4, parent_id: parent, root_id: parent, fire_at: Date.now() - ago });
    }
    await cron();
    const [r1, r2] = sent(tg);
    expect(headOf(r1!)).not.toBe(headOf(r2!));
    expect(REMIND_REPEAT2_POOL).toContain(headOf(r1!));
  });

  it("S2.7.f: «напередодні» і «час виходити» називають час події", async () => {
    const tg = mockTelegram();
    const u = await user();
    const ev = at("2026-11-21T08:00:00Z");
    await rem(u, await mkItem(u, { kind: "event", title: "Лікар", dueAt: ev }), { kind: "eve_before", fire_at: Date.now() - 1000 });
    await rem(u, await mkItem(u, { kind: "event", title: "Стоматолог", dueAt: ev }), { kind: "leave_now", max_attempts: 4, fire_at: Date.now() - 900 });
    await cron();
    expect(sent(tg)).toHaveLength(2);
    for (const m of sent(tg)) expect(String(m.body.text)).toMatch(/<b>.+<\/b> — завтра, .*10:00/);
  });

  it("два зведення підряд мають різні заголовки (пам'ять — variant_idx попереднього зведення)", async () => {
    const tg = mockTelegram();
    const u = await user();
    const mk = async (n: number) => {
      for (let i = 0; i < 3; i++) await rem(u, await mkItem(u, { title: `z${n}${i}` }), { fire_at: Date.now() - 10 * MIN });
    };
    await mk(1);
    await cron();
    at$(NOW + 2 * HOUR); // ковзне вікно зведення (1/год) звільнилось
    await mk(2);
    await cron();
    const heads = sent(tg).map(headOf);
    expect(heads).toHaveLength(2);
    expect(heads[0]).not.toBe(heads[1]);
    for (const h of heads) expect(SUMMARY_HEAD_POOL).toContain(h);
  });
});
