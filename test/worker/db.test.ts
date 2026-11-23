import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index";
import { ensureUser, getById, setVariantIdx } from "../../src/db/users";
import { NOW, baseEnv } from "./helpers";

const DB = env.DB!;
beforeEach(async () => {
  await DB.prepare("DELETE FROM users").run();
});

const insertUser = (cols: string, vals: unknown[]) =>
  DB.prepare(`INSERT INTO users (${cols}, created_at, last_seen_at) VALUES (${vals.map(() => "?").join(",")}, 1, 1)`)
    .bind(...vals)
    .run();

const names = async (sql: string) => (await DB.prepare(sql).all<{ name: string }>()).results.map((r) => r.name);

describe("S0.4 міграція 0001", () => {
  it("0.4.a: users і heartbeat зі спеки; повторний прогін міграцій без помилки; таблиці Фази 0 на місці", async () => {
    expect(await names("SELECT name FROM pragma_table_info('users') ORDER BY cid")).toEqual([
      "id", "tg_id", "tz", "quiet_from", "quiet_to", "morning_at", "evening_at", "weekly_dow",
      "pause_until", "greet_variant_idx", "soon_variant_idx", "created_at", "last_seen_at", "today_variant_idx", // 0003: ALTER TABLE ADD COLUMN — у кінці
      "ack_ok_idx", "ack_later_idx", "ack_rel_idx", "ack_pause_idx", "ack_resume_idx", "ack_travel_idx", // 0004 (S2.10.b)
      "warm_at", "warm_variant_idx", "ack_today_idx", // 0005 (S3.1)
      "ack_taken_idx", "ack_skip_idx", // 0006 (S4.1)
    ]);
    expect(await names("SELECT name FROM pragma_table_info('heartbeat') ORDER BY cid")).toEqual([
      "key", "last_run_at", "last_ping_ok_at",
    ]);
    const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    await expect(applyD1Migrations(DB, migrations)).resolves.toBeUndefined();
    const tables = await names(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
    );
    // з міграцій 0002–0003 з'явились таблиці Фази 1 (їх склад перевіряє items.test.ts, 1.1.a)
    expect(tables).toEqual(expect.arrayContaining(["heartbeat", "users", "points_ledger"]));
  });

  it("0.4.b: CHECK-и й UNIQUE відхиляють сміття", async () => {
    await insertUser("tg_id", [1]);
    await expect(insertUser("tg_id, quiet_from", [2, 1440])).rejects.toThrow();
    await expect(insertUser("tg_id, weekly_dow", [3, 0])).rejects.toThrow();
    await expect(insertUser("tg_id, weekly_dow", [3, 8])).rejects.toThrow();
    await expect(insertUser("tg_id", [1])).rejects.toThrow(); // повторний tg_id
    await expect(insertUser("tg_id, tz", [4, ""])).rejects.toThrow();
    await expect(insertUser("tg_id, greet_variant_idx", [5, -1])).rejects.toThrow();
    await expect(DB.prepare("INSERT INTO heartbeat (key, last_run_at) VALUES ('', 1)").run()).rejects.toThrow();
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n).toBe(1);
  });
});

describe("src/db/users", () => {
  it("ensureUser: upsert за tg_id; getById повертає того самого", async () => {
    const db = openDb(baseEnv());
    const a = await ensureUser(77, db, NOW);
    const b = await ensureUser(77, db, NOW + 5);
    expect(b.id).toBe(a.id);
    expect(b.last_seen_at).toBe(NOW + 5);
    expect(b.created_at).toBe(NOW);
    expect((await getById(a.id, db))?.tg_id).toBe(77);
    expect(await getById(a.id + 1000, db)).toBeNull();
  });

  it("setVariantIdx змінює лише свій стовпець і лише свого користувача", async () => {
    const db = openDb(baseEnv());
    const a = await ensureUser(1, db, NOW);
    const b = await ensureUser(2, db, NOW);
    await setVariantIdx(a.id, "soon", 2, db);
    expect(await getById(a.id, db)).toMatchObject({ soon_variant_idx: 2, greet_variant_idx: null });
    expect(await getById(b.id, db)).toMatchObject({ soon_variant_idx: null });
  });
});
