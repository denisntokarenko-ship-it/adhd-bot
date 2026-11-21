// Виправлення рев'ю Фази 2 (fix/phase-2-review): Б1, Б2, В1, В2 зі звіту docs/reviews/phase-2.md, розд. 7.
// Справжній D1 (Miniflare), Telegram — мок. Кожен тест червоніє на старому коді (`origin/main` 32114ff) або на
// мутанті звіту (R5, R6, R7) — docs/mutants/fix-phase-2-review.*.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiCallError, type AiClient } from "../../src/ai/client";
import { openDb } from "../../src/db/index";
import { create, type NewItem } from "../../src/db/items";
import { ensureUser } from "../../src/db/users";
import type { AppEnv } from "../../src/env";
import { runScheduled } from "../../src/scheduled";
import { NOW, baseEnv, deps, mockTelegram, send, textUpdate } from "./helpers";

const DB = env.DB!;
const db = () => openDb(baseEnv());
const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);

beforeEach(async () => {
  for (const t of ["reminders", "points_ledger", "ai_calls", "items", "capture_fixes", "captures", "users", "heartbeat"]) await DB.prepare(`DELETE FROM ${t}`).run();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const cron = (e: AppEnv = baseEnv(), ai: AiClient | null = null) => runScheduled(e, { now: () => Date.now() }, { ai, stt: null, rand: () => 0 });
const user = async () => (await ensureUser(111, db(), Date.now())).id;
const mk = async (u: number, over: Partial<NewItem>) => (await create(u, db(), { kind: "task", title: "т", source: "text", ...over }, Date.now())).id;
type Row = { id: number; item_id: number; kind: string; attempt: number; max_attempts: number; status: string; sent_at: number | null; parent_id: number | null };
const rems = async () =>
  (await DB.prepare("SELECT id, item_id, kind, attempt, max_attempts, status, sent_at, parent_id FROM reminders ORDER BY id").all<Row>()).results;
const hm = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().slice(11, 16));
async function ticks(from: number, to: number, stepMin = 1, e?: AppEnv) {
  for (let t = from; t <= to; t += stepMin * MIN) {
    vi.setSystemTime(t);
    await cron(e);
  }
}

describe("Б1: подія all_day — не «подія з часом» (один предикат timedEvent)", () => {
  it("P1a: важлива подія на цілий день → 4 спроби (09:00, 09:05, 09:20, 09:50), остання sent без нащадка", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    // «важливо: у суботу день народження мами» — подія на цілий день 21.11: due_at = локальна північ (22:00Z 20.11)
    await mk(u, { kind: "event", title: "ДН мами", allDay: true, dueAt: at("2026-11-20T22:00:00Z"), priority: "important" });
    await cron(); // планувальник: due о 09:00 21.11 (07:00Z), max 4
    await ticks(at("2026-11-21T07:00:00Z"), at("2026-11-21T09:00:00Z"));
    const rows = await rems();
    expect(rows.map((r) => [r.kind, r.attempt, r.status, hm(r.sent_at)])).toEqual([
      ["due", 1, "sent", "07:00"],
      ["repeat", 2, "sent", "07:05"],
      ["repeat", 3, "sent", "07:20"],
      ["repeat", 4, "sent", "07:50"],
    ]);
    expect(tg.sent()).toHaveLength(4);
  });
});

describe("Б2: анти-шум не губить «час виходити» (S2.6 п.1, виняток; 2.6.g)", () => {
  it("P7: 3 important уночі → 08:00 зведення; повтори чекають; подія 08:45 без дороги → «час виходити» окремо о 08:30", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    for (const h of ["00", "01", "02"]) await mk(u, { dueAt: at(`2026-11-21T${h}:00:00Z`), priority: "important", title: `i${h}` }); // 02–04 Київ
    const ev = await mk(u, { kind: "event", title: "автобус", dueAt: at("2026-11-21T06:45:00Z") }); // 08:45 Київ → leave_now 08:30
    await ticks(at("2026-11-20T22:00:00Z"), at("2026-11-21T07:10:00Z"));
    // Ланцюг «час виходити»: 08:30 і 08:35 окремими пушами (обидва до 08:45), 08:50 > 08:45 не створюється; нічого не cancelled
    const chain = (await rems()).filter((r) => r.item_id === ev);
    expect(chain.map((r) => [r.kind, r.status, hm(r.sent_at)])).toEqual([
      ["leave_now", "sent", "06:30"],
      ["repeat", "sent", "06:35"],
    ]);
    expect(tg.sent().filter((c) => String(c.body.text).includes("автобус"))).toHaveLength(2);
    // Повтори зведення так і чекали вікна: 08:00 зведення, наступне — лише о 09:00 (1/год не зламано, 2.6.f)
    const sums = (await DB.prepare("SELECT DISTINCT sent_at FROM reminders WHERE sent_as = 'summary' ORDER BY sent_at").all<{ sent_at: number }>()).results;
    expect(sums.map((r) => hm(r.sent_at))).toEqual(["06:00", "07:00"]);
  });
});

describe("В2 / S2.2.e через dispatch: після останньої спроби leave_now немає жодного нащадка", () => {
  it("подія 14:30, дорога 0 → 14:15, 14:20; 14:35 > 14:30 не створюється (ні pending, ні cancelled)", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    const ev = await mk(u, { kind: "event", title: "зустріч", dueAt: at("2026-11-20T12:30:00Z") }); // 14:30 Київ, сьогодні
    await ticks(NOW, at("2026-11-20T13:00:00Z"));
    const rows = (await rems()).filter((r) => r.item_id === ev);
    expect(rows.map((r) => [r.kind, r.attempt, r.status, hm(r.sent_at)])).toEqual([
      ["leave_now", 1, "sent", "12:15"],
      ["repeat", 2, "sent", "12:20"],
    ]);
    expect(rows.some((r) => r.parent_id === rows.at(-1)!.id)).toBe(false); // «ланцюг вичерпано» = sent без нащадка (2.2.b)
    expect(tg.sent()).toHaveLength(2);
  });
});

// В1 / S2.3.f (борг 0.3.f «для черги нагадувань»): збій однієї частини processQueue не зупиняє решту.
describe("В1 / S2.3.f: збій планувальника чи відправки не гасить пінг і не зупиняє processPending", () => {
  const PING = "https://hc-ping.example/00000000-secret-uuid";
  const real = env.DB!;
  // Proxy над справжнім D1: кидає на `prepare` SQL, що збігся з фрагментом; решта — як є.
  const failingOn = (match: (sql: string) => boolean) =>
    new Proxy(real, {
      get(t, k) {
        if (k === "prepare")
          return (sql: string) => {
            if (match(sql)) throw new Error("D1 down");
            return t.prepare(sql);
          };
        const v = Reflect.get(t, k) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  const good: AiClient = {
    async complete() {
      const item = { kind: "task", title: "Корм коту", body: null, due_local: null, all_day: false, priority: "normal", date_unclear: false };
      return { text: JSON.stringify({ items: [item] }), stopReason: "end_turn", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },
  };
  const down: AiClient = {
    async complete() {
      throw new AiCallError("http", 503);
    },
  };
  // Pending-захоплення (ШІ впав на вебхуку) і рядок нагадування, що вже настав.
  async function seed() {
    await send(textUpdate("корм коту"), baseEnv(), deps({ now: NOW, ai: down, stt: null }));
    const u = (await DB.prepare("SELECT id FROM users").first<{ id: number }>())!.id;
    const task = await mk(u, { title: "подзвонити" });
    await DB.prepare("INSERT INTO reminders (user_id, item_id, kind, fire_at, attempt, max_attempts, created_at) VALUES (?, ?, 'due', ?, 1, 1, ?)")
      .bind(u, task, NOW, NOW)
      .run();
    await DB.prepare("UPDATE items SET planned_at = ? WHERE id = ?").bind(NOW, task).run();
  }
  async function runBroken(match: (sql: string) => boolean) {
    const tg = mockTelegram({ seqIds: true }); // перехоплює й пінг монітора (200)
    await seed();
    tg.calls.length = 0;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.setSystemTime(NOW + 5 * MIN); // повтор розбору настав
    await expect(cron(baseEnv({ DB: failingOn(match), MONITOR_PING_URL: PING }), good)).resolves.toBeUndefined();
    const hb = await DB.prepare("SELECT last_run_at, last_ping_ok_at FROM heartbeat").all();
    const capture = await DB.prepare("SELECT status FROM captures").first<{ status: string }>();
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret-uuid");
    return { tg, hb: hb.results, capture: capture!.status };
  }

  it("R7: планувальник кидає → серце й пінг є, нагадування відправлено, pending розібрано", async () => {
    const { tg, hb, capture } = await runBroken((sql) => sql.includes("planned_at IS NULL") && sql.includes("JOIN users"));
    expect(hb).toEqual([{ last_run_at: NOW + 5 * MIN, last_ping_ok_at: NOW + 5 * MIN }]);
    expect(tg.sent().some((c) => String(c.body.text).includes("подзвонити"))).toBe(true); // відправка відпрацювала
    expect(capture).toBe("parsed"); // processPending відпрацював
    expect((await rems()).find((r) => r.kind === "due")!.status).toBe("sent");
  });

  it("R6: відправка кидає (SQL `reminders`) → серце й пінг є, pending розібрано, рядок нагадування не втрачено", async () => {
    const { tg, hb, capture } = await runBroken((sql) => /\breminders\b/.test(sql));
    expect(hb).toEqual([{ last_run_at: NOW + 5 * MIN, last_ping_ok_at: NOW + 5 * MIN }]);
    expect(capture).toBe("parsed");
    expect(tg.sent().some((c) => String(c.body.text).includes("подзвонити"))).toBe(false);
    expect((await rems()).find((r) => r.kind === "due")!.status).toBe("pending"); // наступний тик підбере
  });
});
