// Міграція 0006 (docs/spec/phase-4.md, S4.1): CHECK-и рутин (4.1.a), перебудова `reminders` без втрат (4.1.b),
// тригери `routine_inputs` (4.1.e). 4.1.b — на окремій базі MIG_DB: «0001–0005 + дані» → `0006`.
import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const DB = env.DB!;
const MIG = (env as unknown as { MIG_DB: D1Database }).MIG_DB;
const MIGRATIONS = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const T = Date.parse("2026-11-20T10:00:00Z");

const run = (db: D1Database, sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).run();
const all = async <R = Record<string, unknown>>(db: D1Database, sql: string, ...args: unknown[]) =>
  (await db.prepare(sql).bind(...args).all<R>()).results;
const seqOf = async (db: D1Database, name: string) =>
  (await db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").bind(name).first<{ seq: number }>())?.seq ?? null;

async function user(db: D1Database, tg: number): Promise<number> {
  return (await db.prepare("INSERT INTO users (tg_id, created_at, last_seen_at) VALUES (?, ?, ?) RETURNING id").bind(tg, T, T).first<{ id: number }>())!.id;
}

async function item(db: D1Database, userId: number, title = "Справа"): Promise<number> {
  return (await db
    .prepare("INSERT INTO items (user_id, kind, title, source, due_at, created_at) VALUES (?, 'task', ?, 'text', ?, ?) RETURNING id")
    .bind(userId, title, T + 3_600_000, T)
    .first<{ id: number }>())!.id;
}

const R_COLS = "user_id, kind, title, times, days_mask, escalate, active, created_at, updated_at";
async function routine(db: D1Database, userId: number, over: Partial<Record<string, unknown>> = {}): Promise<number> {
  const v = { kind: "med", title: "Вітамін D", times: '["08:00","20:00"]', days_mask: 127, escalate: 1, active: 1, ...over };
  return (await db
    .prepare(`INSERT INTO routines (${R_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(userId, v.kind, v.title, v.times, v.days_mask, v.escalate, v.active, T, T)
    .first<{ id: number }>())!.id;
}

async function log(db: D1Database, userId: number, routineId: number, at: number, status: string, answeredAt: number | null) {
  return run(db, "INSERT INTO routine_logs (user_id, routine_id, scheduled_for, status, answered_at, created_at) VALUES (?, ?, ?, ?, ?, ?)", userId, routineId, at, status, answeredAt, T);
}

// Рядок reminders: усі поля явно, щоб CHECK перевірявся саме тим, що тестується.
const REM = "user_id, item_id, kind, fire_at, attempt, max_attempts, status, parent_id, root_id, created_at, routine_id, slot_at";
async function rem(db: D1Database, v: { user: number; item?: number | null; kind: string; routine?: number | null; slot?: number | null; status?: string; parent?: number | null }) {
  return db
    .prepare(`INSERT INTO reminders (${REM}) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(v.user, v.item ?? null, v.kind, T, v.status ?? "pending", v.parent ?? null, v.parent ?? null, T, v.routine ?? null, v.slot ?? null)
    .first<{ id: number }>();
}

describe("S4.1 схема 0006", () => {
  let u: number;
  beforeEach(async () => {
    for (const t of ["points_ledger", "routine_logs", "reminders", "routine_drafts", "routine_inputs", "routines", "items", "capture_fixes", "captures", "users"])
      await run(DB, `DELETE FROM ${t}`);
    u = await user(DB, 111);
  });

  it("4.1.a: routines — сміття відхилено, коректне проходить", async () => {
    await expect(routine(DB, u)).resolves.toBeGreaterThan(0);
    await expect(routine(DB, u, { title: "х".repeat(64), times: '["00:00","01:00","02:00","03:00","04:00","05:00"]', days_mask: 1, escalate: 0, kind: "habit" })).resolves.toBeGreaterThan(0);
    for (const bad of [
      { kind: "pill" },
      { title: "х".repeat(65) },
      { title: "Вітамін\nD" },
      { title: "" },
      { times: "[]" },
      { times: "x" },
      { times: '"08:00"' },
      { times: JSON.stringify(["01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00"]) },
      { days_mask: 0 },
      { days_mask: 128 },
      { active: 2 },
      { escalate: 2 },
    ])
      await expect(routine(DB, u, bad), JSON.stringify(bad)).rejects.toThrow();
  });

  it("4.1.a: routine_logs — статус, answered_at і UNIQUE слота", async () => {
    const r = await routine(DB, u);
    await expect(log(DB, u, r, T, "late", T)).rejects.toThrow();
    await expect(log(DB, u, r, T, "missed", T)).rejects.toThrow(); // missed з answered_at
    await expect(log(DB, u, r, T, "taken", null)).rejects.toThrow(); // taken без answered_at
    await expect(log(DB, u, r, T, "skipped", null)).rejects.toThrow();
    await log(DB, u, r, T, "taken", T);
    await log(DB, u, r, T + 1, "missed", null);
    await expect(log(DB, u, r, T, "skipped", T)).rejects.toThrow(); // другий рядок того ж слота
    expect(await all(DB, "SELECT status FROM routine_logs ORDER BY scheduled_for")).toEqual([{ status: "taken" }, { status: "missed" }]);
  });

  it("4.1.a: reminders — форма рядка рутини й один pending-корінь слота", async () => {
    const r = await routine(DB, u);
    const i = await item(DB, u);
    await expect(rem(DB, { user: u, kind: "due", item: i, routine: r, slot: T })).rejects.toThrow(); // item_id і routine_id разом
    await expect(rem(DB, { user: u, kind: "routine" })).rejects.toThrow(); // routine без routine_id
    await expect(rem(DB, { user: u, kind: "routine", routine: r })).rejects.toThrow(); // routine_id без slot_at
    await expect(rem(DB, { user: u, kind: "routine", slot: T })).rejects.toThrow(); // slot_at без routine_id
    await expect(rem(DB, { user: u, kind: "due" })).rejects.toThrow(); // due без item_id
    await expect(rem(DB, { user: u, kind: "eve_before" })).rejects.toThrow();
    await expect(rem(DB, { user: u, kind: "digest_morning", routine: r, slot: T })).rejects.toThrow();
    await expect(rem(DB, { user: u, kind: "timer", routine: r, slot: T })).rejects.toThrow();
    await expect(rem(DB, { user: u, kind: "nope" })).rejects.toThrow();

    const root = (await rem(DB, { user: u, kind: "routine", routine: r, slot: T }))!.id;
    await expect(rem(DB, { user: u, kind: "routine", routine: r, slot: T })).rejects.toThrow(); // другий pending-корінь слота
    await expect(rem(DB, { user: u, kind: "routine", routine: r, slot: T + 1 })).resolves.toBeTruthy(); // інший слот
    await expect(rem(DB, { user: u, kind: "repeat", routine: r, slot: T, parent: root })).resolves.toBeTruthy(); // повтор слота
    await expect(rem(DB, { user: u, kind: "routine", routine: r, slot: T, status: "cancelled" })).resolves.toBeTruthy(); // не pending
    await expect(rem(DB, { user: u, kind: "timer" })).resolves.toBeTruthy(); // timer як у 0004
    await expect(rem(DB, { user: u, kind: "timer", item: i })).resolves.toBeTruthy();
    await expect(rem(DB, { user: u, kind: "due", item: i })).resolves.toBeTruthy();
  });

  it("4.1.a: points_ledger — routine_log_id лише з done і одне «✅» на слот", async () => {
    const r = await routine(DB, u);
    await log(DB, u, r, T, "taken", T);
    const lid = (await DB.prepare("SELECT id FROM routine_logs").first<{ id: number }>())!.id;
    const pts = (reason: string, logId: number | null, itemId: number | null = null) =>
      run(DB, "INSERT INTO points_ledger (user_id, delta, reason, item_id, routine_log_id, created_at) VALUES (?, 10, ?, ?, ?, ?)", u, reason, itemId, logId, T);
    await expect(pts("capture", lid)).rejects.toThrow();
    await expect(pts("done", lid, await item(DB, u))).rejects.toThrow(); // done рутини не несе item_id
    await pts("done", lid);
    await expect(pts("done", lid)).rejects.toThrow(); // другий done того ж слота
    expect(await all(DB, "SELECT delta FROM points_ledger")).toEqual([{ delta: 10 }]);
  });

  it("4.1.e: routine_inputs забирає update_id у captures і capture_fixes", async () => {
    const other = await user(DB, 222);
    await run(DB, "INSERT INTO routine_inputs (user_id, tg_update_id, created_at) VALUES (?, 77, ?)", u, T);
    await expect(run(DB, "INSERT INTO routine_inputs (user_id, tg_update_id, created_at) VALUES (?, 77, ?)", u, T)).rejects.toThrow(); // PK
    const cap = (who: number, upd: number) => run(DB, "INSERT INTO captures (user_id, tg_update_id, source, raw_text, status, created_at) VALUES (?, ?, 'text', 'x', 'parsed', ?)", who, upd, T);
    const fix = (who: number, upd: number) => run(DB, "INSERT INTO capture_fixes (user_id, tg_update_id, capture_id, created_at) VALUES (?, ?, ?, ?)", who, upd, capId, T);
    await expect(cap(u, 77)).rejects.toThrow(/routine input/);
    await cap(u, 78);
    await cap(other, 77);
    const capId = (await DB.prepare("SELECT id FROM captures WHERE user_id = ? AND tg_update_id = 78").bind(u).first<{ id: number }>())!.id;
    await expect(fix(u, 77)).rejects.toThrow(/routine input/);
    await fix(u, 79);
    expect(await all(DB, "SELECT user_id, tg_update_id FROM captures ORDER BY id")).toEqual([
      { user_id: u, tg_update_id: 78 },
      { user_id: other, tg_update_id: 77 },
    ]);
  });
});

// ── 4.1.b: перебудова reminders на даних ─────────────────────────────────────────────────────────────────

// Порожня MIG_DB перед кожним тестом (незалежно від ізоляції сховища між тестами).
async function resetMig(): Promise<void> {
  // FTS5: спершу віртуальні таблиці — їхні тіньові (`items_fts_config` тощо) зникають разом з ними.
  const virt = await all<{ name: string }>(MIG, "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL%'");
  for (const v of virt) await run(MIG, `DROP TABLE "${v.name}"`);
  const objs = await all<{ type: string; name: string }>(
    MIG,
    "SELECT type, name FROM sqlite_master WHERE type IN ('table','trigger','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid DESC",
  );
  if (objs.length === 0) return;
  await MIG.batch([
    MIG.prepare("PRAGMA defer_foreign_keys = on"),
    ...objs.filter((o) => o.type === "trigger").map((o) => MIG.prepare(`DROP TRIGGER "${o.name}"`)),
    ...objs.filter((o) => o.type !== "trigger").map((o) => MIG.prepare(`DROP ${o.type.toUpperCase()} "${o.name}"`)),
  ]);
}

const OLD_COLS =
  "id, user_id, item_id, kind, fire_at, attempt, max_attempts, status, parent_id, root_id, lease_until, sent_at, sent_as, tg_message_id, variant_idx, created_at";

// Засів стану prod 0005: рядки всіх видів, ланцюг, sent з tg_message_id, cancelled; найбільший id видалено («Не так»).
async function seedOld(): Promise<{ u: number; i1: number; i2: number }> {
  const u = await user(MIG, 111);
  const i1 = await item(MIG, u, "Корм коту");
  const i2 = await item(MIG, u, "Лікар");
  const ins = (cols: string, ...vals: unknown[]) =>
    MIG.prepare(`INSERT INTO reminders (${cols}) VALUES (${vals.map(() => "?").join(", ")}) RETURNING id`).bind(...vals).first<{ id: number }>();
  const C = "user_id, item_id, kind, fire_at, attempt, max_attempts, status, parent_id, root_id, lease_until, sent_at, sent_as, tg_message_id, variant_idx, created_at";
  const due = (await ins(C, u, i1, "due", T, 1, 4, "sent", null, null, null, T + 5, "single", 555, 2, T - 9))!.id;
  const r2 = (await ins(C, u, i1, "repeat", T + 300_000, 2, 4, "sent", due, due, null, T + 300_100, "summary", 556, 0, T + 6))!.id;
  await ins(C, u, i1, "repeat", T + 1_200_000, 3, 4, "pending", r2, due, T + 1_200_090, null, null, null, null, T + 300_200);
  await ins(C, u, i2, "eve_before", T - 86_400_000, 1, 1, "cancelled", null, null, null, null, null, null, null, T - 99);
  await ins(C, u, i2, "leave_now", T + 7_200_000, 1, 1, "answered", null, null, null, T + 7_200_005, "single", 557, 1, T - 50);
  await ins(C, u, null, "digest_morning", T - 3_600_000, 1, 1, "sent", null, null, null, T - 3_599_000, "single", 558, 1, T - 4_000_000);
  await ins(C, u, null, "digest_evening", T + 39_600_000, 1, 1, "pending", null, null, null, null, null, null, null, T);
  await ins(C, u, null, "timer", T + 60_000, 1, 1, "pending", null, null, null, null, null, null, null, T);
  const gone = (await ins(C, u, i2, "due", T + 9_000_000, 1, 4, "pending", null, null, null, null, null, null, null, T))!.id;
  await run(MIG, "DELETE FROM reminders WHERE id = ?", gone); // каскад «Не так»: seq > max(id)
  return { u, i1, i2 };
}

describe("4.1.b перебудова reminders у 0006", () => {
  beforeEach(async () => {
    await resetMig();
    await applyD1Migrations(MIG, MIGRATIONS.filter((m) => m.name < "0006"));
  });

  it("кожне поле кожного рядка, лічильник, індекси, тригер і каскади — як до", async () => {
    const { u, i1 } = await seedOld();
    const before = await all(MIG, `SELECT ${OLD_COLS} FROM reminders ORDER BY id`);
    const seqBefore = await seqOf(MIG, "reminders");
    const maxBefore = Math.max(...before.map((r) => r.id as number));
    expect(before).toHaveLength(8);
    expect(seqBefore).toBe(maxBefore + 1); // засів справді має «дірку» на кінці

    await applyD1Migrations(MIG, MIGRATIONS);
    expect(await all(MIG, "SELECT name FROM d1_migrations WHERE name LIKE '0006%'")).toHaveLength(1);

    expect(await all(MIG, `SELECT ${OLD_COLS} FROM reminders ORDER BY id`)).toEqual(before);
    expect(await all(MIG, "SELECT COUNT(*) AS n FROM reminders WHERE routine_id IS NOT NULL OR slot_at IS NOT NULL")).toEqual([{ n: 0 }]);
    expect(await seqOf(MIG, "reminders")).toBe(seqBefore);
    expect(await seqOf(MIG, "reminders_new")).toBeNull();
    expect(await all(MIG, "SELECT name FROM sqlite_master WHERE name = 'reminders_new'")).toEqual([]);
    expect(await all(MIG, "PRAGMA foreign_key_check")).toEqual([]);

    // Самопосилання вказують на нову reminders, а не на перейменовану чи стару.
    const fks = await all<{ table: string; from: string }>(MIG, "SELECT \"table\", \"from\" FROM pragma_foreign_key_list('reminders') ORDER BY \"from\"");
    expect(fks).toEqual([
      { table: "items", from: "item_id" },
      { table: "reminders", from: "parent_id" },
      { table: "reminders", from: "root_id" },
      { table: "routines", from: "routine_id" },
      { table: "users", from: "user_id" },
    ]);

    const names = (await all<{ name: string }>(MIG, "SELECT name FROM sqlite_master WHERE tbl_name = 'reminders' AND type IN ('index','trigger') AND name NOT LIKE 'sqlite_%'")).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(["ix_rem_due", "ix_rem_item", "ix_rem_user_sent", "ux_rem_root", "ux_rem_child", "ux_rem_digest_pending", "trg_rem_digest_shape", "ux_rem_routine_pending"]),
    );

    // Перший новий рядок — id більший за будь-який колишній, і видалений id не повторюється.
    const fresh = await MIG.prepare(`INSERT INTO reminders (user_id, item_id, kind, fire_at, attempt, max_attempts, created_at) VALUES (?, ?, 'due', ?, 1, 1, ?) RETURNING id`)
      .bind(u, i1, T + 99, T)
      .first<{ id: number }>();
    expect(fresh!.id).toBe(seqBefore! + 1);

    // Тригер форми огляду живий.
    await expect(run(MIG, "INSERT INTO reminders (user_id, item_id, kind, fire_at, attempt, max_attempts, created_at) VALUES (?, ?, 'digest_weekly', ?, 1, 1, ?)", u, i1, T, T)).rejects.toThrow(/digest row shape/);
    await expect(run(MIG, "INSERT INTO reminders (user_id, kind, fire_at, attempt, max_attempts, created_at) VALUES (?, 'digest_evening', ?, 1, 1, ?)", u, T, T)).rejects.toThrow(); // ux_rem_digest_pending

    // ON DELETE CASCADE: корінь → нащадки; запис → його рядки.
    const root = before[0]!.id as number;
    await run(MIG, "DELETE FROM reminders WHERE id = ?", root);
    expect(await all(MIG, "SELECT COUNT(*) AS n FROM reminders WHERE root_id = ? OR id = ?", root, root)).toEqual([{ n: 0 }]);
    await run(MIG, "DELETE FROM items WHERE id = ?", i1);
    expect(await all(MIG, "SELECT COUNT(*) AS n FROM reminders WHERE item_id = ?", i1)).toEqual([{ n: 0 }]);
    expect(await all(MIG, "SELECT kind FROM reminders ORDER BY id")).toEqual([
      { kind: "eve_before" }, { kind: "leave_now" }, { kind: "digest_morning" }, { kind: "digest_evening" }, { kind: "timer" },
    ]);
  });

  it("порожня reminders (нова база): 0006 проходить, лічильника не вигадує", async () => {
    await applyD1Migrations(MIG, MIGRATIONS);
    expect(await seqOf(MIG, "reminders")).toBeNull();
    expect(await all(MIG, "PRAGMA foreign_key_check")).toEqual([]);
  });
});
