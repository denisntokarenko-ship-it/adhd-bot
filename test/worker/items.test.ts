import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemClock } from "../../src/clock";
import { countToday, log } from "../../src/db/aiCalls";
import { openDb } from "../../src/db/index";
import { create, getById, listOpen, search, setStatus, update } from "../../src/db/items";
import { toMatchQuery } from "../../src/fts";
import { ensureUser } from "../../src/db/users";
import { NOW, baseEnv } from "./helpers";

const DB = env.DB!;
const db = () => openDb(baseEnv());
const KYIV = "Europe/Kyiv";

beforeEach(async () => {
  // від дочірніх до батьківських: FK
  for (const t of ["points_ledger", "ai_calls", "items", "capture_fixes", "captures", "users"]) await DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => vi.useRealTimers());

const newUser = async (tgId: number) => (await ensureUser(tgId, db(), NOW)).id;
const note = (title: string, extra: Partial<Parameters<typeof create>[2]> = {}) =>
  ({ kind: "note", title, source: "text", ...extra }) as Parameters<typeof create>[2];

const names = async (sql: string) => (await DB.prepare(sql).all<{ name: string }>()).results.map((r) => r.name);

describe("S1.1 міграція 0002", () => {
  it("1.1.a: таблиці, індекси й тригери зі спеки; повторний прогін без помилки; points_ledger з'явився в 0003 (1.5); parent_id ще немає", async () => {
    const tables = await names(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' AND name NOT LIKE 'items_fts_%' ORDER BY name",
    );
    expect(tables).toEqual(["ai_calls", "capture_fixes", "captures", "heartbeat", "items", "items_fts", "points_ledger", "reminders", "users"]); // reminders — 0004 (2.1)
    const indexes = await names("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ix_%' ORDER BY name");
    expect(indexes).toEqual(["ix_ai_calls_user_day", "ix_captures_pending", "ix_items_capture", "ix_items_status_due", "ix_items_user_status_due", "ix_ledger_user", "ix_rem_due", "ix_rem_item", "ix_rem_user_sent"]);
    const triggers = await names("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name");
    expect(triggers).toEqual(["items_fts_ad", "items_fts_ai", "items_fts_au", "tg_captures_not_fix", "tg_fixes_not_capture"]);
    expect(await names("SELECT name FROM pragma_table_info('items') ORDER BY cid")).toEqual([
      "id", "user_id", "capture_id", "kind", "title", "body", "raw_text", "source", "due_at", "all_day",
      "priority", "status", "travel_min", "created_at", "done_at", "snooze_count", "travel_asked_at", "planned_at", // 0004
    ]);
    const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    await expect(applyD1Migrations(DB, migrations)).resolves.toBeUndefined();
  });
});

describe("S1.1.b: CHECK-и й UNIQUE відхиляють сміття (кожен окремо)", () => {
  const insertItem = (over: Record<string, unknown>) => {
    const row: Record<string, unknown> = { user_id: 1, kind: "task", title: "ok", source: "text", created_at: 1, ...over };
    const cols = Object.keys(row);
    return DB.prepare(`INSERT INTO items (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...Object.values(row))
      .run();
  };
  const insertCapture = (over: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      user_id: 1, tg_update_id: 1, source: "text", raw_text: "x", status: "parsed", created_at: 1, ...over,
    };
    const cols = Object.keys(row);
    return DB.prepare(`INSERT INTO captures (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...Object.values(row))
      .run();
  };
  const insertFix = (over: Record<string, unknown>) =>
    DB.prepare(
      "INSERT INTO capture_fixes (user_id, capture_id, tg_update_id, created_at) VALUES (?, (SELECT MIN(id) FROM captures), ?, 1)",
    )
      .bind(over.user_id ?? 1, over.tg_update_id ?? 50)
      .run();
  const insertAi = (over: Record<string, unknown>) => {
    const row: Record<string, unknown> = { user_id: 1, model: "m", purpose: "parse", ok: 1, created_at: 1, ...over };
    const cols = Object.keys(row);
    return DB.prepare(`INSERT INTO ai_calls (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...Object.values(row))
      .run();
  };

  beforeEach(async () => {
    await DB.prepare("INSERT INTO users (id, tg_id, created_at, last_seen_at) VALUES (1, 901, 1, 1)").run();
  });

  it("контрольний: коректні рядки проходять", async () => {
    await insertItem({});
    await insertCapture({});
    await insertAi({});
    await insertAi({ ok: 0, error: "timeout" });
  });

  it("межа title: рівно 200 символів проходить (1.2 обрізає до 200 з «…» — вужчий CHECK ламав би кожен довгий запис)", async () => {
    await insertItem({ title: "я".repeat(200) });
    await insertItem({ title: "я" }); // і нижня межа: 1 символ
  });

  it.each([
    ["kind='todo'", { kind: "todo" }],
    ["title=''", { title: "" }],
    ["title 201 символ", { title: "я".repeat(201) }],
    ["body 4001 символ", { body: "я".repeat(4001) }],
    ["source='sms'", { source: "sms" }],
    ["priority='urgent'", { priority: "urgent" }],
    ["status='archived'", { status: "archived" }],
    ["status='done' без done_at", { status: "done" }],
    ["done_at без status='done'", { done_at: 5 }],
    ["all_day=1 без due_at", { all_day: 1 }],
    ["all_day=2", { all_day: 2, due_at: 1 }],
    ["travel_min=601", { travel_min: 601 }],
    ["snooze_count=-1", { snooze_count: -1 }],
  ])("items: %s", async (_name, over) => {
    await expect(insertItem(over)).rejects.toThrow();
  });

  it("items: user_id без такого користувача (FK)", async () => {
    await expect(insertItem({ user_id: 999 })).rejects.toThrow();
  });

  it("captures: повторне (user_id, tg_update_id)", async () => {
    await insertCapture({});
    await expect(insertCapture({})).rejects.toThrow();
  });

  it.each([
    ["без raw_text і tg_file_id", { raw_text: null }],
    ["source='email'", { source: "email" }],
    ["pending без next_try_at", { status: "pending" }],
    ["parsed з next_try_at", { status: "parsed", next_try_at: 5 }],
    ["parse_attempts=7", { parse_attempts: 7 }],
    ["raw_text порожній", { raw_text: "" }],
  ])("captures: %s", async (_name, over) => {
    await expect(insertCapture(over)).rejects.toThrow();
  });

  it("captures: голосове без тексту, але з tg_file_id — можна (pending з next_try_at)", async () => {
    await insertCapture({ source: "voice", raw_text: null, tg_file_id: "f1", status: "pending", next_try_at: 9 });
  });

  it.each([
    ["ok=1 з error", { ok: 1, error: "http" }],
    ["ok=0 без error", { ok: 0 }],
    ["purpose поза переліком", { purpose: "chat" }],
    ["error поза переліком", { ok: 0, error: "oops" }],
  ])("ai_calls: %s", async (_name, over) => {
    await expect(insertAi(over)).rejects.toThrow();
  });

  describe("capture_fixes і captures ділять один простір update_id", () => {
    beforeEach(async () => {
      await insertCapture({ tg_update_id: 10 });
      await insertFix({ tg_update_id: 50 });
    });
    it("capture_fixes: повтор update_id у fixes", async () => {
      await expect(insertFix({ tg_update_id: 50 })).rejects.toThrow();
    });
    it("capture_fixes: update_id уже є в captures", async () => {
      await expect(insertFix({ tg_update_id: 10 })).rejects.toThrow();
    });
    it("captures: update_id уже є в capture_fixes", async () => {
      await expect(insertCapture({ tg_update_id: 50 })).rejects.toThrow();
    });
  });
});

describe("src/db/items: ізоляція користувачів", () => {
  it("1.1.e: чужий userId не бачить запис — getById, listOpen, search", async () => {
    const a = await newUser(1);
    const b = await newUser(2);
    const item = await create(a, db(), note("Купити молоко"), NOW);
    expect(await getById(a, db(), item.id)).toMatchObject({ id: item.id, title: "Купити молоко" });
    expect(await getById(b, db(), item.id)).toBeNull();
    expect(await listOpen(b, db())).toEqual([]);
    expect(await search(b, db(), "молоко")).toEqual([]);
    expect(await search(a, db(), "молоко")).toHaveLength(1);
  });

  it("чужий userId не змінює запис: update і setStatus → null, рядок цілий", async () => {
    const a = await newUser(1);
    const b = await newUser(2);
    const item = await create(a, db(), note("Лікар"), NOW);
    expect(await update(b, db(), item.id, { title: "Зламано" })).toBeNull();
    expect(await setStatus(b, db(), item.id, "done", NOW + 1)).toBeNull();
    expect(await getById(a, db(), item.id)).toMatchObject({ title: "Лікар", status: "open", done_at: null });
  });

  it("однакове слово у двох користувачів: пошук віддає кожному лише його", async () => {
    const a = await newUser(1);
    const b = await newUser(2);
    const ia = await create(a, db(), note("Лікар вранці"), NOW);
    const ib = await create(b, db(), note("Лікар увечері"), NOW);
    expect((await search(a, db(), "лікар")).map((i) => i.id)).toEqual([ia.id]);
    expect((await search(b, db(), "лікар")).map((i) => i.id)).toEqual([ib.id]);
  });
});

describe("src/db/items: життєвий цикл", () => {
  it("create → поля за замовчуванням; update міняє лише передане; патч без полів — без змін", async () => {
    const u = await newUser(1);
    const item = await create(u, db(), { kind: "task", title: "Подзвонити мамі", source: "voice", rawText: "подзвонити мамі" }, NOW);
    expect(item).toMatchObject({
      status: "open", priority: "normal", all_day: 0, due_at: null, done_at: null, snooze_count: 0, created_at: NOW,
      raw_text: "подзвонити мамі", body: null,
    });
    const upd = await update(u, db(), item.id, { dueAt: NOW + 1000, priority: "important", allDay: true });
    expect(upd).toMatchObject({ due_at: NOW + 1000, priority: "important", all_day: 1, title: "Подзвонити мамі" });
    expect(await update(u, db(), item.id, {})).toMatchObject({ id: item.id, priority: "important" });
    expect(await update(u, db(), item.id + 999, { title: "x" })).toBeNull();
  });

  it("update: body → null очищає, undefined не чіпає", async () => {
    const u = await newUser(1);
    const item = await create(u, db(), note("Ідея", { body: "деталі" }), NOW);
    expect((await update(u, db(), item.id, { title: "Ідея 2" }))?.body).toBe("деталі");
    expect((await update(u, db(), item.id, { body: null }))?.body).toBeNull();
  });

  it("setStatus: done ставить done_at, open знімає; released не видаляє, а search знаходить released", async () => {
    const u = await newUser(1);
    const item = await create(u, db(), { kind: "task", title: "Запис до лікаря", source: "text" }, NOW);
    expect(await setStatus(u, db(), item.id, "done", NOW + 5)).toMatchObject({ status: "done", done_at: NOW + 5 });
    expect(await setStatus(u, db(), item.id, "open", NOW + 6)).toMatchObject({ status: "open", done_at: null });
    const released = await setStatus(u, db(), item.id, "released", NOW + 7);
    expect(released).toMatchObject({ status: "released", done_at: null });
    expect(await getById(u, db(), item.id)).not.toBeNull(); // не видалено
    expect(await listOpen(u, db())).toEqual([]); // але й не серед відкритих
    expect((await search(u, db(), "лікар")).map((i) => i.id)).toEqual([item.id]); // і пошук його бачить
  });

  it("listOpen: з датою за зростанням, потім без дати; лише open; limit", async () => {
    const u = await newUser(1);
    const nodate = await create(u, db(), note("без дати"), NOW);
    const late = await create(u, db(), note("пізно", { dueAt: NOW + 2000 }), NOW);
    const early = await create(u, db(), note("рано", { dueAt: NOW + 1000 }), NOW);
    const done = await create(u, db(), note("зроблено", { dueAt: NOW + 10 }), NOW);
    await setStatus(u, db(), done.id, "done", NOW);
    expect((await listOpen(u, db())).map((i) => i.id)).toEqual([early.id, late.id, nodate.id]);
    expect(await listOpen(u, db(), { limit: 1 })).toHaveLength(1);
  });
});

// Індекс FTS5 звіряється із таблицею items напряму: `search` робить JOIN з items, тож «привид» видаленого запису
// в індексі через нього не видно. integrity-check з rank=1 для external content порівнює індекс із вмістом.
async function expectIndexConsistent() {
  await expect(DB.prepare("INSERT INTO items_fts(items_fts, rank) VALUES ('integrity-check', 1)").run()).resolves.toBeDefined();
}
const rawHits = async (q: string) =>
  (await DB.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH ?").bind(q).all<{ rowid: number }>()).results.length;

describe("S1.1.c FTS5", () => {
  it("«лікар» знаходить «Запис до лікаря» (префікс) і «Лікар у п'ятницю»; регістр не важливий", async () => {
    const u = await newUser(1);
    const a = await create(u, db(), note("Запис до лікаря"), NOW);
    const b = await create(u, db(), note("Лікар у п'ятницю"), NOW);
    const ids = (await search(u, db(), "лікар")).map((i) => i.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect((await search(u, db(), "ЛІКАР")).map((i) => i.id).sort()).toEqual(ids);
    expect(await search(u, db(), "стоматолог")).toEqual([]);
  });

  it("апострофи ', ’ і ʼ (U+02BC) взаємозамінні в записі й у запиті (живий висновок про unicode61)", async () => {
    const u = await newUser(1);
    const ids = [
      (await create(u, db(), note("Зустріч п'ятниця"), NOW)).id,
      (await create(u, db(), note("Зустріч п’ятниця"), NOW)).id,
      (await create(u, db(), note("Зустріч пʼятниця"), NOW)).id,
    ].sort();
    for (const q of ["п'ятниця", "п’ятниця", "пʼятниця"]) {
      expect((await search(u, db(), q)).map((i) => i.id).sort()).toEqual(ids);
    }
  });

  it("й і ї не зливаються з и та і (remove_diacritics на кирилицю не діє)", async () => {
    const u = await newUser(1);
    await create(u, db(), note("їжа для кота"), NOW);
    expect(await search(u, db(), "іжа")).toEqual([]);
    expect(await search(u, db(), "їжа")).toHaveLength(1);
  });

  it("пошук іде і по body", async () => {
    const u = await newUser(1);
    const a = await create(u, db(), note("Ідея", { body: "розповісти про сантехніка" }), NOW);
    expect((await search(u, db(), "сантехнік")).map((i) => i.id)).toEqual([a.id]);
  });

  it("після UPDATE title старе слово не знаходить, нове знаходить; тіло теж переіндексується", async () => {
    const u = await newUser(1);
    const a = await create(u, db(), note("Лікар у п'ятницю", { body: "кабінет 5" }), NOW);
    await update(u, db(), a.id, { title: "Зубний" });
    expect(await search(u, db(), "лікар")).toEqual([]);
    expect((await search(u, db(), "зубний")).map((i) => i.id)).toEqual([a.id]);
    await update(u, db(), a.id, { body: null });
    expect(await search(u, db(), "кабінет")).toEqual([]);
    expect((await search(u, db(), "зубний")).map((i) => i.id)).toEqual([a.id]);
  });

  it("зміна полів, що не в індексі (dueAt/priority), індекс не ламає", async () => {
    const u = await newUser(1);
    const a = await create(u, db(), note("Лікар", { body: "кабінет" }), NOW);
    await update(u, db(), a.id, { dueAt: NOW + 5, priority: "important" });
    await setStatus(u, db(), a.id, "done", NOW);
    expect((await search(u, db(), "кабінет")).map((i) => i.id)).toEqual([a.id]);
    await expectIndexConsistent();
  });

  it("після DELETE не знаходить (і integrity-check індексу чистий)", async () => {
    const u = await newUser(1);
    const a = await create(u, db(), note("Лікар", { body: "кабінет" }), NOW);
    await DB.prepare("DELETE FROM items WHERE id = ?").bind(a.id).run();
    expect(await rawHits('"лікар"*')).toBe(0); // самі індекс без JOIN теж порожній
    expect(await search(u, db(), "лікар")).toEqual([]);
    expect(await search(u, db(), "кабінет")).toEqual([]);
    await expectIndexConsistent();
  });

  it("1.1.d: ворожі запити не кидають і нічого не знаходять", async () => {
    const u = await newUser(1);
    await create(u, db(), note("Лікар"), NOW);
    for (const q of ['"', 'AND OR (', "*", "NEAR(", "", "   ", '"" ""', "title:лікар", "лікар OR", "-лікар", "^лікар"]) {
      await expect(search(u, db(), q)).resolves.toBeInstanceOf(Array);
    }
    for (const q of ['"', "*", "", "   ", "NEAR("]) expect(await search(u, db(), q)).toEqual([]);
    // оператори стали звичайним текстом: «лікар OR щось» вимагає обох слів, а не будь-якого
    expect(await search(u, db(), "лікар OR щось")).toEqual([]);
  });
});

describe("toMatchQuery", () => {
  it("кожне слово в лапках із префіксом; лапки подвоєні; слова без літер/цифр відкинуті; ліміт слів", () => {
    expect(toMatchQuery("лікар п'ятниця")).toBe('"лікар"* "п\'ятниця"*');
    expect(toMatchQuery('a"b')).toBe('"a""b"*');
    expect(toMatchQuery('* " ()')).toBeNull();
    expect(toMatchQuery("")).toBeNull();
    expect(toMatchQuery("1 2 3 4 5 6 7 8 9 10")!.split(" ")).toHaveLength(8);
  });
});

describe("S1.1.f атомарність (частково: points_ledger з'явиться в 1.5)", () => {
  const cap = (u: number) =>
    DB.prepare("INSERT INTO captures (user_id, tg_update_id, source, raw_text, status, created_at) VALUES (?, 77, 'text', 'x', 'parsed', 1)").bind(u);
  const item = (u: number, title: string) =>
    DB.prepare("INSERT INTO items (user_id, kind, title, source, created_at) VALUES (?, 'note', ?, 'text', 1)").bind(u, title);
  const count = async (t: string) => (await DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;

  it("batch: друга інструкція падає → немає ні першої, ні тих, що йшли після неї", async () => {
    const u = await newUser(1);
    await expect(DB.batch([cap(u), item(u, "добрий"), item(u, ""), item(u, "хвіст")])).rejects.toThrow();
    expect(await count("captures")).toBe(0);
    expect(await count("items")).toBe(0); // ні «добрий» (до збою), ні «хвіст» (після)
  });

  it("контрольний: той самий batch без поганої інструкції зберігає все", async () => {
    const u = await newUser(1);
    await DB.batch([cap(u), item(u, "добрий"), item(u, "хвіст")]);
    expect(await count("captures")).toBe(1);
    expect(await count("items")).toBe(2);
  });
});

describe("setStatus: done_at", () => {
  it("повторне «зроблено» не зсуває done_at; open скидає, наступне done ставить заново", async () => {
    const u = await newUser(1);
    const it1 = await create(u, db(), note("зробити"), NOW);
    const T = NOW + 1000;
    expect((await setStatus(u, db(), it1.id, "done", T))!.done_at).toBe(T);
    expect((await setStatus(u, db(), it1.id, "done", T + 300_000))!.done_at).toBe(T); // подвійний клік
    expect((await setStatus(u, db(), it1.id, "open", T + 400_000))!.done_at).toBeNull();
    expect((await setStatus(u, db(), it1.id, "done", T + 500_000))!.done_at).toBe(T + 500_000);
  });
});

describe("src/db/aiCalls", () => {
  it("log пише рядок; error-міти й токени зберігаються; без тексту", async () => {
    const u = await newUser(1);
    await log(u, db(), { model: "claude-haiku-5-5", purpose: "parse", ok: true, inputTokens: 120, outputTokens: 30 }, NOW);
    await log(u, db(), { model: "claude-haiku-5-5", purpose: "fix", ok: false, error: "timeout" }, NOW + 1);
    const rows = (await DB.prepare("SELECT * FROM ai_calls ORDER BY id").all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ok: 1, error: null, input_tokens: 120, output_tokens: 30, purpose: "parse" });
    expect(rows[1]).toMatchObject({ ok: 0, error: "timeout", input_tokens: 0, capture_id: null });
    expect(Object.keys(rows[0]!)).not.toContain("text");
  });

  it("log: ok=true з error відхиляє БД", async () => {
    const u = await newUser(1);
    await expect(log(u, db(), { model: "m", purpose: "parse", ok: true, error: "http" }, NOW)).rejects.toThrow();
  });

  it("countToday рахує за київською добою: 23:30 UTC (зима) уже наступна доба", async () => {
    const u = await newUser(1);
    const other = await newUser(2);
    // 2026-11-20T23:30Z = 01:30 21.11 Київ; 2026-11-20T21:30Z = 23:30 20.11 Київ
    const lateUtc = Date.parse("2026-11-20T23:30:00Z");
    const earlyUtc = Date.parse("2026-11-20T21:30:00Z");
    await log(u, db(), { model: "m", purpose: "parse", ok: true }, earlyUtc);
    await log(u, db(), { model: "m", purpose: "parse", ok: true }, lateUtc);
    await log(u, db(), { model: "m", purpose: "ask", ok: false, error: "http" }, lateUtc + 60_000); // усі purpose й невдалі теж
    await log(other, db(), { model: "m", purpose: "parse", ok: true }, lateUtc); // чужий не рахується
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-21T08:00:00Z")); // 10:00 21.11 Київ
    expect(await countToday(u, db(), KYIV, systemClock.now())).toBe(2);
    vi.setSystemTime(Date.parse("2026-11-20T10:00:00Z")); // 12:00 20.11 Київ: «минула» доба
    expect(await countToday(u, db(), KYIV, systemClock.now())).toBe(1);
    expect(await countToday(other, db(), KYIV, Date.parse("2026-11-21T08:00:00Z"))).toBe(1);
  });

  it("countToday: межа доби — рівно північ за Києвом включно/виключно", async () => {
    const u = await newUser(1);
    const midnight = Date.parse("2026-11-20T22:00:00Z"); // 00:00 21.11 Київ
    await log(u, db(), { model: "m", purpose: "parse", ok: true }, midnight - 1);
    await log(u, db(), { model: "m", purpose: "parse", ok: true }, midnight);
    expect(await countToday(u, db(), KYIV, midnight + 3_600_000)).toBe(1);
    expect(await countToday(u, db(), KYIV, midnight - 3_600_000)).toBe(1);
  });
});
