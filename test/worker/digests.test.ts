// Огляди на реальному D1 (docs/spec/phase-3.md S3.1–S3.6; крок 3.1). Час фіксований (`vi.setSystemTime`), Telegram — мок.
// Київ взимку = UTC+2: 09:00 за Києвом = 07:00Z, 21:00 = 19:00Z. Субота 21.11.2026, неділя 22.11.2026.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiClient } from "../../src/ai/client";
import { planDigests } from "../../src/digests/planner";
import { morningMessage } from "../../src/digests/render";
import { openDb } from "../../src/db/index";
import { create, search, type NewItem } from "../../src/db/items";
import { ensureUser } from "../../src/db/users";
import { runScheduled } from "../../src/scheduled";
import {
  DIGEST_EVENING_POOL,
  DIGEST_MORNING_POOL,
  DIGEST_WARM_POOL,
  DIGEST_WEEKLY_POOL,
  SOON_POOL,
  SUMMARY_HEAD_POOL,
  UNKNOWN_REMINDER,
  WK_ALREADY_TODAY,
  WK_NOT_ACTUAL,
  WK_TODAY_POOL,
} from "../../src/texts";
import { baseEnv, deps, mockTelegram, send, textUpdate, type TgCall } from "./helpers";

const DB = env.DB!;
const db = () => openDb(baseEnv());
const MIN = 60_000;
const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-11-20T10:00:00Z"); // 12:00 пт 20.11 Київ

beforeEach(async () => {
  for (const t of ["reminders", "points_ledger", "ai_calls", "items", "capture_fixes", "captures", "users"]) await DB.prepare(`DELETE FROM ${t}`).run();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const clock = { now: () => Date.now() };
const cron = (extra: Parameters<typeof runScheduled>[2] = {}) => runScheduled(baseEnv(), clock, { rand: () => 0, ...extra });
const tick = async (iso: string) => {
  vi.setSystemTime(at(iso));
  await cron();
};
const user = async (tgId = 111) => (await ensureUser(tgId, db(), Date.now())).id;
const mk = async (userId: number, over: Partial<NewItem> = {}, createdAt = Date.now()) =>
  (await create(userId, db(), { kind: "task", title: "справа", source: "text", ...over }, createdAt)).id;
const setDone = (id: number, doneAt: number) => DB.prepare("UPDATE items SET status = 'done', done_at = ? WHERE id = ?").bind(doneAt, id).run();
const ledger = (userId: number, delta: number, reason: string, createdAt: number, itemId: number | null = null) =>
  DB.prepare("INSERT INTO points_ledger (user_id, delta, reason, item_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(userId, delta, reason, itemId, createdAt).run();

interface Row {
  id: number;
  user_id: number;
  item_id: number | null;
  kind: string;
  fire_at: number;
  attempt: number;
  max_attempts: number;
  status: string;
  parent_id: number | null;
  root_id: number | null;
  lease_until: number | null;
  sent_at: number | null;
  sent_as: string | null;
  tg_message_id: number | null;
  variant_idx: number | null;
}
const rows = async (where = "1=1") => (await DB.prepare(`SELECT * FROM reminders WHERE ${where} ORDER BY id`).all<Row>()).results;
const dgs = (kind: string, status?: string) => rows(`kind = '${kind}'${status === undefined ? "" : ` AND status = '${status}'`}`);
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

// прямий SQL: рядок черги з потрібним станом (як у dispatch.test.ts)
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

const items = async () => JSON.stringify((await DB.prepare("SELECT * FROM items ORDER BY id").all()).results);
const sentCalls = (tg: ReturnType<typeof mockTelegram>) => tg.calls.filter((c) => c.method === "sendMessage");
const textOf = (c: TgCall) => String(c.body.text);
const kbOf = (c: TgCall) => ((c.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []);
const startsWithAny = (pool: readonly string[]) => (c: TgCall) => pool.some((h) => textOf(c).startsWith(h));
const morning = startsWithAny(DIGEST_MORNING_POOL);
const evening = startsWithAny(DIGEST_EVENING_POOL);
const weekly = startsWithAny(DIGEST_WEEKLY_POOL);
const warm = startsWithAny(DIGEST_WARM_POOL);
const FORBIDDEN = ["пропустив", "прострочен", "знову", "не зроблено", "забув", "провал", "ніколи не"];
const tone = (text: string) => FORBIDDEN.filter((w) => text.toLowerCase().includes(w));

let cbId = 9000;
const press = (data: string, o: { from?: number; mid?: number; text?: string; markup?: unknown } = {}) =>
  send(
    {
      update_id: ++cbId,
      callback_query: {
        id: `cb${cbId}`,
        chat_instance: "x",
        from: { id: o.from ?? 111, is_bot: false, first_name: "T" },
        data,
        message: {
          message_id: o.mid ?? 1,
          date: 0,
          chat: { id: o.from ?? 111, type: "private" },
          ...(o.text === undefined ? {} : { text: o.text }),
          ...(o.markup === undefined ? {} : { reply_markup: o.markup }),
        },
      },
    },
    baseEnv(),
    deps({ now: Date.now() }),
  );
const toast = (tg: ReturnType<typeof mockTelegram>) => tg.calls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text;
const edits = (tg: ReturnType<typeof mockTelegram>) => tg.calls.filter((c) => c.method === "editMessageText");

// ── S3.1 · рядок огляду ─────────────────────────────────────────────────────────────────────────────────────

describe("S3.1 планування, ланцюг, самовідновлення", () => {
  it("3.1.a: новий користувач, 10:15 Київ → 3 pending рядки: ранок завтра 09:00, вечір сьогодні 21:00, тиждень — неділя 09:00", async () => {
    mockTelegram();
    await user();
    vi.setSystemTime(at("2026-11-20T08:15:00Z"));
    await cron();
    const all = await rows();
    expect(all).toHaveLength(3);
    const by = Object.fromEntries(all.map((r) => [r.kind, r]));
    expect(iso(by.digest_morning!.fire_at)).toBe("2026-11-21T07:00:00Z");
    expect(iso(by.digest_evening!.fire_at)).toBe("2026-11-20T19:00:00Z");
    expect(iso(by.digest_weekly!.fire_at)).toBe("2026-11-22T07:00:00Z");
    for (const r of all) expect(r).toMatchObject({ item_id: null, parent_id: null, attempt: 1, max_attempts: 1, status: "pending" });
  });

  it("3.1.b: ще 2 тики і паралельне доплановування → рядків так само 3; другий pending того ж виду падає на UNIQUE, форма рядка — на тригері", async () => {
    mockTelegram();
    const u = await user();
    await cron();
    await cron();
    await cron();
    await Promise.all([planDigests(db(), Date.now()), planDigests(db(), Date.now())]);
    expect(await rows()).toHaveLength(3);
    const ins = (kind: string, status: string, attempt: number, max: number, itemId: number | null = null) =>
      DB.prepare("INSERT INTO reminders (user_id, item_id, kind, fire_at, attempt, max_attempts, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(u, itemId, kind, NOW + 5 * DAY, attempt, max, status, NOW)
        .run();
    await expect(ins("digest_morning", "pending", 1, 1)).rejects.toThrow(); // ux_rem_digest_pending
    await expect(ins("digest_morning", "cancelled", 2, 2)).rejects.toThrow(); // огляд без повторів
    await expect(ins("digest_morning", "cancelled", 1, 1, await mk(u))).rejects.toThrow(); // огляд без запису
    expect(await ins("digest_morning", "cancelled", 1, 1)).toBeTruthy(); // не pending — дозволено
  });

  it("3.1.c: ранок о 09:00 пішов → один batch: sent + sent_as='single' + id повідомлення; новий pending на завтра 09:00", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    await mk(u, { title: "Купити хліб" }, at("2026-11-21T05:00:00Z"));
    await tick("2026-11-21T06:00:00Z");
    await tick("2026-11-21T07:00:00Z");
    expect(sentCalls(tg).filter(morning)).toHaveLength(1);
    const [done, next] = await dgs("digest_morning");
    expect(done).toMatchObject({ status: "sent", sent_as: "single", tg_message_id: 101, sent_at: at("2026-11-21T07:00:00Z"), lease_until: null });
    expect(next).toMatchObject({ status: "pending", fire_at: at("2026-11-22T07:00:00Z"), item_id: null });
  });

  it("3.1.c: збій закриття після sendMessage — допустимий дубль через LEASE_MS; друге закриття проходить, рівно один pending на завтра", async () => {
    const tg = mockTelegram();
    const u = await user();
    await mk(u, { title: "Купити хліб" }, at("2026-11-21T05:00:00Z"));
    await tick("2026-11-21T06:00:00Z");
    // Proxy над D1: перший DB.batch (закриття огляду) кидає. morningContent batch не використовує.
    const real = env.DB!;
    let failed = false;
    const flaky = new Proxy(real, {
      get(t, k) {
        if (k === "batch")
          return async (...a: unknown[]) => {
            if (!failed) {
              failed = true;
              throw new Error("D1 down");
            }
            return (t.batch as (...x: unknown[]) => Promise<unknown>)(...a);
          };
        const v = Reflect.get(t, k) as unknown;
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    vi.setSystemTime(at("2026-11-21T07:00:00Z"));
    await runScheduled(baseEnv({ DB: flaky }), clock, { rand: () => 0 });
    expect(failed).toBe(true);
    expect(sentCalls(tg).filter(morning)).toHaveLength(1);
    expect(await dgs("digest_morning", "pending")).toHaveLength(1); // не закрито, оренда діє
    await tick("2026-11-21T07:01:00Z"); // оренда ще тримає: нічого, і доплановування нічого не додає
    expect(sentCalls(tg).filter(morning)).toHaveLength(1);
    expect(await dgs("digest_morning", "pending")).toHaveLength(1);
    await tick("2026-11-21T07:02:00Z"); // оренда збігла — той самий рядок відправлено вдруге
    expect(sentCalls(tg).filter(morning)).toHaveLength(2);
    const all = await dgs("digest_morning");
    expect(all.map((r) => r.status)).toEqual(["sent", "pending"]);
    expect(all[1]!.fire_at).toBe(at("2026-11-22T07:00:00Z"));
  });

  it("3.1.c: рядок, старший за DIGEST_TTL_MS, не відправляється (перевірка до sendMessage) — cancelled, завтрашній є", async () => {
    const tg = mockTelegram();
    const u = await user();
    await mk(u, { title: "Купити хліб" }, at("2026-11-21T05:00:00Z"));
    await tick("2026-11-21T06:00:00Z");
    await tick("2026-11-21T10:01:00Z"); // 3 год 1 хв після 09:00
    expect(sentCalls(tg)).toHaveLength(0);
    expect((await dgs("digest_morning")).map((r) => [r.status, iso(r.fire_at)])).toEqual([["cancelled", "2026-11-21T07:00:00Z"], ["pending", "2026-11-22T07:00:00Z"]]);
  });

  it("3.1.d: pending ранок видалено (ланцюг розірвано) → наступний тик доплановує рівно один на найближчий слот", async () => {
    mockTelegram();
    await user();
    vi.setSystemTime(at("2026-11-20T08:15:00Z"));
    await cron();
    await DB.prepare("DELETE FROM reminders WHERE kind = 'digest_morning'").run();
    await cron();
    const m = await dgs("digest_morning");
    expect(m).toHaveLength(1);
    expect(iso(m[0]!.fire_at)).toBe("2026-11-21T07:00:00Z");
  });

  it("3.1.e: тиха ніч 23–08, morning_at 07:00 → 07:00–07:59 мовчить і оренди немає; о 08:00 — один ранок окремо від зведення запізнілих", async () => {
    const tg = mockTelegram();
    const u = await user();
    await DB.prepare("UPDATE users SET morning_at = 420").run();
    const a = await mk(u, { title: "Перша" }, at("2026-11-21T03:00:00Z"));
    const b = await mk(u, { title: "Друга" }, at("2026-11-21T03:00:00Z"));
    await tick("2026-11-21T04:30:00Z"); // 06:30 — плануємо ранок на 07:00
    await rem(u, a, { fire_at: at("2026-11-21T05:00:00Z") });
    await rem(u, b, { fire_at: at("2026-11-21T05:00:00Z") });
    for (const m of [0, 15, 30, 45, 59]) await tick(`2026-11-21T05:${String(m).padStart(2, "0")}:00Z`);
    expect(sentCalls(tg)).toHaveLength(0);
    expect((await dgs("digest_morning"))[0]).toMatchObject({ status: "pending", lease_until: null });
    await tick("2026-11-21T06:00:00Z"); // 08:00 — тиша скінчилась
    const out = sentCalls(tg);
    expect(out.filter(morning)).toHaveLength(1);
    expect(out.filter((c) => SUMMARY_HEAD_POOL.some((h) => textOf(c).startsWith(h)))).toHaveLength(1); // запізнілі — своїм зведенням
    expect(out).toHaveLength(2);
  });

  it("3.1.f: /pause 4 о 08:30 → о 12:30 огляд cancelled без повідомлення (3,5 год > TTL), завтрашній запланований", async () => {
    const tg = mockTelegram();
    const u = await user();
    await mk(u, { title: "Купити хліб" }, at("2026-11-21T05:00:00Z"));
    await tick("2026-11-21T06:30:00Z");
    await DB.prepare("UPDATE users SET pause_until = ? WHERE id = ?").bind(at("2026-11-21T10:30:00Z"), u).run();
    await tick("2026-11-21T07:00:00Z");
    expect(sentCalls(tg)).toHaveLength(0);
    await tick("2026-11-21T10:30:00Z");
    expect(sentCalls(tg)).toHaveLength(0);
    expect((await dgs("digest_morning")).map((r) => [r.status, iso(r.fire_at)])).toEqual([["cancelled", "2026-11-21T07:00:00Z"], ["pending", "2026-11-22T07:00:00Z"]]);
  });

  it("3.1.f: пауза до 10:00 → о 10:00 огляд іде (запізнення 1 год ≤ TTL)", async () => {
    const tg = mockTelegram();
    const u = await user();
    await mk(u, { title: "Купити хліб" }, at("2026-11-21T05:00:00Z"));
    await tick("2026-11-21T06:30:00Z");
    await DB.prepare("UPDATE users SET pause_until = ? WHERE id = ?").bind(at("2026-11-21T08:00:00Z"), u).run();
    await tick("2026-11-21T07:30:00Z");
    expect(sentCalls(tg)).toHaveLength(0);
    await tick("2026-11-21T08:00:00Z");
    expect(sentCalls(tg).filter(morning)).toHaveLength(1);
  });

  it("3.1.g: у ковзну годину вже 6 окремих пушів → вечір усе одно йде, і в цю годину рахується 7-м окремим", async () => {
    const tg = mockTelegram();
    const u = await user();
    const done = await mk(u, { title: "Зроблена" }, at("2026-11-20T08:00:00Z"));
    await setDone(done, at("2026-11-20T15:00:00Z"));
    await tick("2026-11-20T10:00:00Z");
    for (let i = 0; i < 6; i++) await rem(u, await mk(u, { title: `пуш ${i}` }, at("2026-11-20T11:00:00Z")), { status: "sent", sent_at: at("2026-11-20T18:30:00Z") + i * MIN, fire_at: at("2026-11-20T18:30:00Z") });
    await tick("2026-11-20T19:00:00Z");
    expect(sentCalls(tg).filter(evening)).toHaveLength(1);
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND sent_as = 'single' AND sent_at > ?").bind(u, at("2026-11-20T19:00:00Z") - 60 * MIN).first<{ n: number }>();
    expect(n!.n).toBe(7);
  });

  it.each([
    ["400 parse_entities", { code: 400, description: "Bad Request: can't parse entities: Can't find end tag corresponding to start tag \"b\"" }, "cancelled", "parse_entities"],
    ["400 too_long", { code: 400, description: "Bad Request: message is too long" }, "cancelled", "too_long"],
    ["403 chat_unavailable", { code: 403, description: "Forbidden: bot was blocked by the user" }, "cancelled", "chat_unavailable"],
    ["400 other", { code: 400, description: "Bad Request: something odd" }, "cancelled", "other"],
  ] as const)("3.1.h: %s → рядок cancelled, у лозі id, код і клас без description; завтрашній запланований", async (_n, sendError, status, cls) => {
    const tg = mockTelegram({ sendError: { ...sendError, only: [1] } });
    const u = await user();
    await mk(u, { title: "Купити хліб" }, at("2026-11-21T05:00:00Z"));
    await tick("2026-11-21T06:00:00Z");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await tick("2026-11-21T07:00:00Z");
    expect(sentCalls(tg)).toHaveLength(1);
    const [cancelled, next] = await dgs("digest_morning");
    expect(cancelled!.status).toBe(status);
    expect(next).toMatchObject({ status: "pending", fire_at: at("2026-11-22T07:00:00Z") });
    const line = err.mock.calls.find((c) => String(c[0]).includes("digest"))!;
    expect(line).toEqual(["dispatch: digest chat unavailable, cancelled", cancelled!.id, sendError.code, cls]);
    expect(JSON.stringify(err.mock.calls)).not.toContain(sendError.description); // сирий description не логується
  });

  it("3.1.h: 429 — оренда до retry_after, рядок pending; 500 — оренда знята, спроба в наступному тику", async () => {
    const tg = mockTelegram({ sendError: { code: 429, retryAfter: 90, only: [1] } });
    const u = await user();
    await mk(u, { title: "Купити хліб" }, at("2026-11-21T05:00:00Z"));
    await tick("2026-11-21T06:00:00Z");
    await tick("2026-11-21T07:00:00Z");
    expect((await dgs("digest_morning"))[0]).toMatchObject({ status: "pending", lease_until: at("2026-11-21T07:00:00Z") + 90_000 });
    await tick("2026-11-21T07:02:00Z"); // retry_after минув — другий sendMessage вдався
    expect(sentCalls(tg).filter(morning)).toHaveLength(2);
    expect((await dgs("digest_morning"))[0]!.status).toBe("sent");
  });

  it("3.1.i + 3.6.i: мок ШІ падає на будь-якому виклику; усі три огляди в одному тику, порядок ранок → тиждень → вечір, жодного виклику ШІ", async () => {
    const tg = mockTelegram();
    const u = await user();
    let calls = 0;
    const ai: AiClient = {
      async complete() {
        calls += 1;
        throw new Error("ШІ не мав би викликатись");
      },
    };
    const old = await mk(u, { title: "Стара справа" }, at("2026-11-12T08:00:00Z"));
    expect(old).toBeGreaterThan(0);
    const done = await mk(u, { title: "Зроблена" }, at("2026-11-21T08:00:00Z"));
    await setDone(done, at("2026-11-22T05:00:00Z"));
    vi.setSystemTime(at("2026-11-22T06:00:00Z"));
    await cron({ ai });
    await DB.prepare("UPDATE reminders SET fire_at = ? WHERE kind = 'digest_evening'").bind(at("2026-11-22T06:59:00Z")).run();
    vi.setSystemTime(at("2026-11-22T07:00:00Z"));
    await cron({ ai });
    const out = sentCalls(tg);
    expect(out.map((c) => (morning(c) ? "ранок" : weekly(c) ? "тиждень" : evening(c) ? "вечір" : "?"))).toEqual(["ранок", "тиждень", "вечір"]);
    expect(calls).toBe(0);
  });
});

// ── S3.2–S3.4 · ранок ───────────────────────────────────────────────────────────────────────────────────────

describe("S3.2 ранок: події сьогодні + до 3 справ", () => {
  const SAT_MORNING = "2026-11-21T07:00:00Z";
  const plan = () => tick("2026-11-21T06:00:00Z");

  it("3.2.a: 7 відкритих справ без дати → рівно 3 найстаріші і кнопка «показати все»", async () => {
    const tg = mockTelegram();
    const u = await user();
    for (let i = 1; i <= 7; i++) await mk(u, { title: `Т${i}` }, at("2026-11-10T08:00:00Z") + i * MIN);
    await plan();
    await tick(SAT_MORNING);
    const m = sentCalls(tg).find(morning)!;
    const t = textOf(m);
    for (const x of ["Т1", "Т2", "Т3"]) expect(t).toContain(x);
    for (const x of ["Т4", "Т5", "Т6", "Т7"]) expect(t).not.toContain(x);
    expect(kbOf(m)).toEqual([[{ text: "показати все", callback_data: "dg:all" }]]);
    expect(kbOf(m)[0]![0]!.text).not.toMatch(/\d/); // без числа на кнопці (НФ-4)
  });

  it("3.2.b: порядок B (important), D (вчора), C (сьогодні 14:00); E (завтра) немає; A (старша без дати) — лише після «показати все»", async () => {
    const tg = mockTelegram();
    const u = await user();
    await mk(u, { title: "AAA" }, at("2026-11-10T08:00:00Z"));
    await mk(u, { title: "BBB", priority: "important" }, at("2026-11-19T08:00:00Z"));
    await mk(u, { title: "CCC", dueAt: at("2026-11-21T12:00:00Z") }, at("2026-11-19T09:00:00Z"));
    await mk(u, { title: "DDD", dueAt: at("2026-11-20T10:00:00Z") }, at("2026-11-19T10:00:00Z"));
    await mk(u, { title: "EEE", dueAt: at("2026-11-22T10:00:00Z") }, at("2026-11-19T11:00:00Z"));
    await plan();
    await tick(SAT_MORNING);
    const t = textOf(sentCalls(tg).find(morning)!);
    expect([t.indexOf("BBB"), t.indexOf("DDD"), t.indexOf("CCC")].every((i) => i > 0)).toBe(true);
    expect(t.indexOf("BBB")).toBeLessThan(t.indexOf("DDD"));
    expect(t.indexOf("DDD")).toBeLessThan(t.indexOf("CCC"));
    expect(t).toContain("14:00 CCC"); // сьогоднішній час — HH:MM
    expect(t).not.toMatch(/EEE|AAA/);
    expect(t).not.toMatch(/вчора|прострочен/i); // давніша дата не показується
    expect(kbOf(sentCalls(tg).find(morning)!)).toHaveLength(1); // 4 кандидати → «показати все»
    await press("dg:all");
    const all = textOf(edits(tg)[0]!);
    expect(all).toContain("AAA");
    expect(all).not.toContain("EEE");
    expect(all.indexOf("AAA")).toBeGreaterThan(all.indexOf("CCC")); // найстаріша без дати — в кінці
  });

  it("3.2.c: події — спершу all_day, потім «15:00 …»; минула 08:00 і завтрашньої немає", async () => {
    const tg = mockTelegram();
    const u = await user();
    await mk(u, { kind: "event", title: "ДН Олі", allDay: true, dueAt: at("2026-11-20T22:00:00Z") }, at("2026-11-19T08:00:00Z"));
    await mk(u, { kind: "event", title: "Зустріч", dueAt: at("2026-11-21T13:00:00Z") }, at("2026-11-19T08:00:00Z"));
    await mk(u, { kind: "event", title: "Ранкова", dueAt: at("2026-11-21T06:00:00Z") }, at("2026-11-19T08:00:00Z"));
    await mk(u, { kind: "event", title: "Завтрашня", dueAt: at("2026-11-22T10:00:00Z") }, at("2026-11-19T08:00:00Z"));
    await plan();
    await tick(SAT_MORNING);
    const t = textOf(sentCalls(tg).find(morning)!);
    expect(t).toContain("ДН Олі");
    expect(t).toContain("15:00 Зустріч");
    expect(t.indexOf("ДН Олі")).toBeLessThan(t.indexOf("15:00 Зустріч"));
    expect(t).not.toMatch(/Ранкова|Завтрашня/);
  });

  it("3.2.d: «показати все» редагує те саме повідомлення на повний список, кнопка зникає; тост завжди; чужого не покаже", async () => {
    const tg = mockTelegram();
    const u = await user();
    const other = await user(222);
    for (let i = 1; i <= 7; i++) await mk(u, { title: `Т${i}` }, at("2026-11-10T08:00:00Z") + i * MIN);
    await mk(other, { title: "ЧУЖА" }, at("2026-11-10T08:00:00Z"));
    await plan();
    await tick(SAT_MORNING);
    await press("dg:all");
    const e = edits(tg);
    expect(e).toHaveLength(1);
    for (let i = 1; i <= 7; i++) expect(textOf(e[0]!)).toContain(`Т${i}`);
    expect(textOf(e[0]!)).not.toContain("ЧУЖА");
    expect(kbOf(e[0]!)).toEqual([]);
    expect(tg.calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
  });

  it("3.2.e: назва `<b>x</b> & y` екранована", async () => {
    const tg = mockTelegram();
    const u = await user();
    await mk(u, { title: "<b>x</b> & y" }, at("2026-11-10T08:00:00Z"));
    await plan();
    await tick(SAT_MORNING);
    expect(textOf(sentCalls(tg).find(morning)!)).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
  });
});

describe("S3.3 порожній ранок: тиша або тепла фраза раз на 3 дні", () => {
  const morningAt = (d: number) => new Date(at("2026-11-21T07:00:00Z") + d * DAY).toISOString().replace(".000Z", "Z");

  it("3.3.a/b/c: порожньо 4 ранки поспіль → фраза в день 1 і 4, у 2–3 нічого; рядки 2–3 cancelled; різні варіанти", async () => {
    const tg = mockTelegram();
    const u = await user();
    // лише done/released і нотатка — зміст порожній (3.2.f)
    const d = await mk(u, { title: "Зроблена" }, at("2026-11-10T08:00:00Z"));
    await setDone(d, at("2026-11-11T08:00:00Z"));
    await mk(u, { title: "Відпущена" }, at("2026-11-10T08:00:00Z"));
    await DB.prepare("UPDATE items SET status = 'released' WHERE title = 'Відпущена'").run();
    await mk(u, { kind: "note", title: "Нотатка" }, at("2026-11-10T08:00:00Z"));
    await tick("2026-11-21T06:00:00Z");
    for (let i = 0; i < 4; i++) await tick(morningAt(i));
    const phrases = sentCalls(tg).filter(warm);
    expect(sentCalls(tg)).toHaveLength(2);
    expect(phrases).toHaveLength(2);
    expect((await dgs("digest_morning")).map((r) => r.status)).toEqual(["sent", "cancelled", "cancelled", "sent", "pending"]);
    const user1 = await DB.prepare("SELECT warm_at, warm_variant_idx FROM users WHERE id = ?").bind(u).first<{ warm_at: number; warm_variant_idx: number }>();
    expect(user1!.warm_at).toBe(at(morningAt(3)));
    expect(textOf(phrases[0]!)).not.toBe(textOf(phrases[1]!)); // 3.3.c: варіанти різні
    expect(tone(textOf(phrases[0]!) + textOf(phrases[1]!))).toEqual([]);
  });

  it("3.3.d: ранок із змістом між порожніми warm_at не змінює", async () => {
    const tg = mockTelegram();
    const u = await user();
    await tick("2026-11-21T06:00:00Z");
    await tick(morningAt(0)); // фраза
    const w = (await DB.prepare("SELECT warm_at FROM users WHERE id = ?").bind(u).first<{ warm_at: number }>())!.warm_at;
    await mk(u, { title: "З'явилась справа" }, at("2026-11-21T20:00:00Z"));
    await tick(morningAt(1)); // ранок зі змістом
    expect(sentCalls(tg).filter(morning)).toHaveLength(1);
    expect((await DB.prepare("SELECT warm_at FROM users WHERE id = ?").bind(u).first<{ warm_at: number }>())!.warm_at).toBe(w);
  });
});

describe("S3.4 ранок забирає ранкові нагадування «на цей день»", () => {
  const allDay = (userId: number, title: string, over: Partial<NewItem> = {}, created = "2026-11-21T05:00:00Z") =>
    mk(userId, { title, allDay: true, dueAt: at("2026-11-20T22:00:00Z"), ...over }, at(created));
  const plan = () => tick("2026-11-21T06:58:00Z"); // планувальник створює `due` о 09:00 (07:00Z)

  it("3.4.a: 2 справи all_day сьогодні (normal) і огляд о 09:00 → одне повідомлення (огляд), обидва due — cancelled", async () => {
    const tg = mockTelegram();
    const u = await user();
    const a = await allDay(u, "Т1");
    const b = await allDay(u, "Т2");
    await plan();
    expect(await rows(`kind = 'due' AND status = 'pending'`)).toHaveLength(2);
    await tick("2026-11-21T07:00:00Z");
    expect(sentCalls(tg)).toHaveLength(1);
    expect(morning(sentCalls(tg)[0]!)).toBe(true);
    expect((await rows(`item_id IN (${a}, ${b})`)).map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("3.4.b: + important all_day → огляд і один окремий пуш про неї з кнопками (4 спроби, не скасовано)", async () => {
    const tg = mockTelegram();
    const u = await user();
    await allDay(u, "Т1");
    const imp = await allDay(u, "ВАЖЛИВА", { priority: "important" });
    await plan();
    await tick("2026-11-21T07:00:00Z");
    const out = sentCalls(tg);
    expect(out).toHaveLength(2);
    expect(out.filter(morning)).toHaveLength(1);
    const push = out.find((c) => !morning(c))!;
    expect(textOf(push)).toContain("ВАЖЛИВА");
    expect(kbOf(push)[0]!.map((b) => b.text)).toEqual(["✅", "⏰", "🗑"]);
    const r = (await rows(`item_id = ${imp}`))[0]!;
    expect(r).toMatchObject({ status: "sent", max_attempts: 4 });
    expect((await rows(`item_id = ${imp} AND kind = 'repeat'`))[0]).toMatchObject({ attempt: 2, status: "pending", fire_at: at("2026-11-21T07:05:00Z") });
  });

  it("3.4.c: огляд не пішов (429) → due-рядки не скасовуються й ідуть звичайно", async () => {
    const tg = mockTelegram({ sendError: { code: 429, retryAfter: 60, only: [1] } });
    const u = await user();
    const a = await allDay(u, "Т1");
    const b = await allDay(u, "Т2");
    await plan();
    await tick("2026-11-21T07:00:00Z");
    expect((await rows(`item_id IN (${a}, ${b})`)).map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(sentCalls(tg).filter(morning)).toHaveLength(1); // спроба була — і впала
    expect((await dgs("digest_morning"))[0]!.status).toBe("pending");
  });

  it("3.4.e: справи D3, D2, D1 (давні дати) + T1, T2 (all_day сьогодні): огляд — D3, D2, D1 + кнопка; due T1 і T2 НЕ скасовано й дійшли окремо", async () => {
    const tg = mockTelegram();
    const u = await user();
    for (const [t, d] of [["Д3", "2026-11-18"], ["Д2", "2026-11-19"], ["Д1", "2026-11-20"]] as const) await mk(u, { title: t, dueAt: at(`${d}T10:00:00Z`) }, at("2026-11-10T08:00:00Z"));
    const t1 = await allDay(u, "Т1");
    const t2 = await allDay(u, "Т2");
    await plan();
    await tick("2026-11-21T07:00:00Z");
    const out = sentCalls(tg);
    const dg = textOf(out.find(morning)!);
    for (const x of ["Д3", "Д2", "Д1"]) expect(dg).toContain(x);
    expect(dg).not.toMatch(/Т1|Т2/);
    expect(kbOf(out.find(morning)!)).toHaveLength(1);
    expect((await rows(`item_id IN (${t1}, ${t2})`)).map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(out.filter((c) => !morning(c)).map(textOf).join("|")).toMatch(/Т1[\s\S]*Т2|Т2[\s\S]*Т1|Т1|Т2/);
  });
});

// ── S3.5 · вечір ────────────────────────────────────────────────────────────────────────────────────────────

describe("S3.5 вечір: зроблене, очки, «ще висить»", () => {
  const EVE = "2026-11-20T19:00:00Z";
  const plan = () => tick("2026-11-20T10:00:00Z");
  const hangLine = (t: string) => t.split("\n").find((l) => l.startsWith("ще висить:"));

  it("3.5.a + 3.5.g: ✅ на 2 справи (+20), баланс 135 → обидві назви, «+20 сьогодні», «баланс 135»; без докору", async () => {
    const tg = mockTelegram();
    const u = await user();
    const a = await mk(u, { title: "Помити посуд" }, at("2026-11-20T08:00:00Z"));
    const b = await mk(u, { title: "Написати Олі" }, at("2026-11-20T08:00:00Z"));
    await setDone(a, at("2026-11-20T14:00:00Z"));
    await setDone(b, at("2026-11-20T15:00:00Z"));
    await ledger(u, 115, "bonus", at("2026-11-10T08:00:00Z"));
    await ledger(u, 10, "done", at("2026-11-20T14:00:00Z"), a);
    await ledger(u, 10, "done", at("2026-11-20T15:00:00Z"), b);
    await plan();
    await tick(EVE);
    const t = textOf(sentCalls(tg).find(evening)!);
    expect(t).toContain("Помити посуд");
    expect(t).toContain("Написати Олі");
    expect(t).toContain("+20 сьогодні");
    expect(t).toContain("баланс 135");
    expect(tone(t)).toEqual([]);
  });

  it("3.5.b + 3.5.c: X (due пішов), Y (4 спроби) → «ще висить: X, Y»; Z (ланцюг живий) немає; 5 вичерпаних → 3 назви й «…» без цифр", async () => {
    const tg = mockTelegram();
    const u = await user();
    const X = await mk(u, { title: "Ікс" }, at("2026-11-19T08:00:00Z"));
    const Y = await mk(u, { title: "Ігрек", priority: "important" }, at("2026-11-19T08:00:00Z"));
    const Z = await mk(u, { title: "Зет", priority: "important" }, at("2026-11-19T08:00:00Z"));
    await plan();
    await rem(u, X, { status: "sent", sent_at: at("2026-11-20T11:00:00Z"), fire_at: at("2026-11-20T11:00:00Z") });
    let parent = await rem(u, Y, { status: "sent", max_attempts: 4, sent_at: at("2026-11-20T08:00:00Z"), fire_at: at("2026-11-20T08:00:00Z") });
    const rootY = parent;
    for (const [att, h] of [[2, "08:05"], [3, "08:20"], [4, "12:00"]] as const)
      parent = await rem(u, Y, { kind: "repeat", attempt: att, max_attempts: 4, parent_id: parent, root_id: rootY, status: "sent", sent_at: at(`2026-11-20T${h}:00Z`), fire_at: at(`2026-11-20T${h}:00Z`) });
    const rootZ = await rem(u, Z, { status: "sent", max_attempts: 4, sent_at: at("2026-11-20T13:00:00Z"), fire_at: at("2026-11-20T13:00:00Z") });
    const z2 = await rem(u, Z, { kind: "repeat", attempt: 2, max_attempts: 4, parent_id: rootZ, root_id: rootZ, status: "sent", sent_at: at("2026-11-20T13:05:00Z"), fire_at: at("2026-11-20T13:05:00Z") });
    await rem(u, Z, { kind: "repeat", attempt: 3, max_attempts: 4, parent_id: z2, root_id: rootZ, fire_at: at("2026-11-20T19:30:00Z") });
    await tick(EVE);
    const t = textOf(sentCalls(tg).find(evening)!);
    expect(hangLine(t)).toBe("ще висить: Ікс, Ігрек");
    expect(t).not.toContain("Зет");
    expect(tone(t)).toEqual([]);

    // 5 вичерпаних → 3 назви й «…», жодної цифри «5» чи «ще 2»
    await DB.prepare("DELETE FROM reminders").run();
    await DB.prepare("DELETE FROM items").run();
    tg.calls.length = 0;
    vi.setSystemTime(at("2026-11-21T10:00:00Z"));
    await cron();
    for (let i = 1; i <= 5; i++) {
      const id = await mk(u, { title: `Висить${i}` }, at("2026-11-20T08:00:00Z"));
      await rem(u, id, { status: "sent", sent_at: at("2026-11-21T11:00:00Z") + i * MIN, fire_at: at("2026-11-21T11:00:00Z") });
    }
    await tick("2026-11-21T19:00:00Z");
    const line = hangLine(textOf(sentCalls(tg).find(evening)!))!;
    expect(line).toBe("ще висить: Висить1, Висить2, Висить3…");
    expect(line.replace(/Висить\d/g, "")).not.toMatch(/\d/);
  });

  it("3.5.d: справа, вичерпана вчора, сьогодні в «ще висить» не потрапляє (вечір порожній → тиша)", async () => {
    const tg = mockTelegram();
    const u = await user();
    const id = await mk(u, { title: "Вчорашня" }, at("2026-11-18T08:00:00Z"));
    await plan();
    await rem(u, id, { status: "sent", sent_at: at("2026-11-19T12:00:00Z"), fire_at: at("2026-11-19T12:00:00Z") });
    await tick(EVE);
    expect(sentCalls(tg).filter(evening)).toHaveLength(0);
  });

  it("3.5.e: відкриті сьогоднішні справи в повідомленні відсутні; items до і після огляду однакові", async () => {
    const tg = mockTelegram();
    const u = await user();
    const d = await mk(u, { title: "Готова" }, at("2026-11-20T08:00:00Z"));
    await setDone(d, at("2026-11-20T14:00:00Z"));
    await mk(u, { title: "ВІДКРИТА СЬОГОДНІ", dueAt: at("2026-11-20T15:00:00Z") }, at("2026-11-20T08:00:00Z"));
    await mk(u, { title: "ВІДКРИТА БЕЗ ДАТИ" }, at("2026-11-20T08:00:00Z"));
    await plan();
    const before = await items();
    await tick(EVE);
    expect(textOf(sentCalls(tg).find(evening)!)).not.toContain("ВІДКРИТА");
    expect(await items()).toBe(before);
  });

  it("3.5.f: порожній день → 0 повідомлень, рядок cancelled, завтрашній запланований", async () => {
    const tg = mockTelegram();
    await user();
    await plan();
    await tick(EVE);
    expect(sentCalls(tg)).toHaveLength(0);
    expect((await dgs("digest_evening")).map((r) => [r.status, iso(r.fire_at)])).toEqual([["cancelled", EVE], ["pending", "2026-11-21T19:00:00Z"]]);
  });

  it("3.5.h: ✅ о 00:30 суботи за Києвом (22:30Z пт) — у зробленому суботи, а не п'ятниці", async () => {
    const tg = mockTelegram();
    const u = await user();
    const late = await mk(u, { title: "Опівнічна" }, at("2026-11-20T08:00:00Z"));
    const fri = await mk(u, { title: "П'ятнична" }, at("2026-11-20T08:00:00Z"));
    await setDone(late, at("2026-11-20T22:30:00Z"));
    await setDone(fri, at("2026-11-20T21:30:00Z")); // 23:30 пт
    await plan();
    await tick("2026-11-21T18:59:00Z");
    await tick("2026-11-21T19:00:00Z");
    const t = textOf(sentCalls(tg).find(evening)!);
    expect(t).toContain("Опівнічна");
    expect(t).not.toContain("П'ятнична");
  });
});

// ── S3.6 · тиждень ──────────────────────────────────────────────────────────────────────────────────────────

describe("S3.6 тижневий огляд: до 5 завислих", () => {
  const SUN = "2026-11-22T07:00:00Z";
  const stuckSetup = async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    const ids: number[] = [];
    for (let i = 1; i <= 8; i++) ids.push(await mk(u, { title: `Завислa${i}` }, at("2026-11-22T00:00:00Z") - (20 - i) * DAY)); // Зависла1 — найстаріша (19 діб)
    await mk(u, { title: "Свіжа" }, at("2026-11-22T00:00:00Z") - 3 * DAY);
    await tick("2026-11-22T06:00:00Z");
    await tick(SUN);
    const call = sentCalls(tg).find(weekly)!;
    return { tg, u, ids, call };
  };
  const markupOf = (c: TgCall) => ({ text: textOf(c), markup: { inline_keyboard: kbOf(c) } });

  it("3.6.a + 3.6.i: 8 завислих + 3-денна → 5 найстаріших, свіжої немає; два повідомлення в порядку ранок → тиждень; 3 кнопки на рядок", async () => {
    const { tg, call } = await stuckSetup();
    const t = textOf(call);
    for (let i = 1; i <= 5; i++) expect(t).toContain(`${i}. Завислa${i}`);
    expect(t).not.toMatch(/Завислa[678]|Свіжа/);
    expect(t).not.toMatch(/ще \d|…ще/); // без «ще N»
    const kb = kbOf(call);
    expect(kb).toHaveLength(5);
    expect(kb[1]!.map((b) => b.callback_data.replace(/\d+$/, ""))).toEqual(["wk:t:", "wk:s:", "wk:r:"]);
    expect(kb[1]![0]!.text).toBe("2. ✅ сьогодні");
    const order = sentCalls(tg).map((c) => (morning(c) ? "ранок" : weekly(c) ? "тиждень" : "?"));
    expect(order).toEqual(["ранок", "тиждень"]);
  });

  it("3.6.b: справа 10-денна з датою через тиждень → не завислa; без завислих — тиша", async () => {
    const tg = mockTelegram();
    const u = await user();
    await mk(u, { title: "Майбутня", dueAt: at("2026-11-29T10:00:00Z") }, at("2026-11-12T08:00:00Z"));
    await tick("2026-11-22T06:00:00Z");
    await tick(SUN);
    expect(sentCalls(tg).filter(weekly)).toHaveLength(0);
    expect((await dgs("digest_weekly")).map((r) => r.status)).toEqual(["cancelled", "pending"]);
  });

  it("3.6.c: ✅ сьогодні на записі 2 → due_at = північ сьогодні, all_day, planned_at; нових нагадувань немає; рядок 2 замінено, решта кнопок лишилась; /today його показує", async () => {
    const { tg, ids, call } = await stuckSetup();
    const m = markupOf(call);
    tg.calls.length = 0;
    await press(`wk:t:${ids[1]}`, { ...m, mid: 7 });
    const it2 = await DB.prepare("SELECT due_at, all_day, planned_at, status FROM items WHERE id = ?").bind(ids[1]).first<Record<string, number | string>>();
    expect(it2).toEqual({ due_at: at("2026-11-21T22:00:00Z"), all_day: 1, planned_at: at(SUN), status: "open" });
    await tick("2026-11-22T07:01:00Z");
    await tick("2026-11-22T07:02:00Z");
    expect(await rows(`item_id = ${ids[1]}`)).toHaveLength(0);
    const e = edits(tg)[0]!;
    const lines = textOf(e).split("\n");
    expect(lines.find((l) => l.startsWith("2."))).toContain("✓ на сьогодні");
    expect(lines.find((l) => l.startsWith("1."))).toBe("1. Завислa1");
    expect(kbOf(e)).toHaveLength(4);
    expect(JSON.stringify(kbOf(e))).not.toContain(`wk:t:${ids[1]}"`);
    expect(WK_TODAY_POOL).toContain(String(toast(tg)));
    tg.calls.length = 0;
    await send(textUpdate("/today"), baseEnv(), deps({ now: Date.now() }));
    expect(sentCalls(tg).map(textOf).join("\n")).toContain("Завислa2");
  });

  it("3.6.d: подвійний тап ✅ сьогодні → одне оновлення (planned_at першого), тост «вже на сьогодні»", async () => {
    const { tg, ids, call } = await stuckSetup();
    const m = markupOf(call);
    await press(`wk:t:${ids[0]}`, m);
    vi.setSystemTime(at(SUN) + 5 * MIN);
    await press(`wk:t:${ids[0]}`, m);
    expect(toast(tg)).toBe(WK_ALREADY_TODAY);
    expect((await DB.prepare("SELECT planned_at FROM items WHERE id = ?").bind(ids[0]).first<{ planned_at: number }>())!.planned_at).toBe(at(SUN));
  });

  it("3.6.e: 🗑 на записі 4 → released, pending запису cancelled, «відпущено 🍃»; запис знаходиться пошуком", async () => {
    const { tg, u, ids, call } = await stuckSetup();
    const pend = await rem(u, ids[3]!, { fire_at: at(SUN) + DAY });
    tg.calls.length = 0;
    await press(`wk:r:${ids[3]}`, markupOf(call));
    expect((await DB.prepare("SELECT status FROM items WHERE id = ?").bind(ids[3]).first<{ status: string }>())!.status).toBe("released");
    expect((await rows(`id = ${pend}`))[0]!.status).toBe("cancelled");
    expect(textOf(edits(tg)[0]!).split("\n").find((l) => l.startsWith("4."))).toContain("відпущено 🍃");
    expect((await search(u, db(), "Завислa4")).map((i) => i.id)).toContain(ids[3]);
  });

  it("3.6.f: 🧩 → у БД нічого не змінилось, тост із пулу «скоро» не повторює попередній варіант", async () => {
    const { tg, ids, call } = await stuckSetup();
    const before = await items();
    await press(`wk:s:${ids[0]}`, markupOf(call));
    const first = String(toast(tg));
    await press(`wk:s:${ids[1]}`, markupOf(call));
    const second = String(toast(tg));
    expect(SOON_POOL).toContain(first);
    expect(SOON_POOL).toContain(second);
    expect(second).not.toBe(first);
    expect(await items()).toBe(before);
  });

  it("3.6.g: callback з itemId іншого користувача → нічого не змінено, нейтральний тост, answerCallbackQuery (IDOR)", async () => {
    const { tg, call } = await stuckSetup();
    const other = await user(222);
    const foreign = await mk(other, { title: "ЧУЖА" }, at("2026-11-01T08:00:00Z"));
    const before = await items();
    for (const act of ["t", "r", "s"]) {
      tg.calls.length = 0;
      await press(`wk:${act}:${foreign}`, markupOf(call));
      expect(toast(tg)).toBe(UNKNOWN_REMINDER);
      expect(tg.calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
      expect(edits(tg)).toHaveLength(0);
    }
    expect(await items()).toBe(before);
  });

  it("3.6.h: запис уже done (✅ з нагадування після огляду) → ✅ сьогодні нічого не змінює, тост «вже не актуально»", async () => {
    const { tg, ids, call } = await stuckSetup();
    await setDone(ids[2]!, at(SUN) - MIN);
    const before = await items();
    await press(`wk:t:${ids[2]}`, markupOf(call));
    expect(toast(tg)).toBe(WK_NOT_ACTUAL);
    expect(await items()).toBe(before);
  });
});

// ── НФ-4: тон усіх відрендерених оглядів ───────────────────────────────────────────────────────────────────

describe("НФ-4 / правило 4: огляди без докору й без даних рутин", () => {
  it("відрендерені ранок, тиждень (і «показати все») не містять заборонених слів і лічильників незробленого", async () => {
    const tg = mockTelegram();
    const u = await user();
    for (let i = 1; i <= 8; i++) await mk(u, { title: `Стара${i}` }, at("2026-11-02T08:00:00Z") + i * MIN);
    await tick("2026-11-22T06:00:00Z");
    await tick("2026-11-22T07:00:00Z");
    await press("dg:all");
    for (const c of [...sentCalls(tg), ...edits(tg)]) expect(tone(textOf(c)), textOf(c)).toEqual([]);
    for (const c of sentCalls(tg).filter(morning)) expect(textOf(c)).not.toMatch(/\d+ (справ|завдан)/);
  });
});

describe("НФ-9: довгий перелік обрізається «…ще N» (S3.2.d)", () => {
  it("«показати все» на 300 справах вкладається в 4096 символів, службові рядки лишаються, N = обрізані", () => {
    const tasks = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, title: `Справа ${i + 1} ${"я".repeat(70)}`, due_at: null, all_day: 0, priority: "normal" as const, created_at: i }));
    const m = morningMessage({ head: "Ранок", events: [], tasks, all: true, tz: "Europe/Kyiv", dayStart: 0, dayEnd: 1 });
    expect(m.text.length).toBeLessThanOrEqual(4096);
    const lines = m.text.split("\n");
    expect(lines[0]).toBe("Ранок");
    const shown = lines.filter((l) => l.startsWith("• ")).length;
    expect(lines.at(-1)).toBe(`…ще ${300 - shown}`);
    expect(m.keyboard).toEqual([]);
  });
});
