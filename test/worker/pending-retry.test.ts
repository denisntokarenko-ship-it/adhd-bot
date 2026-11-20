// Cron-підбір pending (виправлення рев'ю Фази 1, п.1): S1.5.b–e, g, h; S1.4.c; S1.7.d; шов 5.
// Мок Claude, мок STT, мок Telegram, справжній D1 в Miniflare, час фіксований.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../../src/app";
import type { AiClient, AiRequest } from "../../src/ai/client";
import type { Stt } from "../../src/ai/stt";
import { AiCallError } from "../../src/ai/client";
import { runScheduled } from "../../src/scheduled";
import { RETRIED_POOL } from "../../src/texts";
import { baseEnv, deps, mockTelegram, send, textUpdate, voiceUpdate } from "./helpers";

const DB = env.DB!;
const FRI = Date.parse("2026-11-20T13:00:00Z"); // 15:00 п'ятниці за Києвом
const MIN = 60_000;

beforeEach(async () => {
  for (const t of ["points_ledger", "ai_calls", "items", "capture_fixes", "captures", "users", "heartbeat"]) await DB.prepare(`DELETE FROM ${t}`).run();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const raw = (over: Record<string, unknown> = {}) => ({
  kind: "task",
  title: "Корм коту",
  body: null,
  due_local: null,
  all_day: false,
  priority: "normal",
  date_unclear: false,
  ...over,
});

function mockAi(respond: (req: AiRequest, n: number) => unknown) {
  const requests: AiRequest[] = [];
  const client: AiClient = {
    async complete(req) {
      requests.push(req);
      const out = await respond(req, requests.length);
      return { text: JSON.stringify(out), stopReason: "end_turn", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
  };
  return { client, requests };
}
const good = (...items: Record<string, unknown>[]) => mockAi(() => ({ items: items.length ? items : [raw()] }));
const down = () =>
  mockAi(() => {
    throw new AiCallError("http", 503);
  });

function mockStt(result: string | Error) {
  const calls: number[] = [];
  const stt: Stt = {
    async transcribe(audio) {
      calls.push(audio.byteLength);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { stt, calls };
}

const rows = async <T = Record<string, unknown>>(sql: string) => (await DB.prepare(sql).all<T>()).results;
const count = async (table: string) => (await DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const textOf = (c: { body: Record<string, unknown> }) => String(c.body.text);
const cap = async () => (await rows<Record<string, unknown>>("SELECT * FROM captures ORDER BY id DESC LIMIT 1"))[0]!;

// Перше (невдале) захоплення — через вебхук, як у житті: pending, спроба 1, повтор через 5 хв.
async function failFirst(text = "завтра лікар і корм", ai: AiClient = down().client, at = FRI) {
  await send(textUpdate(text), baseEnv(), deps({ now: at, ai, stt: null }));
}

interface CronOpts {
  ai?: AiClient | null;
  stt?: Stt | null;
  env?: ReturnType<typeof baseEnv>;
}
const cron = (now: number, o: CronOpts = {}) =>
  runScheduled(o.env ?? baseEnv(), { now: () => now }, { ai: o.ai === undefined ? null : o.ai, stt: o.stt === undefined ? null : o.stt, rand: () => 0 });

describe("S1.5.c/d: cron підбирає pending", () => {
  it("1.5.d: повтор успішний — запасну нотатку замінено розібраним, очка вдруге немає, одне повідомлення «розібрав те, що відклав» + квитанція", async () => {
    const tg = mockTelegram();
    await failFirst();
    const first = await cap();
    expect(first).toMatchObject({ status: "pending", parse_attempts: 1, next_try_at: FRI + 5 * MIN });
    tg.calls.length = 0;

    const ai = good(raw({ kind: "event", title: "Лікар", due_local: "2026-11-21T10:00" }), raw());
    await cron(FRI + 5 * MIN, { ai: ai.client });

    expect(ai.requests).toHaveLength(1);
    expect(await cap()).toMatchObject({ status: "parsed", next_try_at: null, id: first.id });
    expect(await rows("SELECT kind, title, source FROM items ORDER BY id")).toEqual([
      { kind: "event", title: "Лікар", source: "text" },
      { kind: "task", title: "Корм коту", source: "text" },
    ]); // нотатки-заглушки більше немає
    expect(await rows("SELECT delta, reason FROM points_ledger")).toHaveLength(1); // очко одне, з першого разу
    expect(tg.sent()).toHaveLength(1);
    const msg = tg.sent()[0]!;
    const lines = textOf(msg).split("\n");
    expect(RETRIED_POOL).toContain(lines[0]);
    expect(lines.slice(1)).toEqual(["📅 Лікар — завтра, сб 21.11, 10:00", "☑️ Корм коту — без дати"]); // без «+1 ✨»
    expect(msg.body.chat_id).toBe(111);
    const kb = (msg.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]!;
    expect(kb.map((b) => b.callback_data)).toEqual([`fix:${first.id}`]);
    expect((await cap()).receipt_message_id).toBe(1);
    expect((await rows<{ purpose: string; ok: number }>("SELECT purpose, ok FROM ai_calls ORDER BY id DESC LIMIT 1"))[0]).toEqual({ purpose: "parse", ok: 1 });
  });

  it("до next_try_at нічого не відбувається; рівно в next_try_at — підбирається", async () => {
    mockTelegram();
    await failFirst();
    const ai = good();
    await cron(FRI + 5 * MIN - 1, { ai: ai.client });
    expect(ai.requests).toHaveLength(0);
    expect(await cap()).toMatchObject({ status: "pending", parse_attempts: 1 });
    await cron(FRI + 5 * MIN, { ai: ai.client });
    expect(ai.requests).toHaveLength(1);
  });

  it("1.5.c: оренда — підбір ставить next_try_at = now+120 с; два паралельні прогони → один виклик ШІ; наступна хвилина не підбирає знову", async () => {
    mockTelegram();
    await failFirst();
    const ai = mockAi(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { items: [raw()] };
    });
    const t = FRI + 5 * MIN;
    await Promise.all([cron(t, { ai: ai.client }), cron(t, { ai: ai.client })]);
    expect(ai.requests).toHaveLength(1);
    expect(await count("items")).toBe(1);

    // процес «помер» посеред виклику: оренда є, захоплення лишилось pending → через 120 с підбереться знову
    await DB.prepare("UPDATE captures SET status = 'pending', next_try_at = ?1").bind(t + 120_000).run();
    await cron(t + 119_999, { ai: ai.client });
    expect(ai.requests).toHaveLength(1);
    await cron(t + 120_000, { ai: ai.client });
    expect(ai.requests).toHaveLength(2);
  });

  it("шов 5: захоплення pending без жодного запису (збій D1 між createPending і нотаткою) — теж підбирається і розбирається", async () => {
    const tg = mockTelegram();
    const u = (await DB.prepare("INSERT INTO users (tg_id, created_at, last_seen_at) VALUES (111, 1, 1) RETURNING id").first<{ id: number }>())!;
    await DB.prepare(
      "INSERT INTO captures (user_id, tg_update_id, source, raw_text, status, next_try_at, created_at) VALUES (?1, 5, 'text', 'купити корм', 'pending', ?2, ?3)",
    ).bind(u.id, FRI + 120_000, FRI).run();
    const ai = good();
    await cron(FRI + 120_000, { ai: ai.client });
    expect(await rows("SELECT title FROM items")).toEqual([{ title: "Корм коту" }]);
    expect(await cap()).toMatchObject({ status: "parsed" });
    expect(tg.sent()).toHaveLength(1);
  });

  it("шов 5: без записів і ШІ знову падає — запасна нотатка створюється, запис не губиться", async () => {
    mockTelegram();
    const u = (await DB.prepare("INSERT INTO users (tg_id, created_at, last_seen_at) VALUES (111, 1, 1) RETURNING id").first<{ id: number }>())!;
    await DB.prepare(
      "INSERT INTO captures (user_id, tg_update_id, source, raw_text, status, next_try_at, created_at) VALUES (?1, 5, 'text', 'купити корм', 'pending', ?2, ?3)",
    ).bind(u.id, FRI + 120_000, FRI).run();
    await cron(FRI + 120_000, { ai: down().client });
    expect(await rows("SELECT kind, title, body FROM items")).toEqual([{ kind: "note", title: "купити корм", body: "купити корм" }]);
    expect(await cap()).toMatchObject({ status: "pending", parse_attempts: 1, next_try_at: FRI + 120_000 + 5 * MIN });
  });
});

describe("S1.5.b: невдалі повтори — графік і gave_up", () => {
  it("повтори за графіком 15 хв, 1 год, 3 год, 6 год; після 6-ї невдачі — gave_up, тиша, нотатка лишається", async () => {
    const tg = mockTelegram();
    await failFirst();
    await DB.prepare("UPDATE users SET quiet_from = 0, quiet_to = 0").run(); // шостий повтор припав би на 01:20 — тиха година, тут вона не ціль
    tg.calls.length = 0;
    const ai = down();
    let t = FRI;
    const expected = [15 * MIN, 60 * MIN, 180 * MIN, 360 * MIN]; // затримки після невдач №2..№5
    t += 5 * MIN;
    for (let attempts = 2; attempts <= 5; attempts++) {
      await cron(t, { ai: ai.client });
      const c = await cap();
      expect(c).toMatchObject({ status: "pending", parse_attempts: attempts, next_try_at: t + expected[attempts - 2]! });
      t = c.next_try_at as number;
    }
    await cron(t, { ai: ai.client }); // 6-та невдача
    expect(await cap()).toMatchObject({ status: "gave_up", parse_attempts: 6, next_try_at: null });
    expect(ai.requests).toHaveLength(5);
    expect(await rows("SELECT kind FROM items")).toEqual([{ kind: "note" }]); // нотатка лишилась
    expect(tg.sent()).toHaveLength(0); // людині — тиша

    await cron(t + 24 * 3_600_000, { ai: ai.client }); // gave_up більше ніхто не підбирає
    expect(ai.requests).toHaveLength(5);
  });

  it("ліміт доби: виклику немає, спроба не витрачається, повтор — на початок наступної доби Києва", async () => {
    const tg = mockTelegram();
    await failFirst();
    tg.calls.length = 0;
    const ai = good();
    await cron(FRI + 5 * MIN, { ai: ai.client, env: baseEnv({ AI_DAILY_LIMIT: "0" }) });
    expect(ai.requests).toHaveLength(0);
    expect(await cap()).toMatchObject({ status: "pending", parse_attempts: 1, next_try_at: Date.parse("2026-11-20T22:00:00Z") });
    expect(tg.sent()).toHaveLength(0);
  });
});

describe("S1.5.e: режим тиші — cron pending не чіпає", () => {
  const NIGHT = Date.parse("2026-11-21T00:00:00Z"); // 02:00 Києва: у вікні 23:00–08:00
  const MORNING = Date.parse("2026-11-21T06:00:00Z"); // рівно 08:00 Києва: тиші вже немає

  it("о 02:00 — не чіпає, спроба не витрачається, next_try_at як був; о 08:00 — підбирає", async () => {
    mockTelegram();
    await failFirst();
    const before = await cap();
    const ai = good();
    await cron(NIGHT, { ai: ai.client });
    expect(ai.requests).toHaveLength(0);
    expect(await cap()).toEqual(before);
    await cron(MORNING, { ai: ai.client });
    expect(ai.requests).toHaveLength(1);
    expect(await cap()).toMatchObject({ status: "parsed" });
  });

  it("pause_until > now — не чіпає; pause_until ≤ now — підбирає", async () => {
    mockTelegram();
    await failFirst();
    const t = FRI + 5 * MIN;
    const ai = good();
    await DB.prepare("UPDATE users SET pause_until = ?1").bind(t + 1).run();
    await cron(t, { ai: ai.client });
    expect(ai.requests).toHaveLength(0);
    expect(await cap()).toMatchObject({ status: "pending", parse_attempts: 1 });
    await DB.prepare("UPDATE users SET pause_until = ?1").bind(t).run();
    await cron(t, { ai: ai.client });
    expect(ai.requests).toHaveLength(1);
  });

  it("quiet_from = quiet_to — тихих годин немає", async () => {
    mockTelegram();
    await failFirst();
    await DB.prepare("UPDATE users SET quiet_from = 480, quiet_to = 480").run();
    const ai = good();
    await cron(NIGHT, { ai: ai.client });
    expect(ai.requests).toHaveLength(1);
  });
});

describe("S1.5.g: порядок і межі прогону", () => {
  it("не більше 3 захоплень за прогін; решта — наступної хвилини", async () => {
    mockTelegram();
    for (let i = 0; i < 5; i++) await failFirst(`запис ${i}`, down().client, FRI + i);
    const ai = good();
    const t = FRI + 10 * MIN;
    await cron(t, { ai: ai.client });
    expect(ai.requests).toHaveLength(3);
    expect(await rows("SELECT status FROM captures WHERE status = 'parsed'")).toHaveLength(3);
    await cron(t + MIN, { ai: ai.client });
    expect(ai.requests).toHaveLength(5);
  });

  it("збій самого підбору (D1) не гасить ні серце, ні пінг; помилка в лозі без тексту", async () => {
    mockTelegram();
    const URL = "https://hc-ping.example/00000000-secret-uuid";
    const real = env.DB!;
    const broken = {
      prepare: (sql: string) => {
        if (sql.includes("FROM captures") && sql.includes("pending")) throw new Error("D1 down");
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ping = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("OK"));
    await expect(cron(FRI, { env: baseEnv({ DB: broken, MONITOR_PING_URL: URL }) })).resolves.toBeUndefined();
    expect(ping).toHaveBeenCalledTimes(1);
    expect(await rows("SELECT last_run_at, last_ping_ok_at FROM heartbeat")).toEqual([{ last_run_at: FRI, last_ping_ok_at: FRI }]);
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret-uuid");
  });

  it("збій обробки одного захоплення (ШІ кидає синхронно) не валить прогін і не губить запис", async () => {
    mockTelegram();
    await failFirst();
    const boom: AiClient = {
      complete() {
        throw new Error("sync boom");
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(cron(FRI + 5 * MIN, { ai: boom })).resolves.toBeUndefined();
    expect(await cap()).toMatchObject({ status: "pending", parse_attempts: 2 });
    expect(await count("items")).toBe(1);
  });
});

describe("S1.5.h: /health.queue.pending — справжнє число", () => {
  const pending = async () => {
    const res = await handleRequest(new Request("https://bot.test/health"), baseEnv(), deps({ now: FRI }));
    return ((await res.json()) as { queue: { pending: number } }).queue.pending;
  };

  it("рахує лише pending: parsed і gave_up не рахуються", async () => {
    mockTelegram();
    expect(await pending()).toBe(0);
    await failFirst("один");
    await failFirst("два", down().client, FRI + 1);
    expect(await pending()).toBe(2);
    await DB.prepare("UPDATE captures SET status = 'gave_up', next_try_at = NULL WHERE id = (SELECT MIN(id) FROM captures)").run();
    expect(await pending()).toBe(1);
    await DB.prepare("UPDATE captures SET status = 'parsed', next_try_at = NULL").run();
    expect(await pending()).toBe(0);
  });
});

describe("S1.7.d: голосове — спершу STT, потім розбір", () => {
  async function failVoice() {
    await send(voiceUpdate(8), baseEnv(), deps({ now: FRI, ai: good().client, stt: mockStt(new Error("ai down")).stt }));
  }

  it("STT вдався, розбір вдався: raw_text збережено, заглушку замінено, очко одне, у квитанції розпізнане", async () => {
    const tg = mockTelegram();
    await failVoice();
    expect(await cap()).toMatchObject({ source: "voice", raw_text: null, tg_file_id: "VOICE_FILE", status: "pending", parse_attempts: 1 });
    tg.calls.length = 0;

    const stt = mockStt("купити корм");
    const ai = good();
    await cron(FRI + 5 * MIN, { ai: ai.client, stt: stt.stt });

    expect(stt.calls).toHaveLength(1);
    expect(tg.calls.map((c) => c.method)).toEqual(["getFile", "download", "sendMessage"]);
    expect(await cap()).toMatchObject({ status: "parsed", raw_text: "купити корм", next_try_at: null });
    expect(await rows("SELECT kind, title, source, raw_text FROM items")).toEqual([{ kind: "task", title: "Корм коту", source: "voice", raw_text: "купити корм" }]);
    expect(ai.requests[0]!.user).toContain("купити корм");
    expect(await count("points_ledger")).toBe(1);
    expect(textOf(tg.sent()[0]!)).toContain("🎙 <i>купити корм</i>");
    expect(await count("ai_calls")).toBe(1); // STT в ai_calls не пишеться
  });

  it("STT знову впав: спроба витрачена, ШІ не кликано, заглушка лишається, тиша", async () => {
    const tg = mockTelegram();
    await failVoice();
    tg.calls.length = 0;
    const ai = good();
    await cron(FRI + 5 * MIN, { ai: ai.client, stt: mockStt(new Error("still down")).stt });
    expect(ai.requests).toHaveLength(0);
    expect(await cap()).toMatchObject({ status: "pending", raw_text: null, parse_attempts: 2, next_try_at: FRI + 5 * MIN + 15 * MIN });
    expect(await rows("SELECT title FROM items")).toHaveLength(1);
    expect(tg.sent()).toHaveLength(0);
  });

  it("STT вдався, а ШІ впав: розпізнане збережено в raw_text і в нотатці; наступний повтор STT не кличе", async () => {
    mockTelegram();
    await failVoice();
    const stt = mockStt("купити корм");
    await cron(FRI + 5 * MIN, { ai: down().client, stt: stt.stt });
    expect(await cap()).toMatchObject({ status: "pending", raw_text: "купити корм", parse_attempts: 2 });
    expect(await rows("SELECT kind, title, body, raw_text FROM items")).toEqual([
      { kind: "note", title: "купити корм", body: "купити корм", raw_text: "купити корм" },
    ]);
    const ai = good();
    await cron(FRI + 5 * MIN + 15 * MIN, { ai: ai.client, stt: stt.stt });
    expect(stt.calls).toHaveLength(1); // вдруге не розпізнавали
    expect(ai.requests).toHaveLength(1);
    expect(await cap()).toMatchObject({ status: "parsed" });
  });

  it("розпізнане порожнє (тиша): gave_up без повідомлень, заглушка лишається", async () => {
    const tg = mockTelegram();
    await failVoice();
    tg.calls.length = 0;
    const ai = good();
    await cron(FRI + 5 * MIN, { ai: ai.client, stt: mockStt("").stt });
    expect(ai.requests).toHaveLength(0);
    expect(await cap()).toMatchObject({ status: "gave_up", next_try_at: null });
    expect(tg.sent()).toHaveLength(0);
  });
});
