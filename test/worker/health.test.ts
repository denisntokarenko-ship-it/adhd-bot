import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleRequest } from "../../src/app";
import { NOW, baseEnv, deps } from "./helpers";

const get = (e = baseEnv(), now = NOW) => handleRequest(new Request("https://bot.test/health"), e, deps({ now }));

async function setHeartbeat(lastRunAt: number) {
  await env.DB!.prepare("INSERT INTO heartbeat (key, last_run_at) VALUES ('cron', ?1)").bind(lastRunAt).run();
}

beforeEach(async () => {
  await env.DB!.prepare("DELETE FROM heartbeat").run();
});

describe("S0.2 /health", () => {
  it("0.2.a: свіжий прогін — рівно така форма, no-store", async () => {
    await setHeartbeat(NOW - 40_000);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: true,
      env: "preview",
      sha: "abc123def456",
      cron: { last_run_at: NOW - 40_000, age_s: 40, stale: false },
      queue: { pending: 0 },
    });
  });

  it("0.2.b: прогону ще не було — 200, ok:true, stale:true, без дат", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, cron: { last_run_at: null, age_s: null, stale: true } });
  });

  it("0.2.c: межа stale — age_ms > 180000", async () => {
    for (const [age, expected] of [
      [180_000, { age_s: 180, stale: false }],
      [180_001, { age_s: 180, stale: true }],
      [180_400, { age_s: 180, stale: true }],
    ] as const) {
      await env.DB!.prepare("DELETE FROM heartbeat").run();
      await setHeartbeat(NOW - age);
      const body = (await (await get()).json()) as { cron: Record<string, unknown> };
      expect(body.cron).toMatchObject(expected);
    }
  });

  it("0.2.d: D1 кидає — 503 {ok:false,error:'db'} без тексту помилки", async () => {
    const broken = baseEnv({
      DB: {
        prepare() {
          throw new Error("secret SQL detail users.tg_id");
        },
      },
    });
    const res = await get(broken);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"ok":false,"error":"db"}');
  });

  it("0.2.e: без GIT_SHA — «unknown»; у відповіді немає зайвих полів", async () => {
    await setHeartbeat(NOW);
    const body = (await (await get(baseEnv({ GIT_SHA: undefined }))).json()) as Record<string, unknown>;
    expect(body.sha).toBe("unknown");
    expect(Object.keys(body).sort()).toEqual(["cron", "env", "ok", "queue", "sha"]);
  });

  it("POST /health → 405", async () => {
    const res = await handleRequest(new Request("https://bot.test/health", { method: "POST" }), baseEnv(), deps());
    expect(res.status).toBe(405);
  });
});
