import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../../src/app";
import { FALLBACK_POOL, GREET_POOL, PRIVATE_BOT_TEXT, UNSUPPORTED_POOL } from "../../src/texts";
import { NOW, baseEnv, deps, mockTelegram, post, send, textUpdate, userRows } from "./helpers";

beforeEach(async () => {
  for (const t of ["points_ledger", "ai_calls", "items", "capture_fixes", "captures", "users"]) await env.DB!.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => vi.restoreAllMocks());

describe("S0.1 вебхук і /start", () => {
  it("0.1.a: /start створює рівно один рядок з дефолтами й вітає одним повідомленням", async () => {
    const tg = mockTelegram();
    const res = await send(textUpdate("/start"));
    expect(res.status).toBe(200);
    const rows = await userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tg_id: 111,
      tz: "Europe/Kyiv",
      quiet_from: 1380,
      quiet_to: 480,
      created_at: NOW,
      last_seen_at: NOW,
    });
    expect(tg.sent()).toHaveLength(1);
    expect(GREET_POOL).toContain(tg.sent()[0]!.body.text);
  });

  it("0.1.b: /start вдруге — один рядок, налаштування не змінені, last_seen_at оновлено", async () => {
    mockTelegram();
    await send(textUpdate("/start"), baseEnv(), deps({ now: NOW }));
    await env.DB!.prepare("UPDATE users SET tz = 'Europe/Warsaw', quiet_from = 600").run();
    await send(textUpdate("/start"), baseEnv(), deps({ now: NOW + 60_000 }));
    const rows = await userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tz: "Europe/Warsaw", quiet_from: 600, created_at: NOW, last_seen_at: NOW + 60_000 });
  });

  it("0.1.b: два /start паралельно — теж один рядок", async () => {
    mockTelegram();
    const res = await Promise.all([send(textUpdate("/start")), send(textUpdate("/start"))]);
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    expect(await userRows()).toHaveLength(1);
  });

  it("0.1.c: довільний текст до /start теж створює рядок (ШІ без ключа — запасна нотатка)", async () => {
    const tg = mockTelegram();
    await send(textUpdate("купити молоко"));
    expect(await userRows()).toHaveLength(1);
    expect(FALLBACK_POOL).toContain(tg.sent()[0]!.body.text);
  });

  it("0.1.d: два /start поспіль — різні вітання (індекс у БД, не в пам'яті isolate)", async () => {
    const tg = mockTelegram();
    await send(textUpdate("/start")); // rand=0 завжди: без правила «без повтору» вітання збіглись би
    await send(textUpdate("/start"));
    const [a, b] = tg.sent().map((c) => c.body.text);
    expect(a).not.toBe(b);
    const rows = await userRows();
    expect(rows[0]!.greet_variant_idx).toBeTypeOf("number");
  });

  it("0.1.e: без заголовка чи з неправильним секретом — 401, тіло не розбирається, users не змінено", async () => {
    const tg = mockTelegram();
    for (const secret of [null, "", "wrong", "test-webhook-secreT"]) {
      const res = await handleRequest(post(textUpdate("/start"), secret), baseEnv(), deps());
      expect(res.status).toBe(401);
    }
    // тіло — не JSON: за 401 його ніхто не читає (інакше було б 400)
    const bad = new Request("https://bot.test/webhook", { method: "POST", body: "{not json" });
    expect((await handleRequest(bad, baseEnv(), deps())).status).toBe(401);
    expect(await userRows()).toHaveLength(0);
    expect(tg.calls).toHaveLength(0);
  });

  it("0.1.f: GET /webhook → 405, невідомий шлях → 404, без тіла", async () => {
    const get = await handleRequest(new Request("https://bot.test/webhook"), baseEnv(), deps());
    expect(get.status).toBe(405);
    expect(await get.text()).toBe("");
    const nope = await handleRequest(new Request("https://bot.test/other", { method: "POST" }), baseEnv(), deps());
    expect(nope.status).toBe(404);
    expect(await nope.text()).toBe("");
  });

  it("0.1.g: WEBHOOK_SECRET не заданий / порожній / пробіли — 401 на будь-який запит", async () => {
    const tg = mockTelegram();
    for (const secret of [undefined, "", "   "]) {
      for (const header of [null, "", "   ", "undefined", "test-webhook-secret"]) {
        const res = await handleRequest(post(textUpdate("/start"), header), baseEnv({ WEBHOOK_SECRET: secret }), deps());
        expect(res.status).toBe(401);
      }
    }
    expect(await userRows()).toHaveLength(0);
    expect(tg.calls).toHaveLength(0);
  });
});

describe("S0.6 allowlist і приватний чат", () => {
  it("0.6.a: чужий — без рядка в users, одна статична відповідь", async () => {
    const tg = mockTelegram();
    const res = await send(textUpdate("/start", { from: 999 }));
    expect(res.status).toBe(200);
    expect(await userRows()).toHaveLength(0);
    expect(tg.sent()).toHaveLength(1);
    expect(tg.sent()[0]!.body.text).toBe(PRIVATE_BOT_TEXT);
  });

  it("0.6.b: ALLOWED_TG_IDS порожній чи відсутній — відхиляються всі (fail-closed)", async () => {
    const tg = mockTelegram();
    for (const v of [undefined, "", "  ,  "]) {
      await send(textUpdate("/start", { from: 111 }), baseEnv({ ALLOWED_TG_IDS: v }));
    }
    expect(await userRows()).toHaveLength(0);
    expect(tg.sent()).toHaveLength(3);
    expect(tg.sent().every((c) => c.body.text === PRIVATE_BOT_TEXT)).toBe(true);
  });

  it("0.6.c: «111, 222» розбирається; сміття «abc» — відхиляє всіх, 200 і console.error", async () => {
    mockTelegram();
    await send(textUpdate("/start", { from: 222 }), baseEnv({ ALLOWED_TG_IDS: "111, 222" }));
    expect((await userRows()).map((r) => r.tg_id)).toEqual([222]);

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await send(textUpdate("/start", { from: 111 }), baseEnv({ ALLOWED_TG_IDS: "abc" }));
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    expect((await userRows()).map((r) => r.tg_id)).toEqual([222]);
  });

  it("0.6.d: група (навіть від власника) — без відповіді, без ensureUser", async () => {
    const tg = mockTelegram();
    for (const type of ["group", "supergroup", "channel"]) {
      const res = await send(textUpdate("/today", { from: 111, chatType: type, chatId: -100 }));
      expect(res.status).toBe(200);
    }
    expect(tg.calls).toHaveLength(0);
    expect(await userRows()).toHaveLength(0);
  });

  it("callback_query з приватного чату від власника отримує answerCallbackQuery (НФ-9)", async () => {
    const tg = mockTelegram();
    const upd = {
      update_id: 5,
      callback_query: {
        id: "cb1",
        chat_instance: "x",
        from: { id: 111, is_bot: false, first_name: "T" },
        data: "noop",
        message: { message_id: 1, date: 0, chat: { id: 111, type: "private" } },
      },
    };
    expect((await send(upd)).status).toBe(200);
    expect(tg.calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
  });
});

describe("S0.6 callback_query: allowlist і приватний чат (рев'ю 0.4 В3)", () => {
  const callback = (from: number, chat?: { id: number; type: string }) => ({
    update_id: 50,
    callback_query: {
      id: "cb",
      chat_instance: "x",
      from: { id: from, is_bot: false, first_name: "T" },
      data: "noop",
      ...(chat ? { message: { message_id: 1, date: 0, chat } } : {}),
    },
  });

  it("0.6.a: callback від чужого — без рядка в users, лише статична відповідь на callback", async () => {
    const tg = mockTelegram();
    expect((await send(callback(999, { id: 999, type: "private" }))).status).toBe(200);
    expect(await userRows()).toHaveLength(0);
    expect(tg.calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
    expect(tg.calls[0]!.body.text).toBe(PRIVATE_BOT_TEXT);
  });

  it("0.6.d: callback з групи (навіть від власника) і callback без message — тиша, без запису", async () => {
    const tg = mockTelegram();
    for (const upd of [callback(111, { id: -100, type: "group" }), callback(111, { id: -100, type: "supergroup" }), callback(111)]) {
      expect((await send(upd)).status).toBe(200);
    }
    expect(tg.calls).toHaveLength(0);
    expect(await userRows()).toHaveLength(0);
  });

  it("НФ-9 (Д1): D1 кидає на upsert — callback усе одно отримує answerCallbackQuery, вебхук віддає 200", async () => {
    const tg = mockTelegram();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenDb = { prepare: () => { throw new Error("D1 down"); } };
    const res = await send(callback(111, { id: 111, type: "private" }), baseEnv({ DB: brokenDb }));
    expect(res.status).toBe(200);
    expect(tg.calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
    expect(err).toHaveBeenCalledWith("update failed", expect.any(String));
  });
});

describe("S0.7 стійкість вебхука", () => {
  it("0.7.a/b: обробник кидає — 200 і помилка в лозі (не залежить від bot.catch)", async () => {
    mockTelegram({ failSend: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await send(textUpdate("/start"));
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalledWith("update failed", expect.any(String));
  });

  it("0.7.a: відсутній BOT_TOKEN — теж 200 і лог", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await send(textUpdate("/start"), baseEnv({ BOT_TOKEN: undefined }));
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
  });

  it("0.7.c (S1.4.i): стікер і фото — коротка відповідь, edited_message — тиша; захоплень немає", async () => {
    const tg = mockTelegram();
    const base = { message_id: 1, date: 0, chat: { id: 111, type: "private" }, from: { id: 111, is_bot: false, first_name: "T" } };
    const updates = [
      { update_id: 1, message: { ...base, sticker: { file_id: "a", file_unique_id: "b", type: "regular", width: 1, height: 1, is_animated: false, is_video: false } } },
      { update_id: 2, message: { ...base, photo: [{ file_id: "a", file_unique_id: "b", width: 1, height: 1 }] } },
      { update_id: 3, edited_message: { ...base, edit_date: 1, text: "/start" } },
    ];
    for (const u of updates) expect((await send(u)).status).toBe(200);
    // стікер і фото — по одній короткій відповіді; edited_message ігнорується; нічого не збережено
    expect(tg.sent()).toHaveLength(2);
    for (const c of tg.sent()) expect(UNSUPPORTED_POOL).toContain(c.body.text);
    expect((await env.DB!.prepare("SELECT COUNT(*) AS n FROM captures").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB!.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>())!.n).toBe(0);
  });
});
