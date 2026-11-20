// Черга нагадувань на D1 (docs/spec/phase-2.md S2.1; оренда — S2.3 крок 3, гонка — S2.5.a). Час фіксований.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../../src/db/index";
import { create, type NewItem } from "../../src/db/items";
import { answer, listForItem, planItem, schedule } from "../../src/db/reminders";
import { claimDueReminders, listUnplannedItems } from "../../src/db/system";
import { ensureUser } from "../../src/db/users";
import { CLAIM_LIMIT, LATE_MS, LEASE_MS } from "../../src/reminders/plan";
import { planReminders } from "../../src/reminders/planner";
import { runScheduled } from "../../src/scheduled";
import { baseEnv } from "./helpers";

const DB = env.DB!;
const db = () => openDb(baseEnv());
const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-11-20T10:00:00Z"); // 12:00 пт 20.11 Київ
const now = () => Date.now();

beforeEach(async () => {
  for (const t of ["reminders", "points_ledger", "ai_calls", "items", "capture_fixes", "captures", "users"]) await DB.prepare(`DELETE FROM ${t}`).run();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const user = async (tgId = 111) => (await ensureUser(tgId, db(), now())).id;
const newItem = async (userId: number, over: Partial<NewItem> = {}) =>
  (await create(userId, db(), { kind: "task", title: "подзвонити мамі", source: "text", ...over }, now())).id;
const rows = async (sql = "SELECT * FROM reminders ORDER BY fire_at, id", ...binds: unknown[]) =>
  (await DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;
const plannedAt = async (itemId: number) =>
  (await DB.prepare("SELECT planned_at FROM items WHERE id = ?").bind(itemId).first<{ planned_at: number | null }>())!.planned_at;

// прямий SQL у reminders (для CHECK-ів і станів, яких 2.1 ще не вміє створювати кодом)
async function rawInsert(cols: Record<string, unknown>) {
  const all = { kind: "due", fire_at: NOW, attempt: 1, max_attempts: 1, created_at: NOW, ...cols };
  const keys = Object.keys(all);
  const res = await DB.prepare(`INSERT INTO reminders (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")}) RETURNING id`)
    .bind(...Object.values(all))
    .first<{ id: number }>();
  return res!.id;
}

describe("S2.1 схема 0004", () => {
  it("2.1.a: CHECK-и відхиляють сміття; індекси на місці", async () => {
    const u = await user();
    const it1 = await newItem(u, { dueAt: NOW });
    const base = { user_id: u, item_id: it1 };
    const root = await rawInsert({ ...base, max_attempts: 4, status: "sent", sent_at: NOW, sent_as: "single" });
    await rawInsert({ ...base, kind: "repeat", attempt: 2, max_attempts: 4, parent_id: root, root_id: root }); // валідний нащадок
    const bad: Record<string, unknown>[] = [
      { status: "done" },
      { kind: "ping" },
      { attempt: 5, max_attempts: 4 },
      { attempt: 3, max_attempts: 2 },
      { kind: "repeat", fire_at: NOW + 1 },
      { kind: "repeat", attempt: 2, max_attempts: 4, parent_id: root, fire_at: NOW + 2 }, // parent без root
      { status: "sent", fire_at: NOW + 3 },
      { status: "pending", sent_at: NOW, sent_as: "single", fire_at: NOW + 4 },
      { status: "sent", sent_at: NOW, fire_at: NOW + 5 }, // sent_at без sent_as
      { status: "sent", sent_at: NOW, sent_as: "push", fire_at: NOW + 6 },
      { item_id: null, fire_at: NOW + 7 },
      { variant_idx: -1, fire_at: NOW + 8 },
    ];
    for (const b of bad) await expect(rawInsert({ ...base, ...b }), JSON.stringify(b)).rejects.toThrow();
    await expect(rawInsert({ user_id: u, item_id: null, kind: "digest_morning" })).resolves.toBeGreaterThan(0);
    const idx = (await rows("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%' ORDER BY name")).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["ix_rem_due", "ix_rem_item", "ix_rem_user_sent", "ux_rem_root", "ux_rem_child", "ix_items_status_due", "ux_ledger_done"]));
  });

  it("2.1.c: прямий дубль кореня (item, kind, fire_at) і другий нащадок одного батька → конфлікт у БД", async () => {
    const u = await user();
    const i = await newItem(u, { dueAt: NOW });
    const root = await rawInsert({ user_id: u, item_id: i, max_attempts: 4, status: "sent", sent_at: NOW, sent_as: "single" });
    await expect(rawInsert({ user_id: u, item_id: i })).rejects.toThrow(/UNIQUE/);
    await rawInsert({ user_id: u, item_id: i, kind: "repeat", attempt: 2, max_attempts: 4, parent_id: root, root_id: root, fire_at: NOW + 1 });
    await expect(
      rawInsert({ user_id: u, item_id: i, kind: "repeat", attempt: 2, max_attempts: 4, parent_id: root, root_id: root, fire_at: NOW + 2 }),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("2.1.g: видалення запису каскадом прибирає його рядки (pending і нащадок)", async () => {
    const u = await user();
    const i = await newItem(u, { dueAt: NOW });
    const root = await rawInsert({ user_id: u, item_id: i, max_attempts: 4, status: "sent", sent_at: NOW, sent_as: "single" });
    await rawInsert({ user_id: u, item_id: i, kind: "repeat", attempt: 2, max_attempts: 4, parent_id: root, root_id: root, fire_at: NOW + 1 });
    await rawInsert({ user_id: u, item_id: i, kind: "eve_before", fire_at: NOW + 2 });
    expect(await rows()).toHaveLength(3);
    await DB.prepare("DELETE FROM items WHERE id = ?").bind(i).run();
    expect(await rows()).toHaveLength(0);
  });
});

describe("S2.1 планувальник", () => {
  it("2.1.b: important → один due (fire_at=T, attempt 1, max 4, pending); normal → max 1", async () => {
    const u = await user();
    const T = NOW + 3_600_000;
    const imp = await newItem(u, { dueAt: T, priority: "important" });
    const norm = await newItem(u, { dueAt: T });
    expect(await planReminders(db(), now())).toEqual({ items: 2, rows: 2 });
    const [a] = await listForItem(u, db(), imp);
    expect(a).toMatchObject({ kind: "due", fire_at: T, attempt: 1, max_attempts: 4, status: "pending", parent_id: null, root_id: null, lease_until: null, sent_at: null, created_at: NOW });
    expect((await listForItem(u, db(), norm)).map((r) => [r.kind, r.max_attempts])).toEqual([["due", 1]]);
  });

  it("2.1.c: ідемпотентність — планувальник двічі поспіль і двічі одночасно, schedule того самого списку двічі", async () => {
    const u = await user();
    await newItem(u, { dueAt: NOW + 3_600_000, priority: "important" });
    const ev = await newItem(u, { kind: "event", dueAt: at("2026-11-21T08:00:00Z") });
    await Promise.all([planReminders(db(), now()), planReminders(db(), now())]);
    await planReminders(db(), now());
    expect(await rows()).toHaveLength(3); // due + eve_before + leave_now
    // повторна постановка того самого (⏰ подвійним тапом, два прогони) — не помилка й не дубль
    const list = [{ kind: "leave_now" as const, fireAt: at("2026-11-21T07:45:00Z"), maxAttempts: 4 }];
    expect(await schedule(u, db(), ev, list, now())).toBe(0);
    await Promise.all([schedule(u, db(), ev, list, now()), schedule(u, db(), ev, list, now())]);
    expect(await rows()).toHaveLength(3);
  });

  it("2.1.c / S2.7.g: скасований корінь не блокує постановку в ту саму мить", async () => {
    const u = await user();
    const ev = await newItem(u, { kind: "event", dueAt: at("2026-11-21T08:00:00Z") });
    await planReminders(db(), now());
    const leave = (await listForItem(u, db(), ev)).find((r) => r.kind === "leave_now")!;
    await DB.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?").bind(leave.id).run();
    expect(await schedule(u, db(), ev, [{ kind: "leave_now", fireAt: leave.fire_at, maxAttempts: 4 }], now())).toBe(1);
    const leaves = (await listForItem(u, db(), ev)).filter((r) => r.kind === "leave_now").map((r) => r.status);
    expect(leaves.sort()).toEqual(["cancelled", "pending"]);
  });

  it("2.1.d: all_day 21.11 при morning_at 09:00 → 07:00Z; 29.03 (перехід) → 06:00Z, без втрати й дубля", async () => {
    vi.setSystemTime(at("2026-03-01T10:00:00Z"));
    const u = await user();
    const nov = await newItem(u, { dueAt: at("2026-11-20T22:00:00Z"), allDay: true });
    const mar = await newItem(u, { dueAt: at("2026-03-28T22:00:00Z"), allDay: true });
    await planReminders(db(), now());
    await planReminders(db(), now());
    expect((await listForItem(u, db(), nov)).map((r) => r.fire_at)).toEqual([at("2026-11-21T07:00:00Z")]);
    expect((await listForItem(u, db(), mar)).map((r) => r.fire_at)).toEqual([at("2026-03-29T06:00:00Z")]);
  });

  it("перехід на літній час (остання неділя березня): подія 29.03 10:00 — eve і leave рівно по одному, коректний UTC", async () => {
    vi.setSystemTime(at("2026-03-28T10:00:00Z"));
    const u = await user();
    const ev = await newItem(u, { kind: "event", dueAt: at("2026-03-29T07:00:00Z") });
    for (const t of ["2026-03-28T10:00:00Z", "2026-03-28T23:00:00Z", "2026-03-29T01:00:00Z", "2026-03-29T06:00:00Z"]) {
      vi.setSystemTime(at(t)); // тики до, під час і після «стрибка» 03:00 → 04:00
      await planReminders(db(), now());
    }
    expect((await listForItem(u, db(), ev)).map((r) => [r.kind, new Date(r.fire_at).toISOString()])).toEqual([
      ["eve_before", "2026-03-28T18:00:00.000Z"], // 20:00 зимового
      ["leave_now", "2026-03-29T06:45:00.000Z"], // 09:45 літнього
    ]);
  });

  it("2.1.e: fire_at = now − 60 с створюється; старше LATE_MS — ні, але запис позначено planned_at", async () => {
    const u = await user();
    const fresh = await newItem(u, { dueAt: NOW - 60_000 });
    const old = await newItem(u, { dueAt: NOW - LATE_MS - 1 });
    await planReminders(db(), now());
    expect(await listForItem(u, db(), fresh)).toHaveLength(1);
    expect(await listForItem(u, db(), old)).toHaveLength(0);
    expect(await plannedAt(old)).toBe(NOW);
  });

  it("2.1.f: done/released/без due_at → нічого; опрацьований запис не плануються вдруге (скасоване не відроджується)", async () => {
    const u = await user();
    const done = await newItem(u, { dueAt: NOW + 60_000 });
    const rel = await newItem(u, { dueAt: NOW + 60_000 });
    await newItem(u, { kind: "note", title: "ідея" });
    await DB.prepare("UPDATE items SET status = 'done', done_at = ? WHERE id = ?").bind(NOW, done).run();
    await DB.prepare("UPDATE items SET status = 'released' WHERE id = ?").bind(rel).run();
    const live = await newItem(u, { dueAt: NOW + 60_000 });
    await planReminders(db(), now());
    expect(await rows()).toHaveLength(1);
    expect(await answer(u, db(), live)).toBe(1);
    await planReminders(db(), now());
    expect((await rows()).map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("2.1.h: ізоляція — чужий item_id не створює й не змінює нічого", async () => {
    const u = await user(111);
    const other = await user(222);
    const i = await newItem(u, { dueAt: NOW + 60_000 });
    expect(await schedule(other, db(), i, [{ kind: "due", fireAt: NOW + 60_000, maxAttempts: 1 }], now())).toBe(0);
    expect(await planItem(other, db(), i, [{ kind: "due", fireAt: NOW + 60_000, maxAttempts: 1 }], now())).toBe(0);
    expect(await plannedAt(i)).toBeNull();
    expect(await rows()).toHaveLength(0);
    await planReminders(db(), now());
    expect(await answer(other, db(), i)).toBe(0);
    expect(await listForItem(other, db(), i)).toEqual([]);
    expect((await rows()).map((r) => [r.user_id, r.status])).toEqual([[u, "pending"]]);
  });

  it("2.1.i: 50 «мертвих» записів і один новий — за один тик новий має рядок, наступні тики їх не повертають", async () => {
    const u = await user();
    const batch = Array.from({ length: 50 }, (_, k) =>
      DB.prepare("INSERT INTO items (user_id, kind, title, source, due_at, all_day, created_at) VALUES (?, 'task', ?, 'text', ?, 1, ?)").bind(
        u, `старе ${k}`, at("2026-11-19T22:00:00Z"), NOW, // all_day сьогодні: 09:00 уже минуло
      ),
    );
    await DB.batch(batch);
    const fresh = await newItem(u, { dueAt: NOW + 600_000 });
    expect(await planReminders(db(), now())).toEqual({ items: 50, rows: 1 }); // LIMIT 50: новий не витіснено старими
    expect(await listForItem(u, db(), fresh)).toHaveLength(1);
    expect(await planReminders(db(), now())).toEqual({ items: 1, rows: 0 }); // останній «мертвий»
    expect((await rows("SELECT COUNT(*) AS n FROM items WHERE planned_at IS NULL"))[0]!.n).toBe(0);
    expect(await listUnplannedItems(db(), 50)).toEqual([]);
    expect(await planReminders(db(), now())).toEqual({ items: 0, rows: 0 });
  });

  it("2.1.j: leave_now поставлено відповіддю про дорогу ДО першого тику → планувальник додає eve_before, leave_now один", async () => {
    const u = await user();
    const ev = await newItem(u, { kind: "event", dueAt: at("2026-11-21T08:00:00Z") });
    await schedule(u, db(), ev, [{ kind: "leave_now", fireAt: at("2026-11-21T07:15:00Z"), maxAttempts: 4 }], now()); // tr 30
    await planReminders(db(), now());
    expect((await listForItem(u, db(), ev)).map((r) => [r.kind, r.fire_at])).toEqual([
      ["eve_before", at("2026-11-20T18:00:00Z")],
      ["leave_now", at("2026-11-21T07:15:00Z")],
    ]);
  });

  it("cron: прогін (серце → пінг → нагадування → pending) планує записи", async () => {
    const u = await user();
    const i = await newItem(u, { dueAt: NOW + 120_000, priority: "important" });
    await runScheduled(baseEnv(), { now });
    expect((await listForItem(u, db(), i)).map((r) => [r.kind, r.max_attempts])).toEqual([["due", 4]]);
  });
});

describe("S2.3 оренда й S2.5.a гонка", () => {
  async function dueRows(userId: number, n: number, fireAt = NOW - 1_000) {
    const ids: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = await newItem(userId, { dueAt: fireAt });
      ids.push(await rawInsert({ user_id: userId, item_id: i, fire_at: fireAt + k }));
    }
    return ids;
  }

  it("два claimDue паралельно → кожен рядок захоплено рівно один раз; статус лишається pending з орендою", async () => {
    const u = await user();
    const ids = await dueRows(u, 12);
    const [a, b] = await Promise.all([claimDueReminders(db(), now(), CLAIM_LIMIT), claimDueReminders(db(), now(), CLAIM_LIMIT)]);
    const got = [...a, ...b].map((r) => r.id);
    expect(got.sort((x, y) => x - y)).toEqual(ids);
    expect(new Set(got).size).toBe(got.length);
    expect([...a, ...b].every((r) => r.status === "pending" && r.lease_until === NOW + LEASE_MS)).toBe(true);
    expect(await claimDueReminders(db(), now(), CLAIM_LIMIT)).toEqual([]); // оренда тримає й третій прогін
  });

  it("оренда минула (процес упав між claim і відправкою) → рядок підбирається знову, не губиться", async () => {
    const u = await user();
    const [id] = await dueRows(u, 1);
    expect((await claimDueReminders(db(), now(), CLAIM_LIMIT)).map((r) => r.id)).toEqual([id]);
    vi.setSystemTime(NOW + LEASE_MS - 1);
    expect(await claimDueReminders(db(), now(), CLAIM_LIMIT)).toEqual([]);
    vi.setSystemTime(NOW + LEASE_MS);
    expect((await claimDueReminders(db(), now(), CLAIM_LIMIT)).map((r) => r.id)).toEqual([id]);
  });

  it("claim бере лише pending з fire_at ≤ now, за fire_at, у межах limit; виключені користувачі (тиша) не беруться", async () => {
    const u = await user(111);
    const quiet = await user(222);
    const mine = await dueRows(u, 3);
    await dueRows(quiet, 2);
    const future = await newItem(u, { dueAt: NOW + 60_000 });
    await rawInsert({ user_id: u, item_id: future, fire_at: NOW + 60_000 });
    const sentItem = await newItem(u, { dueAt: NOW });
    await rawInsert({ user_id: u, item_id: sentItem, status: "sent", sent_at: NOW, sent_as: "single" });
    expect((await claimDueReminders(db(), now(), 2, [quiet])).map((r) => r.id)).toEqual(mine.slice(0, 2));
    expect((await claimDueReminders(db(), now(), 50, [quiet])).map((r) => r.id)).toEqual(mine.slice(2));
    const q = await rows("SELECT lease_until FROM reminders WHERE user_id = ?", quiet);
    expect(q.map((r) => r.lease_until)).toEqual([null, null]); // тиша: рядків не торкаємось
  });

  it("answer скасовує всі pending запису (і орендовані), відправлені не чіпає; повтор — 0", async () => {
    const u = await user();
    const i = await newItem(u, { kind: "event", dueAt: at("2026-11-21T08:00:00Z") });
    await planReminders(db(), now());
    const sent = await rawInsert({ user_id: u, item_id: i, kind: "due", status: "sent", sent_at: NOW, sent_as: "single" });
    await DB.prepare("UPDATE reminders SET lease_until = ? WHERE kind = 'leave_now'").bind(NOW + LEASE_MS).run();
    expect(await answer(u, db(), i)).toBe(2);
    expect((await listForItem(u, db(), i)).map((r) => [r.kind, r.status, r.lease_until])).toEqual([
      ["due", "sent", null],
      ["eve_before", "cancelled", null],
      ["leave_now", "cancelled", null],
    ]);
    expect(await answer(u, db(), i)).toBe(0);
    expect(sent).toBeGreaterThan(0);
  });
});
