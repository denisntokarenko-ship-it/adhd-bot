// Події: дорога, напередодні й «час виходити» (docs/spec/phase-2.md S2.7; крок 2.3). Час фіксований (`vi.setSystemTime`),
// D1 справжній, Telegram — мок. Планування з 2.1 (`plannedFor`) тут лише звіряється; нове — відповідь `tr`, перепланування,
// скасування «час виходити» після початку події (борг 2.2).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../../src/db/index";
import { create, type NewItem } from "../../src/db/items";
import { claimTravelAsk, listForItem, setTravel } from "../../src/db/reminders";
import { ensureUser } from "../../src/db/users";
import { planReminders } from "../../src/reminders/planner";
import { runScheduled } from "../../src/scheduled";
import { ACK_TRAVEL_POOL, TRAVEL_STARTED, UNKNOWN_REMINDER } from "../../src/texts";
import { baseEnv, deps, mockTelegram, send } from "./helpers";

const DB = env.DB!;
const db = () => openDb(baseEnv());
const at = (iso: string) => Date.parse(iso);
const MIN = 60_000;
const now = () => Date.now();
const FRI_NOON = at("2026-11-20T10:00:00Z"); // 12:00 пт 20.11 Київ
const EV_10 = at("2026-11-21T08:00:00Z"); // сб 21.11 10:00 Київ

beforeEach(async () => {
  for (const t of ["reminders", "points_ledger", "ai_calls", "items", "capture_fixes", "captures", "users"]) await DB.prepare(`DELETE FROM ${t}`).run();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FRI_NOON);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const user = async (tgId = 111) => (await ensureUser(tgId, db(), now())).id;
const event = async (u: number, over: Partial<NewItem> = {}) =>
  (await create(u, db(), { kind: "event", title: "Лікар", source: "text", dueAt: EV_10, ...over }, now())).id;
const iso = (ms: number) => new Date(ms).toISOString();
const roots = async (u: number, item: number) =>
  (await listForItem(u, db(), item)).filter((r) => r.parent_id === null).map((r) => [r.kind, iso(r.fire_at), r.status]);
const pendingLeave = async (u: number, item: number) =>
  (await listForItem(u, db(), item)).filter((r) => r.kind === "leave_now" && r.status === "pending");
const travelOf = async (id: number) => (await DB.prepare("SELECT travel_min FROM items WHERE id = ?").bind(id).first<{ travel_min: number | null }>())!.travel_min;

describe("S2.7 планування подій", () => {
  it("2.7.d: подія завтра 10:00, travel 30, створена сьогодні 12:00 → eve_before сьогодні 20:00, leave_now завтра 09:15", async () => {
    const u = await user();
    const ev = await event(u, { travelMin: 30 });
    await planReminders(db(), now());
    expect(await roots(u, ev)).toEqual([
      ["eve_before", "2026-11-20T18:00:00.000Z", "pending"], // 20:00 Київ
      ["leave_now", "2026-11-21T07:15:00.000Z", "pending"], // 09:15 Київ = 10:00 − 30 − 15
    ]);
  });

  it("2.7.d: подію створено о 22:00 на завтра → eve_before немає (питання вже було), leave_now є", async () => {
    vi.setSystemTime(at("2026-11-20T20:00:00Z")); // 22:00 Київ
    const u = await user();
    const ev = await event(u, { travelMin: 30 });
    await planReminders(db(), now());
    expect(await roots(u, ev)).toEqual([["leave_now", "2026-11-21T07:15:00.000Z", "pending"]]);
  });

  // Спека каже «о 09:50», але рівно 09:45 = now − LATE_MS ще створюється (2.1.e: `fire_at ≥ now − LATE_MS`); беремо 09:51.
  it("2.7.d: створена завтра о 09:51 (travel NULL) → планувальник нічого не створює; відповідь `tr 30` о 09:52 → leave_now «зараз»", async () => {
    vi.setSystemTime(at("2026-11-21T07:51:00Z")); // 09:51 Київ: leave_now 09:45 — 6 хв позаду
    const u = await user();
    const ev = await event(u);
    await planReminders(db(), now());
    expect(await roots(u, ev)).toEqual([]); // обидві миті позаду
    vi.setSystemTime(at("2026-11-21T07:52:00Z"));
    expect(await setTravel(u, db(), ev, 30, now())).toEqual({ kind: "set", fireAt: now(), changed: true });
    expect(await roots(u, ev)).toEqual([["leave_now", "2026-11-21T07:52:00.000Z", "pending"]]);
  });

  it("2.7.c: без відповіді travel_min = NULL → leave_now о due − 15 хв", async () => {
    const u = await user();
    const ev = await event(u);
    await planReminders(db(), now());
    expect((await roots(u, ev)).map((r) => r[1])).toEqual(["2026-11-20T18:00:00.000Z", "2026-11-21T07:45:00.000Z"]);
    expect(await travelOf(ev)).toBeNull();
  });

  it("2.7.e: travel 60, due 10:00 → leave_now 08:45", async () => {
    const u = await user();
    const ev = await event(u, { travelMin: 60 });
    await planReminders(db(), now());
    expect((await pendingLeave(u, ev)).map((r) => iso(r.fire_at))).toEqual(["2026-11-21T06:45:00.000Z"]);
  });
});

describe("S2.7.b/g відповідь про дорогу й перепланування", () => {
  it("зміна travel 30 → 60 після планування → один pending leave_now о 08:45, старий cancelled, eve_before не зачеплено", async () => {
    const u = await user();
    const ev = await event(u, { travelMin: 30 });
    await planReminders(db(), now());
    expect(await setTravel(u, db(), ev, 60, now())).toMatchObject({ kind: "set", changed: true });
    expect(await travelOf(ev)).toBe(60);
    expect((await pendingLeave(u, ev)).map((r) => [iso(r.fire_at), r.max_attempts, r.attempt])).toEqual([["2026-11-21T06:45:00.000Z", 4, 1]]);
    expect(await roots(u, ev)).toEqual([
      ["eve_before", "2026-11-20T18:00:00.000Z", "pending"],
      ["leave_now", "2026-11-21T06:45:00.000Z", "pending"],
      ["leave_now", "2026-11-21T07:15:00.000Z", "cancelled"],
    ]);
  });

  it("S2.7.g B: 30 → 60 → 30 → один pending (о 09:15) і два cancelled — скасований корінь не блокує повернення", async () => {
    const u = await user();
    const ev = await event(u, { travelMin: 30 });
    await planReminders(db(), now());
    await setTravel(u, db(), ev, 60, now());
    await setTravel(u, db(), ev, 30, now());
    expect((await pendingLeave(u, ev)).map((r) => iso(r.fire_at))).toEqual(["2026-11-21T07:15:00.000Z"]);
    expect((await listForItem(u, db(), ev)).filter((r) => r.kind === "leave_now" && r.status === "cancelled")).toHaveLength(2);
  });

  it("S2.7.g A: планувальник створив leave_now о 09:45 (NULL), відповідь «0» → рівно один pending о 09:45, без змін і без помилки", async () => {
    const u = await user();
    const ev = await event(u);
    await planReminders(db(), now());
    const before = await roots(u, ev);
    expect(await setTravel(u, db(), ev, 0, now())).toMatchObject({ kind: "set", changed: false });
    expect(await roots(u, ev)).toEqual(before);
    expect((await pendingLeave(u, ev)).map((r) => iso(r.fire_at))).toEqual(["2026-11-21T07:45:00.000Z"]);
    expect(await travelOf(ev)).toBeNull(); // «0» і NULL — те саме N: нічого не переписано
  });

  it("повторна відповідь з тим самим N і подвійний тап → без дублів", async () => {
    const u = await user();
    const ev = await event(u, { travelMin: 30 });
    await planReminders(db(), now());
    await setTravel(u, db(), ev, 60, now());
    await Promise.all([setTravel(u, db(), ev, 60, now()), setTravel(u, db(), ev, 60, now())]);
    expect(await pendingLeave(u, ev)).toHaveLength(1);
    expect((await listForItem(u, db(), ev)).filter((r) => r.kind === "leave_now")).toHaveLength(2); // 1 pending + 1 cancelled
  });

  it("відповідь до першого тику лише створює leave_now; eve_before додасть планувальник (2.1.j) — і leave_now лишається один", async () => {
    const u = await user();
    const ev = await event(u);
    await setTravel(u, db(), ev, 30, now());
    await planReminders(db(), now());
    expect(await roots(u, ev)).toEqual([
      ["eve_before", "2026-11-20T18:00:00.000Z", "pending"],
      ["leave_now", "2026-11-21T07:15:00.000Z", "pending"],
    ]);
  });

  it("мить «виходити» вже позаду, а подія попереду → зараз; подія почалась → нічого не змінено", async () => {
    vi.setSystemTime(at("2026-11-21T07:40:00Z")); // 09:40, подія о 10:00
    const u = await user();
    const ev = await event(u);
    expect(await setTravel(u, db(), ev, 60, now())).toEqual({ kind: "set", fireAt: now(), changed: true });
    vi.setSystemTime(at("2026-11-21T08:01:00Z"));
    expect(await setTravel(u, db(), ev, 15, now())).toEqual({ kind: "started" });
    expect(await travelOf(ev)).toBe(60);
  });

  it("не подія / all_day / закритий / чужий запис → gone, нічого не створено", async () => {
    const u = await user();
    const u2 = await user(222);
    const task = (await create(u, db(), { kind: "task", title: "т", source: "text", dueAt: EV_10 }, now())).id;
    const allDay = await event(u, { allDay: true });
    const done = await event(u);
    await DB.prepare("UPDATE items SET status = 'done', done_at = 1 WHERE id = ?").bind(done).run();
    const foreign = await event(u2);
    for (const id of [task, allDay, done, foreign]) {
      expect(await setTravel(u, db(), id, 30, now())).toEqual({ kind: "gone" });
    }
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM reminders").first<{ n: number }>()).toEqual({ n: 0 });
    expect(await travelOf(foreign)).toBeNull();
  });

  it("питання задається раз: claimTravelAsk друге й паралельне — false", async () => {
    const u = await user();
    const ev = await event(u);
    const got = await Promise.all([claimTravelAsk(u, db(), ev, now()), claimTravelAsk(u, db(), ev, now())]);
    expect(got.filter(Boolean)).toHaveLength(1);
    expect(await claimTravelAsk(u, db(), ev, now())).toBe(false);
  });
});

// ── кнопка `tr:<id>:<хв>` через вебхук ───────────────────────────────────────────────────────────────────
let cbId = 4000;
const press = (data: string, from = 111) =>
  send(
    {
      update_id: ++cbId,
      callback_query: {
        id: `cb${cbId}`,
        chat_instance: "x",
        from: { id: from, is_bot: false, first_name: "T" },
        data,
        message: { message_id: 1, date: 0, chat: { id: from, type: "private" } },
      },
    },
    baseEnv({ ALLOWED_TG_IDS: "111,222" }),
    deps({ now: Date.now() }),
  );
const toast = (tg: ReturnType<typeof mockTelegram>) => tg.calls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text;

describe("кнопки tr:", () => {
  it("tr:<id>:30 → travel 30, один leave_now, повідомлення оновлено з часом; повтор того ж → без змін", async () => {
    const tg = mockTelegram();
    const u = await user();
    const ev = await event(u, { title: "Лікар" });
    await planReminders(db(), now());
    await press(`tr:${ev}:30`);
    expect(await travelOf(ev)).toBe(30);
    expect((await pendingLeave(u, ev)).map((r) => iso(r.fire_at))).toEqual(["2026-11-21T07:15:00.000Z"]);
    const edit = tg.calls.find((c) => c.method === "editMessageText")!;
    expect(String(edit.body.text)).toContain("<b>Лікар</b> — 30 хв");
    expect(String(edit.body.text)).toContain("09:15");
    expect(ACK_TRAVEL_POOL.some((p) => String(edit.body.text).includes(p))).toBe(true);
    await press(`tr:${ev}:30`);
    expect(await pendingLeave(u, ev)).toHaveLength(1);
    await press(`tr:${ev}:60`);
    expect((await pendingLeave(u, ev)).map((r) => iso(r.fire_at))).toEqual(["2026-11-21T06:45:00.000Z"]);
  });

  it("чужий item_id → «не знаю такого», нічого не змінено; невалідні хвилини не маршрутизуються", async () => {
    const tg = mockTelegram();
    const u = await user();
    await user(222);
    const ev = await event(u);
    await press(`tr:${ev}:30`, 222);
    expect(toast(tg)).toBe(UNKNOWN_REMINDER);
    expect(await travelOf(ev)).toBeNull();
    const before = tg.calls.length;
    await press(`tr:${ev}:45`);
    expect(await travelOf(ev)).toBeNull();
    expect(tg.calls.slice(before).filter((c) => c.method === "editMessageText")).toHaveLength(0);
  });

  it("подія вже почалась → тост «подія вже почалась», нічого не змінено", async () => {
    vi.setSystemTime(at("2026-11-21T08:05:00Z"));
    const tg = mockTelegram();
    const u = await user();
    const ev = await event(u);
    await press(`tr:${ev}:30`);
    expect(toast(tg)).toBe(TRAVEL_STARTED);
    expect(await travelOf(ev)).toBeNull();
  });
});

// ── борг 2.2: «час виходити» не йде після початку події ──────────────────────────────────────────────────
const cron = () => runScheduled(baseEnv(), { now: () => Date.now() }, { rand: () => 0 });
const sentTo = (tg: ReturnType<typeof mockTelegram>) => tg.calls.filter((c) => c.method === "sendMessage");

async function rawRem(u: number, item: number, over: Record<string, unknown>): Promise<number> {
  const all: Record<string, unknown> = { user_id: u, item_id: item, kind: "leave_now", fire_at: 0, attempt: 1, max_attempts: 4, created_at: FRI_NOON, ...over };
  const keys = Object.keys(all);
  return (await DB.prepare(`INSERT INTO reminders (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")}) RETURNING id`).bind(...Object.values(all)).first<{ id: number }>())!.id;
}
const statusOf = async (id: number) => (await DB.prepare("SELECT status FROM reminders WHERE id = ?").bind(id).first<{ status: string }>())!.status;

describe("S2.2.e / борг 2.2: leave_now після due_at події не відправляється", () => {
  const due = at("2026-11-21T08:00:00Z"); // 10:00 Київ

  it("leave_now, що чекав у черзі й дочекався тику ПІСЛЯ початку події → cancelled, жодного повідомлення", async () => {
    const tg = mockTelegram();
    const u = await user();
    const ev = await event(u, { dueAt: due });
    const r = await rawRem(u, ev, { fire_at: due - 15 * MIN });
    vi.setSystemTime(due + MIN); // 10:01 — як item 31 у живому прогоні: затримали до 08:01 при події о 08:00
    await cron();
    expect(sentTo(tg)).toHaveLength(0);
    expect(await statusOf(r)).toBe("cancelled");
  });

  it("повтор (repeat) leave_now, затриманий за початок події → cancelled, без повідомлення", async () => {
    const tg = mockTelegram();
    const u = await user();
    const ev = await event(u, { dueAt: due });
    const root = await rawRem(u, ev, { fire_at: due - 20 * MIN, status: "sent", sent_at: due - 20 * MIN, sent_as: "single", tg_message_id: 5 });
    const rep = await rawRem(u, ev, { kind: "repeat", attempt: 2, parent_id: root, root_id: root, fire_at: due - 15 * MIN });
    vi.setSystemTime(due + MIN);
    await cron();
    expect(sentTo(tg)).toHaveLength(0);
    expect(await statusOf(rep)).toBe("cancelled");
  });

  it("контроль: до початку події той самий leave_now відправляється як завжди", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    const ev = await event(u, { dueAt: due });
    const r = await rawRem(u, ev, { fire_at: due - 15 * MIN });
    vi.setSystemTime(due - 10 * MIN);
    await cron();
    expect(sentTo(tg)).toHaveLength(1);
    expect(await statusOf(r)).toBe("sent");
  });

  it("не подія: due звичайної задачі після її часу йде як завжди; all_day подія — теж", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    const task = (await create(u, db(), { kind: "task", title: "т", source: "text", dueAt: due }, now())).id;
    const r1 = await rawRem(u, task, { kind: "due", max_attempts: 1, fire_at: due });
    const allDay = await event(u, { allDay: true, dueAt: at("2026-11-20T22:00:00Z") });
    const r2 = await rawRem(u, allDay, { kind: "due", max_attempts: 1, fire_at: due });
    vi.setSystemTime(due + MIN);
    await cron();
    expect(sentTo(tg)).toHaveLength(2);
    expect([await statusOf(r1), await statusOf(r2)]).toEqual(["sent", "sent"]);
  });
});
