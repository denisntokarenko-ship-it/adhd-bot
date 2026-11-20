// Крок 1.5: журнал очок (S1.9), /today (S1.10), /export (S1.11). Мок Claude й Telegram, справжній D1 в Miniflare.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiClient, AiRequest } from "../../src/ai/client";
import type { BotDeps } from "../../src/bot";
import { openDb } from "../../src/db/index";
import { create, setStatus, type NewItem } from "../../src/db/items";
import { balance } from "../../src/db/points";
import { ensureUser } from "../../src/db/users";
import { EMPTY_TODAY_POOL } from "../../src/texts";
import { baseEnv, deps, forwardText, mockTelegram, photoUpdate, send, textUpdate, voiceUpdate } from "./helpers";

const DB = env.DB!;
const FRI = Date.parse("2026-11-20T13:00:00Z"); // 15:00 п'ятниці за Києвом
const db = () => openDb(baseEnv());

beforeEach(async () => {
  for (const t of ["points_ledger", "ai_calls", "items", "capture_fixes", "captures", "users"]) await DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => vi.restoreAllMocks());

const rawItem = (over: Record<string, unknown> = {}) => ({
  kind: "task",
  title: "Корм коту",
  body: null,
  due_local: null,
  all_day: false,
  priority: "normal",
  date_unclear: false,
  ...over,
});
function mockAi(...items: Record<string, unknown>[]) {
  const requests: AiRequest[] = [];
  const client: AiClient = {
    async complete(req) {
      requests.push(req);
      return { text: JSON.stringify({ items }), stopReason: "end_turn", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
  };
  return { client, requests };
}
const d = (ai: AiClient | null, now = FRI, extra: Partial<BotDeps> = {}): BotDeps => deps({ now, ai, stt: null, ...extra });
const one = async <T>(sql: string, ...bind: unknown[]) => (await DB.prepare(sql).bind(...bind).first<T>())!;
const count = async (table: string) => (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)).n;
const ledger = async () => (await DB.prepare("SELECT user_id, delta, reason, capture_id, item_id FROM points_ledger ORDER BY id").all()).results;
const textOf = (c: { body: Record<string, unknown> }) => String(c.body.text);
const userOf = (tgId: number) => ensureUser(tgId, db(), FRI);
const at = (iso: string) => Date.parse(iso);
const mk = (userId: number, over: Partial<NewItem> & { title: string }, now = FRI) =>
  create(userId, db(), { kind: "task", source: "text", ...over }, now);
const bonus = (userId: number, delta: number) =>
  DB.prepare("INSERT INTO points_ledger (user_id, delta, reason, created_at) VALUES (?1, ?2, 'bonus', 1)").bind(userId, delta).run();

describe("S1.9 журнал очок", () => {
  it("1.9.c: БД відхиляє delta=0, мінус не-redeem, плюс redeem, capture без capture_id, невідомий reason", async () => {
    const u = await userOf(111);
    const ins = (delta: number, reason: string, captureId: number | null = null) =>
      DB.prepare("INSERT INTO points_ledger (user_id, delta, reason, capture_id, created_at) VALUES (?1, ?2, ?3, ?4, 1)")
        .bind(u.id, delta, reason, captureId)
        .run();
    await DB.prepare("INSERT INTO captures (id, user_id, tg_update_id, source, raw_text, status, created_at) VALUES (50, ?1, 1, 'text', 'x', 'parsed', 1)")
      .bind(u.id)
      .run();
    await expect(ins(0, "bonus")).rejects.toThrow(); // нуль
    await expect(ins(-1, "capture", 50)).rejects.toThrow(); // мінус з reason capture
    await expect(ins(-1, "bonus")).rejects.toThrow(); // мінус не redeem
    await expect(ins(5, "redeem")).rejects.toThrow(); // redeem лише мінус
    await expect(ins(1, "capture", null)).rejects.toThrow(); // NULL обійшов би UNIQUE
    await expect(ins(1, "penalty")).rejects.toThrow(); // невідомий reason
    expect(await count("points_ledger")).toBe(0);
    // і дозволене проходить — CHECK не відхиляє все підряд
    await ins(1, "capture", 50);
    await ins(3, "bonus");
    await ins(-2, "redeem");
    expect(await count("points_ledger")).toBe(3);
  });

  it("1.9.a: UNIQUE у БД — друге очко за те саме захоплення відхилено (не лише перевірка в коді)", async () => {
    const u = await userOf(111);
    await DB.prepare("INSERT INTO captures (id, user_id, tg_update_id, source, raw_text, status, created_at) VALUES (51, ?1, 1, 'text', 'x', 'parsed', 1)")
      .bind(u.id)
      .run();
    const ins = () =>
      DB.prepare("INSERT INTO points_ledger (user_id, delta, reason, capture_id, created_at) VALUES (?1, 1, 'capture', 51, 1)").bind(u.id).run();
    await ins();
    await expect(ins()).rejects.toThrow(/UNIQUE/);
  });

  it("1.9.b: balance = SUM(delta) цього користувача; порожній журнал → 0; чужі рядки не враховані", async () => {
    const a = await userOf(111);
    const b = await userOf(222);
    expect(await balance(a.id, db())).toBe(0);
    await bonus(a.id, 5);
    await bonus(a.id, 2);
    await DB.prepare("INSERT INTO points_ledger (user_id, delta, reason, created_at) VALUES (?1, -3, 'redeem', 1)").bind(a.id).run();
    await bonus(b.id, 100);
    expect(await balance(a.id, db())).toBe(4);
    expect(await balance(b.id, db())).toBe(100);
  });

  it("1.9.a: нове захоплення → рівно один рядок +1 capture з capture_id; квитанція каже «+1 ✨»", async () => {
    const tg = mockTelegram();
    await send(textUpdate("купити корм коту"), baseEnv(), d(mockAi(rawItem()).client));
    const cap = await one<{ id: number }>("SELECT id FROM captures");
    const u = await userOf(111);
    expect(await ledger()).toEqual([{ user_id: u.id, delta: 1, reason: "capture", capture_id: cap.id, item_id: null }]);
    expect(textOf(tg.sent()[0]!).split("\n")).toContain("+1 ✨");
    expect(await balance(u.id, db())).toBe(1);
  });

  it("НФ-7: той самий update_id (послідовно й паралельно) — одне очко", async () => {
    mockTelegram();
    const ai = mockAi(rawItem());
    const upd = textUpdate("купити корм коту");
    await send(upd, baseEnv(), d(ai.client));
    await send(upd, baseEnv(), d(ai.client));
    await Promise.all([send(upd, baseEnv(), d(ai.client)), send(upd, baseEnv(), d(ai.client))]);
    expect(await count("captures")).toBe(1);
    expect(await count("points_ledger")).toBe(1);
  });

  it("1.9.d: запасна нотатка, голосове без STT і пересилання — по одному очку", async () => {
    mockTelegram();
    await send(textUpdate("лікар завтра"), baseEnv(), d(null)); // ШІ немає → запасна нотатка
    await send(voiceUpdate(5), baseEnv(), d(null)); // STT немає → голосове pending
    await send(forwardText("зустріч у п'ятницю"), baseEnv(), d(mockAi(rawItem()).client));
    expect(await count("captures")).toBe(3);
    expect((await ledger()).map((r) => [r.delta, r.reason])).toEqual([[1, "capture"], [1, "capture"], [1, "capture"]]);
  });

  it("1.9.d: виправлення «Не так» не дає додаткового очка; порожнє голосове, фото, команди — нуль", async () => {
    mockTelegram();
    const ai = mockAi(rawItem());
    await send(textUpdate("купити корм"), baseEnv(), d(ai.client));
    const cap = await one<{ id: number }>("SELECT id FROM captures");
    const cb = {
      update_id: 9001,
      callback_query: {
        id: "cb",
        chat_instance: "x",
        from: { id: 111, is_bot: false, first_name: "T" },
        data: `fix:${cap.id}`,
        message: { message_id: 1, date: 0, chat: { id: 111, type: "private" } },
      },
    };
    await send(cb, baseEnv(), d(ai.client));
    await send(textUpdate("краще купити воду"), baseEnv(), d(ai.client)); // це виправлення
    expect(await count("capture_fixes")).toBe(1);
    expect(await count("captures")).toBe(1);
    await send(voiceUpdate(0), baseEnv(), d(ai.client));
    await send(photoUpdate(), baseEnv(), d(ai.client));
    await send(textUpdate("/today"), baseEnv(), d(ai.client));
    await send(textUpdate("/export"), baseEnv(), d(ai.client));
    await send(textUpdate("/foo"), baseEnv(), d(ai.client));
    expect(await count("captures")).toBe(1);
    expect(await count("points_ledger")).toBe(1);
  });

  it("1.1.f (борг): очко — друга інструкція batch; збій на ній відкочує захоплення — 500, нічого напіввидом", async () => {
    mockTelegram();
    await userOf(111);
    await DB.prepare("CREATE TRIGGER tmp_ledger_boom BEFORE INSERT ON points_ledger BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
    try {
      const res = await send(textUpdate("купити корм"), baseEnv(), d(mockAi(rawItem()).client));
      expect(res.status).toBe(500); // Telegram повторить доставку
      expect(await count("captures")).toBe(0);
      expect(await count("items")).toBe(0);
    } finally {
      await DB.prepare("DROP TRIGGER tmp_ledger_boom").run();
    }
  });
});

describe("S1.10 /today", () => {
  const NOON = at("2026-11-20T09:00:00Z"); // 11:00 п'ятниці за Києвом

  it("1.10.a: заголовок з датою й балансом; спершу «весь день», потім за часом; без дати — 5 найновіших і «…ще N»; решта не показана", async () => {
    const tg = mockTelegram();
    const ai = mockAi(rawItem());
    const u = await userOf(111);
    await mk(u.id, { title: "Дзвінок", dueAt: at("2026-11-20T13:00:00Z") }, NOON); // 15:00
    await mk(u.id, { kind: "event", title: "Лікар", dueAt: at("2026-11-20T08:00:00Z") }, NOON); // 10:00
    await mk(u.id, { kind: "event", title: "Конференція", dueAt: at("2026-11-19T22:00:00Z"), allDay: true }, NOON); // 00:00 за Києвом
    for (let i = 1; i <= 7; i++) await mk(u.id, { kind: "note", title: `Без${i}` }, NOON);
    await mk(u.id, { title: "Вчорашнє", dueAt: at("2026-11-19T10:00:00Z") }, NOON);
    const done = await mk(u.id, { title: "Зроблене", dueAt: at("2026-11-20T10:00:00Z") }, NOON);
    const rel = await mk(u.id, { title: "Відпущене", dueAt: at("2026-11-20T11:00:00Z") }, NOON);
    await setStatus(u.id, db(), done.id, "done", NOON);
    await setStatus(u.id, db(), rel.id, "released", NOON);
    await bonus(u.id, 3);

    await send(textUpdate("/today"), baseEnv(), d(ai.client, NOON));
    expect(tg.sent()).toHaveLength(1);
    expect(textOf(tg.sent()[0]!)).toBe(
      [
        "<b>пт 20.11</b> · ⭐ 3",
        "",
        "<b>Сьогодні</b>",
        "📅 Конференція — весь день",
        "📅 Лікар — 10:00",
        "☑️ Дзвінок — 15:00",
        "",
        "<b>Без дати</b>",
        "📝 Без7",
        "📝 Без6",
        "📝 Без5",
        "📝 Без4",
        "📝 Без3",
        "…ще 2",
      ].join("\n"),
    );
    expect(tg.sent()[0]!.body.parse_mode).toBe("HTML");
    expect(textOf(tg.sent()[0]!)).not.toMatch(/Вчорашнє|Зроблене|Відпущене|прострочен|пропущ|вчора/i);
    expect(ai.requests).toHaveLength(0); // ШІ не викликається
    expect(await count("captures")).toBe(0); // /today — не захоплення
  });

  it("1.10.b: о 00:30 за Києвом «сьогодні» — 21.11, а не UTC-дата 20.11; межі доби", async () => {
    const tg = mockTelegram();
    const now = at("2026-11-20T22:30:00Z"); // 00:30 суботи 21.11
    const u = await userOf(111);
    await mk(u.id, { title: "Пізно", dueAt: at("2026-11-20T22:05:00Z") }, now); // 00:05 сб — є
    await mk(u.id, { title: "Учора", dueAt: at("2026-11-20T21:50:00Z") }, now); // 23:50 пт — нема
    await mk(u.id, { title: "Завтра", dueAt: at("2026-11-21T22:00:00Z") }, now); // 00:00 нд — нема
    await send(textUpdate("/today"), baseEnv(), d(null, now));
    const text = textOf(tg.sent()[0]!);
    expect(text).toContain("<b>сб 21.11</b>");
    expect(text).toContain("☑️ Пізно — 00:05");
    expect(text).not.toContain("Учора");
    expect(text).not.toContain("Завтра");
  });

  it("1.10.c: дні переходу на літній/зимовий час (23 і 25 год) показують усі записи своєї доби й лише їх", async () => {
    const cases: [string, string[], string[]][] = [
      ["2026-03-29T10:00:00Z", ["2026-03-28T22:00:00Z", "2026-03-29T20:59:00Z"], ["2026-03-28T21:59:00Z", "2026-03-29T21:00:00Z"]],
      ["2026-10-25T10:00:00Z", ["2026-10-24T21:00:00Z", "2026-10-25T21:59:00Z"], ["2026-10-24T20:59:00Z", "2026-10-25T22:00:00Z"]],
    ];
    for (const [now, inside, outside] of cases) {
      await DB.prepare("DELETE FROM items").run();
      const tg = mockTelegram();
      const u = await userOf(111);
      for (const [i, iso] of inside.entries()) await mk(u.id, { title: `В${i}`, dueAt: at(iso) }, at(now));
      for (const [i, iso] of outside.entries()) await mk(u.id, { title: `З${i}`, dueAt: at(iso) }, at(now));
      await send(textUpdate("/today"), baseEnv(), d(null, at(now)));
      const text = textOf(tg.sent()[0]!);
      expect(text, now).toContain("В0");
      expect(text, now).toContain("В1");
      expect(text, now).not.toMatch(/З[01]/);
      vi.restoreAllMocks();
    }
  });

  it("1.10.d: порожній день — фраза з пулу ≥ 3, підряд різні, індекс у БД; запасна нотатка з приміткою «розберу пізніше»", async () => {
    expect(EMPTY_TODAY_POOL.length).toBeGreaterThanOrEqual(3);
    const tg = mockTelegram();
    const phrases: string[] = [];
    for (let i = 0; i < 4; i++) {
      await send(textUpdate("/today"), baseEnv(), d(null, FRI, { rand: () => 0 }));
      phrases.push(textOf(tg.sent()[i]!).split("\n\n")[1]!);
    }
    for (const p of phrases) expect(EMPTY_TODAY_POOL).toContain(p);
    for (let i = 1; i < phrases.length; i++) expect(phrases[i]).not.toBe(phrases[i - 1]);
    expect((await userOf(111)).today_variant_idx).toBe(EMPTY_TODAY_POOL.indexOf(phrases[3]!));
    expect(textOf(tg.sent()[0]!)).toMatch(/^<b>пт 20\.11<\/b> · ⭐ 0\n\n/);

    await send(textUpdate("купити хліб"), baseEnv(), d(null)); // ШІ немає → запасна нотатка
    await send(textUpdate("/today"), baseEnv(), d(null));
    expect(textOf(tg.sent().at(-1)!)).toContain("📝 купити хліб <i>(розберу пізніше)</i>");
  });

  it("1.10.e: ≤ 4096, довший перелік — «…ще N» цілими рядками, теги збалансовані; HTML екранується", async () => {
    const tg = mockTelegram();
    const u = await userOf(111);
    await mk(u.id, { title: "<b>x & y", dueAt: at("2026-11-20T08:00:00Z") });
    for (let i = 0; i < 120; i++) await mk(u.id, { title: `${"Дуже довга справа ".repeat(10)}${i}`.slice(0, 190), dueAt: at("2026-11-20T09:00:00Z") });
    await send(textUpdate("/today"), baseEnv(), d(null));
    const text = textOf(tg.sent()[0]!);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("&lt;b&gt;x &amp; y");
    expect(text).toMatch(/…ще \d+/);
    expect((text.match(/<b>/g) ?? []).length).toBe((text.match(/<\/b>/g) ?? []).length);
    expect(text).not.toMatch(/<(?!\/?b>|\/?i>)/); // жодного «сирого» тегу
  });

  it("1.10.f: ізоляція — чужі записи й чужий баланс не потрапляють у /today", async () => {
    const tg = mockTelegram();
    const a = await userOf(111);
    const b = await userOf(222);
    await mk(a.id, { title: "Моє", dueAt: at("2026-11-20T10:00:00Z") });
    await mk(b.id, { title: "Чуже денне", dueAt: at("2026-11-20T10:00:00Z") });
    await mk(b.id, { kind: "note", title: "Чуже без дати" });
    await bonus(b.id, 50);
    await send(textUpdate("/today", { from: 111 }), baseEnv(), d(null));
    const text = textOf(tg.sent()[0]!);
    expect(text).toContain("Моє");
    expect(text).not.toContain("Чуже");
    expect(text).toContain("⭐ 0");
    expect(text).not.toContain("Без дати");
  });

  it("пересилання з «/today» усередині лишається даними, а не командою", async () => {
    mockTelegram();
    await send(forwardText("/today купити корм"), baseEnv(), d(mockAi(rawItem()).client));
    expect(await count("captures")).toBe(1);
  });
});

describe("S1.11 /export", () => {
  type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const exportOf = (tg: ReturnType<typeof mockTelegram>, i = 0) => {
    const doc = tg.docs()[i]!.body.document as { name: string; text: string };
    return { name: doc.name, text: doc.text, json: JSON.parse(doc.text) as Json };
  };

  it("1.11.a/c/e: документ adhd-export-<дата в tz>.json з усіма записами всіх статусів, захопленнями й очками; без tg_id, токенів, ai_calls; ШІ не викликається", async () => {
    const tg = mockTelegram();
    const ai = mockAi(rawItem({ kind: "event", title: "Лікар 🩺 «очі»", due_local: "2026-11-21T10:00" }), rawItem());
    await send(textUpdate("завтра лікар і корм"), baseEnv(), d(ai.client));
    const u = await userOf(111);
    const done = await mk(u.id, { title: "Зроблене" });
    const rel = await mk(u.id, { title: "Відпущене" });
    await setStatus(u.id, db(), done.id, "done", FRI);
    await setStatus(u.id, db(), rel.id, "released", FRI);
    await send(textUpdate("ще нотатка"), baseEnv(), d(null)); // запасна нотатка
    const calls = ai.requests.length;

    await send(textUpdate("/export"), baseEnv(), d(ai.client, at("2026-11-20T22:30:00Z"))); // 00:30 сб за Києвом
    expect(ai.requests.length).toBe(calls); // 1.11.e
    expect(tg.docs()).toHaveLength(1);
    const { name, text, json } = exportOf(tg);
    expect(name).toBe("adhd-export-2026-11-21.json"); // дата в tz, не UTC
    expect(Object.keys(json)).toEqual(["version", "exported_at", "tz", "items", "captures", "points_ledger"]);
    expect(json.version).toBe(1);
    expect(json.exported_at).toBe(at("2026-11-20T22:30:00Z"));
    expect(json.tz).toBe("Europe/Kyiv");
    expect(json.items.map((i: Json) => i.title)).toEqual(["Лікар 🩺 «очі»", "Корм коту", "Зроблене", "Відпущене", "ще нотатка"]);
    expect(json.items.map((i: Json) => i.status)).toEqual(["open", "open", "done", "released", "open"]);
    expect(Object.keys(json.items[0])).toEqual([
      "id", "user_id", "capture_id", "kind", "title", "body", "raw_text", "source", "due_at", "all_day",
      "priority", "status", "travel_min", "created_at", "done_at", "snooze_count",
    ]);
    expect(typeof json.items[0].due_at).toBe("number");
    expect(typeof json.items[0].id).toBe("number");
    expect(Object.keys(json.captures[0])).toEqual(["id", "source", "raw_text", "status", "created_at"]);
    expect(json.captures.map((c: Json) => c.status)).toEqual(["parsed", "pending"]);
    expect(json.points_ledger.map((p: Json) => [p.delta, p.reason])).toEqual([[1, "capture"], [1, "capture"]]);
    expect(Object.keys(json.points_ledger[0])).toEqual(["id", "delta", "reason", "item_id", "capture_id", "created_at"]);
    expect(text).not.toMatch(/tg_id|TESTTOKEN|input_tokens|ai_calls|tg_update_id/);
    expect(tg.sent()).toHaveLength(2); // дві квитанції на захоплення; /export — документ, не повідомлення
  });

  it("1.11.b: порожній користувач → валідний JSON із порожніми масивами", async () => {
    const tg = mockTelegram();
    await send(textUpdate("/export"), baseEnv(), d(null));
    const { json } = exportOf(tg);
    expect(json).toMatchObject({ version: 1, tz: "Europe/Kyiv", items: [], captures: [], points_ledger: [] });
  });

  it("1.11.d: ізоляція — кожен отримує лише своє, чужих рядків немає", async () => {
    const tg = mockTelegram();
    const a = await userOf(111);
    const b = await userOf(222);
    await mk(a.id, { title: "Тільки-А" });
    await mk(b.id, { title: "Тільки-Б", body: "секрет Б" });
    await DB.prepare("INSERT INTO captures (user_id, tg_update_id, source, raw_text, status, created_at) VALUES (?1, 1, 'text', 'сирий-Б', 'parsed', 1)")
      .bind(b.id)
      .run();
    await bonus(b.id, 7);
    await send(textUpdate("/export", { from: 111 }), baseEnv(), d(null));
    await send(textUpdate("/export", { from: 222 }), baseEnv(), d(null));
    const ja = exportOf(tg, 0);
    const jb = exportOf(tg, 1);
    expect(ja.json.items.map((i: Json) => i.title)).toEqual(["Тільки-А"]);
    expect(ja.json.captures).toEqual([]);
    expect(ja.json.points_ledger).toEqual([]);
    expect(ja.text).not.toMatch(/Тільки-Б|секрет Б|сирий-Б/);
    expect(jb.json.items.map((i: Json) => i.title)).toEqual(["Тільки-Б"]);
    expect(jb.json.captures.map((c: Json) => c.raw_text)).toEqual(["сирий-Б"]);
    expect(jb.json.points_ledger).toHaveLength(1);
    expect(jb.text).not.toContain("Тільки-А");
  });
});
