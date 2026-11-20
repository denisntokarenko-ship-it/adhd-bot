import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../../src/app";
import { systemClock } from "../../src/clock";
import worker from "../../src/index";
import { PING_TIMEOUT_MS, runScheduled } from "../../src/scheduled";
import { NOW, baseEnv, deps } from "./helpers";

const URL_SECRET = "https://hc-ping.example/00000000-secret-uuid";
const clock = { now: () => NOW };

interface Row {
  key: string;
  last_run_at: number;
  last_ping_ok_at: number | null;
}
const rows = async () => (await env.DB!.prepare("SELECT * FROM heartbeat").all<Row>()).results;
const health = async (e = baseEnv(), now = NOW) =>
  (await (await handleRequest(new Request("https://bot.test/health"), e, deps({ now }))).json()) as Record<string, unknown>;
const withPing = (extra: Record<string, unknown> = {}) => baseEnv({ MONITOR_PING_URL: URL_SECRET, ...extra });

function mockPing(impl: () => Promise<Response> | Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => impl());
}
const allLogs = (spies: ReturnType<typeof vi.spyOn>[]) => JSON.stringify(spies.flatMap((s) => s.mock.calls));

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await env.DB!.prepare("DELETE FROM heartbeat").run();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("S0.3 cron-серце", () => {
  it("0.3.a: пише серце, один GET на URL монітора, після успіху last_ping_ok_at = now", async () => {
    const spy = mockPing(() => new Response("OK"));
    await runScheduled(withPing(), clock);
    expect(await rows()).toEqual([{ key: "cron", last_run_at: NOW, last_ping_ok_at: NOW }]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(URL_SECRET);
    expect((spy.mock.calls[0]![1] as RequestInit).method).toBe("GET");
  });

  it("0.3.b: два прогони — один рядок, без помилки", async () => {
    mockPing(() => new Response("OK"));
    await runScheduled(withPing(), clock);
    await runScheduled(withPing(), { now: () => NOW + 30_000 });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ last_run_at: NOW + 30_000, last_ping_ok_at: NOW + 30_000 });
  });

  it("0.3.c: пінг 500 — не кидає, last_run_at оновлено, last_ping_ok_at не змінено, помилка в лозі без URL", async () => {
    await env.DB!.prepare("INSERT INTO heartbeat VALUES ('cron', 1000, 2000)").run();
    mockPing(() => new Response("boom", { status: 500 }));
    await expect(runScheduled(withPing(), clock)).resolves.toBeUndefined();
    expect(await rows()).toEqual([{ key: "cron", last_run_at: NOW, last_ping_ok_at: 2000 }]);
    expect(errSpy).toHaveBeenCalled();
    expect(allLogs([errSpy, warnSpy])).not.toContain("secret-uuid");
  });

  it("0.3.c: мережева помилка пінгу — те саме", async () => {
    await env.DB!.prepare("INSERT INTO heartbeat VALUES ('cron', 1000, 2000)").run();
    mockPing(() => Promise.reject(new TypeError("network down " + URL_SECRET)));
    await expect(runScheduled(withPing(), clock)).resolves.toBeUndefined();
    expect(await rows()).toEqual([{ key: "cron", last_run_at: NOW, last_ping_ok_at: 2000 }]);
    expect(allLogs([errSpy])).not.toContain("secret-uuid");
  });

  it("0.3.c: таймаут 5 с — пінг перервано, прогін завершується, last_ping_ok_at не змінено", async () => {
    const realSetTimeout = globalThis.setTimeout; // справжній годинник: ним міряємо «завис», коли fake-таймери ще не рушили
    const sleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // «Завислий» монітор: fetch сам не завершується НІКОЛИ і реагує лише на abort. Без `signal` у виклику
    // (R3) він не відхилиться — прогін зависне, і тест червоніє, а не проходить «випадково» через TypeError.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_u, init) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    );
    const run = runScheduled(withPing(), clock).then(() => "done" as const);
    for (let i = 0; i < 200 && spy.mock.calls.length === 0; i++) await sleep(5); // серце записано, пінг пішов, таймер 5 с стоїть
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS - 1);
    expect(await Promise.race([run, sleep(50).then(() => "pending" as const)])).toBe("pending"); // до 5 с ще чекаємо
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.race([run, sleep(1_000).then(() => "hung" as const)])).toBe("done"); // рівно на 5 с — перервано
    expect(await rows()).toEqual([{ key: "cron", last_run_at: NOW, last_ping_ok_at: null }]);
  });

  it("0.3.d: запис у D1 кидає — fetch на монітор НЕ викликано, прогін падає", async () => {
    const spy = mockPing(() => new Response("OK"));
    const broken = withPing({
      DB: {
        prepare() {
          throw new Error("d1 down");
        },
      },
    });
    await expect(runScheduled(broken, clock)).rejects.toThrow("d1 down");
    expect(spy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it("0.3.e: preview без MONITOR_PING_URL — без fetch, попередження в лозі, серце записано", async () => {
    const spy = mockPing(() => new Response("OK"));
    await runScheduled(baseEnv(), clock);
    expect(spy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({ last_run_at: NOW, last_ping_ok_at: null });
  });

  it("0.3.e: production без MONITOR_PING_URL — не кидає, console.error на кожен прогін, /health ok:false monitor:missing", async () => {
    const spy = mockPing(() => new Response("OK"));
    const prod = baseEnv({ ENV: "production" });
    await runScheduled(prod, clock);
    await runScheduled(prod, clock);
    expect(spy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(2);
    await env.DB!.prepare("UPDATE heartbeat SET last_run_at = ?1").bind(NOW).run();
    const res = await handleRequest(new Request("https://bot.test/health"), prod, deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, monitor: "missing", env: "production" });
  });

  it("0.2.f: production з MONITOR_PING_URL — форма як у 0.2.a, без поля monitor і без URL у відповіді", async () => {
    await env.DB!.prepare("INSERT INTO heartbeat (key, last_run_at) VALUES ('cron', ?1)").bind(NOW - 5000).run();
    const res = await handleRequest(new Request("https://bot.test/health"), withPing({ ENV: "production" }), deps());
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true });
    expect(text).not.toContain("monitor");
    expect(text).not.toContain("secret-uuid");
  });

  it("/health: після прогону свіжий; через 181 с без нового прогону — stale (setSystemTime)", async () => {
    mockPing(() => new Response("OK"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await runScheduled(withPing(), systemClock);
    expect((await health(withPing(), NOW + 60_000)).cron).toEqual({ last_run_at: NOW, age_s: 60, stale: false });
    expect((await health(withPing(), NOW + 181_000)).cron).toEqual({ last_run_at: NOW, age_s: 181, stale: true });
  });

  it("Worker експортує scheduled(): прогін через waitUntil пише серце", async () => {
    mockPing(() => new Response("OK"));
    const pending: Promise<unknown>[] = [];
    worker.scheduled({} as ScheduledController, withPing(), { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext);
    await Promise.all(pending);
    expect(await rows()).toHaveLength(1);
  });
});
