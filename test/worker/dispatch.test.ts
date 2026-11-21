// Відправка нагадувань і кнопки на реальному D1 (docs/spec/phase-2.md S2.2–S2.6; крок 2.2). Час фіксований, Telegram — мок.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../../src/db/index";
import { create, type NewItem } from "../../src/db/items";
import { pressDone } from "../../src/db/reminders";
import { ensureUser } from "../../src/db/users";
import { runScheduled } from "../../src/scheduled";
import { ACK_OK_POOL, ALREADY_DONE_POOL, ALREADY_SNOOZED, UNKNOWN_REMINDER } from "../../src/texts";
import { NOW, baseEnv, deps, mockTelegram, send, type TgCall } from "./helpers";

const DB = env.DB!;
const db = () => openDb(baseEnv());
const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);

beforeEach(async () => {
  for (const t of ["reminders", "points_ledger", "ai_calls", "items", "capture_fixes", "captures", "users"]) await DB.prepare(`DELETE FROM ${t}`).run();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW); // 12:00 пт 20.11 Київ — не тиша
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const clock = { now: () => Date.now() };
const cron = () => runScheduled(baseEnv(), clock, { rand: () => 0 });
const at$ = (ms: number) => vi.setSystemTime(ms);

const user = async (tgId = 111) => (await ensureUser(tgId, db(), Date.now())).id;
const mkItem = async (userId: number, over: Partial<NewItem> = {}) =>
  (await create(userId, db(), { kind: "task", title: "подзвонити мамі", source: "text", ...over }, Date.now())).id;

interface Rem {
  id: number;
  item_id: number;
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
const rems = async (where = "1=1") => (await DB.prepare(`SELECT * FROM reminders WHERE item_id IS NOT NULL AND (${where}) ORDER BY id`).all<Rem>()).results;

// прямий SQL: рядок із потрібним станом, без планувальника (записи без `due_at` планувальник не чіпає)
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

const item = async (id: number) => (await DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Record<string, unknown>>())!;
const ledger = async () => (await DB.prepare("SELECT delta, reason, item_id FROM points_ledger").all<{ delta: number; reason: string; item_id: number }>()).results;
const sent = (tg: ReturnType<typeof mockTelegram>) => tg.calls.filter((c) => c.method === "sendMessage");
const kbOf = (c: TgCall) => (c.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;

let cbId = 9000;
const press = (data: string, o: { from?: number; mid?: number } = {}) =>
  send(
    {
      update_id: ++cbId,
      callback_query: {
        id: `cb${cbId}`,
        chat_instance: "x",
        from: { id: o.from ?? 111, is_bot: false, first_name: "T" },
        data,
        message: { message_id: o.mid ?? 1, date: 0, chat: { id: o.from ?? 111, type: "private" } },
      },
    },
    baseEnv(),
    deps({ now: Date.now() }),
  );
const toast = (tg: ReturnType<typeof mockTelegram>) => tg.calls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text;

describe("S2.3 відправка", () => {
  it("2.3.a: due → повідомлення з екранованою назвою й кнопками ✅ ⏰ 🗑; рядок sent з усіма полями", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    const i = await mkItem(u, { title: "<b>купити</b> & мамі" });
    const r = await rem(u, i);
    await cron();
    expect(sent(tg)).toHaveLength(1);
    const msg = sent(tg)[0]!;
    expect(msg.body.chat_id).toBe(111);
    expect(String(msg.body.text)).toContain("&lt;b&gt;купити&lt;/b&gt; &amp; мамі");
    expect(kbOf(msg)[0]!.map((b) => [b.text, b.callback_data])).toEqual([
      ["✅", `rm:${r}:ok`],
      ["⏰", `rm:${r}:later`],
      ["🗑", `rm:${r}:rel`],
    ]);
    for (const b of kbOf(msg).flat()) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
    expect(await rems()).toMatchObject([{ status: "sent", sent_at: NOW, sent_as: "single", tg_message_id: 101, variant_idx: 0, lease_until: null }]);
  });

  it("2.3.a: eve_before — кнопки 👍 ⏰ 🗑, ✅ немає", async () => {
    const tg = mockTelegram();
    const u = await user();
    const r = await rem(u, await mkItem(u), { kind: "eve_before" });
    await cron();
    expect(kbOf(sent(tg)[0]!)[0]!.map((b) => b.text)).toEqual(["👍", "⏰", "🗑"]);
    expect(kbOf(sent(tg)[0]!)[0]![0]!.callback_data).toBe(`rm:${r}:ack`);
  });

  it("2.2.a/b: important — рівно 4 відправки (5, 15, 30 хв від фактичної), нащадка після 4-ї немає", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    const i = await mkItem(u, { dueAt: NOW, priority: "important" });
    await cron(); // планувальник створює due (4), цей самий тик його відправляє
    expect(sent(tg)).toHaveLength(1);
    const [t1] = await rems();
    expect(t1).toMatchObject({ kind: "due", attempt: 1, status: "sent", sent_at: NOW });
    const steps: [number, number][] = [
      [5, 2],
      [15, 3],
      [30, 4],
    ];
    let t = NOW;
    for (const [delay, attempt] of steps) {
      // за мить до — нічого не йде
      at$(t + delay * MIN - 1000);
      await cron();
      expect(sent(tg)).toHaveLength(attempt - 1);
      t += delay * MIN;
      at$(t);
      await cron();
      expect(sent(tg)).toHaveLength(attempt);
    }
    const all = await rems();
    expect(all.map((r) => [r.kind, r.attempt, r.status])).toEqual([["due", 1, "sent"], ["repeat", 2, "sent"], ["repeat", 3, "sent"], ["repeat", 4, "sent"]]);
    expect(all.slice(1).every((r) => r.parent_id !== null && r.root_id === all[0]!.id)).toBe(true);
    at$(t + 6 * 3_600_000); // дуже пізніше: п'ятої спроби немає, запис лишається open
    await cron();
    expect(sent(tg)).toHaveLength(4);
    expect((await item(i)).status).toBe("open");
    // тексти: наполегливість росте, але без провини (НФ-4)
    expect(sent(tg).map((c) => String(c.body.text)).join(" ")).not.toMatch(/пропустив|забув|знову/i);
  });

  it("2.2.c: normal — одна відправка, нащадка немає", async () => {
    const tg = mockTelegram();
    const u = await user();
    await mkItem(u, { dueAt: NOW });
    await cron();
    at$(NOW + 3_600_000);
    await cron();
    expect(sent(tg)).toHaveLength(1);
    expect((await rems()).map((r) => r.kind)).toEqual(["due"]);
  });

  it("2.2.d: затримка від ФАКТИЧНОЇ відправки: due о 12:00 пішло о 12:03 → друга о 12:08", async () => {
    mockTelegram();
    const u = await user();
    const i = await mkItem(u, { priority: "important" });
    await rem(u, i, { fire_at: NOW, max_attempts: 4 });
    at$(NOW + 3 * MIN);
    await cron();
    const [, child] = await rems();
    expect(child).toMatchObject({ kind: "repeat", attempt: 2, fire_at: NOW + 8 * MIN, status: "pending" });
  });

  it("2.5.e/2.2.f: ✅ між двома повторами → другий повтор не йде, жодного нового повідомлення", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    const i = await mkItem(u, { dueAt: NOW, priority: "important" });
    await cron();
    expect(sent(tg)).toHaveLength(1);
    const [first] = await rems();
    at$(NOW + MIN);
    await press(`rm:${first!.id}:ok`, { mid: 101 });
    expect((await item(i)).status).toBe("done");
    // «повтор не йде»: нащадок скасовано одразу в ✅, а не лише відсіяно перевіркою перед відправкою
    expect((await rems()).map((r) => [r.attempt, r.status])).toEqual([[1, "answered"], [2, "cancelled"]]);
    at$(NOW + 6 * MIN);
    await cron();
    expect(sent(tg)).toHaveLength(1);
    expect((await rems()).map((r) => [r.attempt, r.status])).toEqual([[1, "answered"], [2, "cancelled"]]);
  });
});

describe("S2.3.c–e помилки Telegram, тиша, STALE", () => {
  it("403 (бота заблоковано) → cancelled + лог з id без тексту; спроба не повторюється", async () => {
    const tg = mockTelegram({ sendError: { code: 403 } });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const u = await user();
    const r = await rem(u, await mkItem(u, { title: "секретна назва" }));
    await cron();
    expect((await rems())[0]).toMatchObject({ id: r, status: "cancelled", lease_until: null, attempt: 1 });
    expect(JSON.stringify(err.mock.calls)).toContain(String(r));
    expect(JSON.stringify(err.mock.calls)).not.toContain("секретна");
    at$(NOW + 5 * MIN);
    await cron();
    expect(sent(tg)).toHaveLength(1); // лише перша спроба
  });

  it("429 → pending, fire_at не змінено, оренда до retry_after; 5xx → оренда знята, спроба не витрачена", async () => {
    mockTelegram({ sendError: { code: 429, retryAfter: 7 } });
    const u = await user();
    const r = await rem(u, await mkItem(u), { max_attempts: 4 });
    await cron();
    expect((await rems())[0]).toMatchObject({ id: r, status: "pending", fire_at: NOW - 1000, attempt: 1, lease_until: NOW + 7000 });
    vi.restoreAllMocks();
    const tg = mockTelegram({ sendError: { code: 500 } });
    at$(NOW + 8000);
    await cron();
    expect((await rems())[0]).toMatchObject({ status: "pending", fire_at: NOW - 1000, attempt: 1, lease_until: null });
    expect(sent(tg)).toHaveLength(1);
    vi.restoreAllMocks();
    const ok = mockTelegram();
    at$(NOW + 70_000);
    await cron();
    expect(sent(ok)).toHaveLength(1);
    expect((await rems())[0]).toMatchObject({ status: "sent" });
  });

  it("429: решта користувача чекає тику (не бомбимо Telegram), рядки не втрачені", async () => {
    const tg = mockTelegram({ sendError: { code: 429, retryAfter: 5 } });
    const u = await user();
    const ids = [await rem(u, await mkItem(u), { fire_at: NOW - 3000 }), await rem(u, await mkItem(u), { fire_at: NOW - 2000 })];
    await cron();
    expect(sent(tg)).toHaveLength(1);
    expect((await rems()).map((r) => r.status)).toEqual(["pending", "pending"]);
    expect((await rems()).map((r) => r.id)).toEqual(ids);
  });

  it("2.3.b: збій між sendMessage і закриттям лишає pending з орендою; через LEASE_MS рядок підбирається знову (допустимий дубль)", async () => {
    const tg = mockTelegram({ seqIds: true });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const u = await user();
    const r = await rem(u, await mkItem(u));
    // закриття рядка падає (як збій процесу після sendMessage): тригер забороняє перехід у `sent`
    await DB.prepare("CREATE TRIGGER zz_no_sent BEFORE UPDATE OF status ON reminders WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'crash'); END").run();
    await cron();
    expect(sent(tg)).toHaveLength(1);
    expect((await rems())[0]).toMatchObject({ id: r, status: "pending", lease_until: NOW + 120_000 }); // повідомлення не втрачено
    await DB.prepare("DROP TRIGGER zz_no_sent").run();
    at$(NOW + 60_000); // оренда ще тримає: другий прогін рядок не бере
    await cron();
    expect(sent(tg)).toHaveLength(1);
    at$(NOW + 121_000); // оренда збігла — рядок піде вдруге й тепер закриється
    await cron();
    expect(sent(tg)).toHaveLength(2);
    expect((await rems())[0]).toMatchObject({ status: "sent", lease_until: null });
  });

  it("2.3.d: запис уже не open → рядок cancelled, повідомлення немає", async () => {
    const tg = mockTelegram();
    const u = await user();
    const i = await mkItem(u);
    await rem(u, i);
    await DB.prepare("UPDATE items SET status = 'done', done_at = ? WHERE id = ?").bind(NOW, i).run();
    await cron();
    expect(sent(tg)).toHaveLength(0);
    expect((await rems())[0]!.status).toBe("cancelled");
  });

  it("2.9.a: тихі години → жодного повідомлення, рядки pending без змін; інший користувач не страждає", async () => {
    at$(at("2026-11-20T00:30:00Z")); // 02:30 Київ
    const tg = mockTelegram();
    const a = await user(111);
    const b = await user(222);
    await DB.prepare("UPDATE users SET quiet_to = quiet_from WHERE id = ?").bind(b).run(); // рівні = тихих годин немає
    const ra = await rem(a, await mkItem(a), { fire_at: Date.now() - 1000 });
    await rem(b, await mkItem(b), { fire_at: Date.now() - 1000 });
    await cron();
    expect(sent(tg).map((c) => c.body.chat_id)).toEqual([222]);
    expect((await rems(`id = ${ra}`))[0]).toMatchObject({ status: "pending", attempt: 1, fire_at: Date.now() - 1000, lease_until: null });
  });

  it("STALE: старше 48 год — мовчки cancelled", async () => {
    const tg = mockTelegram();
    const u = await user();
    await rem(u, await mkItem(u), { fire_at: NOW - 49 * 3_600_000 });
    await cron();
    expect(sent(tg)).toHaveLength(0);
    expect((await rems())[0]!.status).toBe("cancelled");
  });

  it("2.3.e: бюджет прогону — після RUN_BUDGET_MS нових відправок немає, решта pending без оренди", async () => {
    let late = false;
    const tg = mockTelegram({ onSend: () => void (late = true) });
    const a = await user(111);
    const b = await user(222);
    await rem(a, await mkItem(a), { fire_at: NOW - 2000 });
    const rb = await rem(b, await mkItem(b), { fire_at: NOW - 1000 });
    await runScheduled(baseEnv(), { now: () => (late ? NOW + 41_000 : NOW) }, { rand: () => 0 });
    expect(sent(tg)).toHaveLength(1);
    expect((await rems(`id = ${rb}`))[0]).toMatchObject({ status: "pending", lease_until: null, attempt: 1 });
  });

  it("2.3.g: /health.reminders.due рахує pending з fire_at ≤ now", async () => {
    const u = await user();
    await rem(u, await mkItem(u), { fire_at: NOW + 10 * MIN });
    await rem(u, await mkItem(u), { fire_at: NOW - 1000, lease_until: NOW + 999_999 }); // під орендою, але due
    const { handleRequest } = await import("../../src/app");
    const body = (await (await handleRequest(new Request("https://bot.test/health"), baseEnv(), deps())).json()) as { reminders: { due: number } };
    expect(body.reminders).toEqual({ due: 1 });
  });
});

describe("S2.5 гонки", () => {
  it("2.5.a: два cron паралельно (один now) → кожен рядок відправлено рівно один раз", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    for (let n = 0; n < 4; n++) await rem(u, await mkItem(u, { title: `справа ${n}` }), { fire_at: NOW - 1000 - n });
    await Promise.all([cron(), cron()]);
    expect(sent(tg)).toHaveLength(4);
    expect(new Set(sent(tg).map((c) => c.body.text)).size).toBe(4);
    expect((await rems()).map((r) => r.status)).toEqual(["sent", "sent", "sent", "sent"]);
  });

  it("2.5.b: ✅ між claim і відправкою — перед sendMessage перевірка запису → повідомлення немає, рядок cancelled", async () => {
    const u = await user();
    const i1 = await mkItem(u, { title: "перша" });
    const i2 = await mkItem(u, { title: "друга" });
    await rem(u, i1, { fire_at: NOW - 2000 });
    const r2 = await rem(u, i2, { fire_at: NOW - 1000 });
    // під час відправки першої людина закрила другу (✅ у вікні між claim і її відправкою)
    const tg = mockTelegram({ onSend: async (n) => void (n === 1 && (await DB.prepare("UPDATE items SET status = 'done', done_at = ? WHERE id = ?").bind(NOW, i2).run())) });
    await cron();
    expect(sent(tg)).toHaveLength(1);
    expect((await rems(`id = ${r2}`))[0]!.status).toBe("cancelled");
  });

  it("2.5.c: ✅ між sendMessage і закриттям → deleteMessage, нащадка немає, очко рівно одне", async () => {
    const u = await user();
    const i = await mkItem(u, { priority: "important" });
    const r = await rem(u, i, { max_attempts: 4 });
    const row = (await rems())[0]!;
    const tg = mockTelegram({ seqIds: true, onSend: async () => void (await pressDone(u, db(), row as never, NOW)) });
    await cron();
    const calls = tg.calls.filter((c) => c.method === "deleteMessage");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ chat_id: 111, message_id: 101 });
    expect((await rems()).map((x) => [x.id, x.status])).toEqual([[r, "cancelled"]]); // нащадка немає
    expect(await ledger()).toEqual([{ delta: 10, reason: "done", item_id: i }]);
  });
});

describe("S2.4 кнопки", () => {
  async function sentRow(over: Record<string, unknown> = {}, itemOver: Partial<NewItem> = {}) {
    const u = await user();
    const i = await mkItem(u, itemOver);
    const r = await rem(u, i, { status: "sent", ...over });
    return { u, i, r };
  }

  it("2.4.a/b: ✅ → done, +10, message редагується без кнопок; повторний ✅ і подвійний тап — без очок", async () => {
    const tg = mockTelegram();
    const { i, r, u } = await sentRow({ max_attempts: 4 }, { title: "<мама>" });
    await rem(u, i, { kind: "repeat", attempt: 2, max_attempts: 4, parent_id: r, root_id: r, status: "pending", fire_at: NOW + 5 * MIN });
    await press(`rm:${r}:ok`);
    expect(await item(i)).toMatchObject({ status: "done", done_at: NOW });
    expect(await ledger()).toEqual([{ delta: 10, reason: "done", item_id: i }]);
    expect((await rems()).map((x) => x.status)).toEqual(["answered", "cancelled"]);
    expect(ACK_OK_POOL).toContain(toast(tg));
    const edit = tg.calls.find((c) => c.method === "editMessageText")!;
    expect(edit.body.text).toBe("✅ <b>&lt;мама&gt;</b> — зроблено");
    expect(kbOf(edit)).toEqual([]);

    at$(NOW + 3_600_000);
    await press(`rm:${r}:ok`);
    await press(`rm:${r}:ok`);
    expect(ALREADY_DONE_POOL).toContain(toast(tg));
    expect(await ledger()).toHaveLength(1);
    expect((await item(i)).done_at).toBe(NOW); // момент не зсунувся
  });

  it("2.4.b: ✅ з іншого повідомлення того ж запису — теж без очок", async () => {
    mockTelegram();
    const { u, i, r } = await sentRow({ max_attempts: 4 });
    const r2 = await rem(u, i, { kind: "repeat", attempt: 2, max_attempts: 4, parent_id: r, root_id: r, status: "sent", sent_at: NOW - 1, tg_message_id: 9 });
    await press(`rm:${r}:ok`);
    await press(`rm:${r2}:ok`, { mid: 9 });
    expect(await ledger()).toHaveLength(1);
  });

  it("2.4.c: ✅ дає +10 і за вчасний, і за запізнілий — однаково (жодних бонусів)", async () => {
    mockTelegram();
    const a = await sentRow({ fire_at: NOW - 1000 });
    const b = await sentRow({ fire_at: NOW - 30 * 3_600_000 });
    await press(`rm:${a.r}:ok`);
    await press(`rm:${b.r}:ok`);
    expect((await ledger()).map((l) => l.delta)).toEqual([10, 10]);
  });

  it("гонка двох ✅ (Promise.all) → +10 один раз, done_at один", async () => {
    mockTelegram();
    const { i, r } = await sentRow();
    await Promise.all([press(`rm:${r}:ok`), press(`rm:${r}:ok`)]);
    expect(await ledger()).toHaveLength(1);
    expect((await item(i)).status).toBe("done");
  });

  it("2.4.d: ⏰ підміняє клавіатуру того самого повідомлення: +15 хв, +1 год, «Завтра о 09:00», ← назад; back повертає", async () => {
    const tg = mockTelegram();
    const { r } = await sentRow();
    await press(`rm:${r}:later`);
    const m = tg.calls.find((c) => c.method === "editMessageReplyMarkup")!;
    expect(kbOf(m).flat().map((b) => [b.text, b.callback_data])).toEqual([
      ["+15 хв", `rm:${r}:s15`],
      ["+1 год", `rm:${r}:s60`],
      ["Завтра о 09:00", `rm:${r}:tom`],
      ["← назад", `rm:${r}:back`],
    ]);
    await press(`rm:${r}:back`);
    const back = tg.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!;
    expect(kbOf(back)[0]!.map((b) => b.text)).toEqual(["✅", "⏰", "🗑"]);
    expect(tg.calls.some((c) => c.method === "sendMessage")).toBe(false); // не нове повідомлення
  });

  it("2.4.e/f: s15 → новий корінь through +15 хв, snooze_count+1, due_at без змін; подвійний тап — вже відклав", async () => {
    const tg = mockTelegram();
    const { u, i, r } = await sentRow({ max_attempts: 4 }, { priority: "important", dueAt: NOW - MIN });
    const child = await rem(u, i, { kind: "repeat", attempt: 2, max_attempts: 4, parent_id: r, root_id: r, status: "pending", fire_at: NOW + 5 * MIN });
    await press(`rm:${r}:s15`);
    at$(NOW + MIN); // подвійний тап пізніше: fire_at другого кореня відрізнявся б, тож ux_rem_root його б не сховав
    await press(`rm:${r}:s15`);
    const all = await rems();
    expect(all.find((x) => x.id === r)!.status).toBe("answered");
    expect(all.find((x) => x.id === child)!.status).toBe("cancelled");
    const roots = all.filter((x) => x.id !== r && x.id !== child);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ kind: "due", attempt: 1, max_attempts: 4, fire_at: NOW + 15 * MIN, status: "pending", parent_id: null });
    expect(await item(i)).toMatchObject({ snooze_count: 1, due_at: NOW - MIN });
    expect(toast(tg)).toBe(ALREADY_SNOOZED);
    const edit = tg.calls.find((c) => c.method === "editMessageText")!;
    expect(String(edit.body.text)).toMatch(/^⏰ Ок, нагадаю .*12:15$/);
    expect(kbOf(edit)).toEqual([]);
  });

  it("2.4.e: ⏰ на repeat → корінь того ж kind, що й у кореня; інші ланцюги запису не зачеплені", async () => {
    mockTelegram();
    const u = await user();
    const i = await mkItem(u, { kind: "event", dueAt: NOW + 3_600_000 });
    const eve = await rem(u, i, { kind: "eve_before", status: "sent" });
    const leave = await rem(u, i, { kind: "leave_now", max_attempts: 4, status: "pending", fire_at: NOW + 30 * MIN });
    await press(`rm:${eve}:s60`);
    const all = await rems();
    expect(all.find((x) => x.id === leave)!.status).toBe("pending"); // чужий ланцюг не скасовано
    expect(all.find((x) => x.id === eve)!.status).toBe("answered");
    expect(all.at(-1)).toMatchObject({ kind: "eve_before", max_attempts: 1, fire_at: NOW + 60 * MIN, status: "pending" });
  });

  it("2.4.h: 🗑 → released, усі pending запису cancelled, очок немає, запис у БД; текст «Відпустив. Знайдеш пошуком, якщо що»", async () => {
    const tg = mockTelegram();
    const { u, i, r } = await sentRow({ max_attempts: 4 });
    await rem(u, i, { kind: "repeat", attempt: 2, max_attempts: 4, parent_id: r, root_id: r, status: "pending", fire_at: NOW + 5 * MIN });
    await press(`rm:${r}:rel`);
    expect(await item(i)).toMatchObject({ status: "released", done_at: null });
    expect((await rems()).map((x) => x.status)).toEqual(["answered", "cancelled"]);
    expect(await ledger()).toEqual([]);
    expect(String(tg.calls.find((c) => c.method === "editMessageText")!.body.text)).toContain("Відпустив. Знайдеш пошуком, якщо що");
  });

  it("2.4.i: ⏰ і 🗑 на запис, що вже done — нічого не змінюється, відповідь за станом", async () => {
    const tg = mockTelegram();
    const { i, r } = await sentRow();
    await press(`rm:${r}:ok`);
    const before = JSON.stringify([await rems(), await item(i)]);
    await press(`rm:${r}:s15`);
    expect(ALREADY_DONE_POOL).toContain(toast(tg));
    await press(`rm:${r}:rel`);
    expect(JSON.stringify([await rems(), await item(i)])).toBe(before);
    expect((await item(i)).snooze_count).toBe(0);
  });

  it("2.4.i: 🗑 і ✅ на released → «вже відпущено», очок немає", async () => {
    const tg = mockTelegram();
    const { r } = await sentRow();
    await press(`rm:${r}:rel`);
    await press(`rm:${r}:ok`);
    expect(toast(tg)).toBe("вже відпущено");
    expect(await ledger()).toEqual([]);
  });

  it("2.5.e: ✅ і ⏰ майже одночасно — виграє перша транзакція, нового кореня «з майбутнього» не лишається", async () => {
    mockTelegram();
    const { u, i, r } = await sentRow();
    await Promise.all([press(`rm:${r}:ok`), press(`rm:${r}:s15`)]);
    expect((await item(i)).status).toBe("done");
    expect(await rems("status = 'pending'")).toEqual([]);
    expect(await ledger()).toHaveLength(1);
    void u;
  });

  it("2.4.l: 👍 на eve_before (і ok зі старої клавіатури) не закриває запис: open, leave_now pending, 0 очок", async () => {
    const tg = mockTelegram();
    const u = await user();
    const i = await mkItem(u, { kind: "event", dueAt: NOW + 3_600_000 });
    const eve = await rem(u, i, { kind: "eve_before", status: "sent" });
    const leave = await rem(u, i, { kind: "leave_now", max_attempts: 4, status: "pending", fire_at: NOW + 30 * MIN });
    await press(`rm:${eve}:ack`);
    expect(String(tg.calls.find((c) => c.method === "editMessageText")!.body.text)).toBe("👍 <b>подзвонити мамі</b> — ок");
    await press(`rm:${eve}:ok`); // стара клавіатура
    expect((await item(i)).status).toBe("open");
    expect((await rems(`id = ${leave}`))[0]!.status).toBe("pending");
    expect((await rems(`id = ${eve}`))[0]!.status).toBe("answered");
    expect(await ledger()).toEqual([]);
  });

  it("2.4.m: чужий reminder_id → «не знаю такого», нічого не змінено", async () => {
    const tg = mockTelegram();
    await user(222);
    const { i, r } = await sentRow();
    const before = JSON.stringify([await rems(), await item(i)]);
    await press(`rm:${r}:ok`, { from: 222 });
    expect(toast(tg)).toBe(UNKNOWN_REMINDER);
    await press(`rm:${r}:rel`, { from: 222 });
    await press(`rm:${r}:s15`, { from: 222 });
    expect(JSON.stringify([await rems(), await item(i)])).toBe(before);
    expect(await ledger()).toEqual([]);
  });

  it("2.4.j: збій редагування повідомлення не скасовує зміну стану й не ламає відповідь на callback", async () => {
    const tg = mockTelegram({ failMethods: ["editMessageText"] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { i, r } = await sentRow();
    const res = await press(`rm:${r}:ok`);
    expect(res.status).toBe(200);
    expect((await item(i)).status).toBe("done");
    expect(ACK_OK_POOL).toContain(toast(tg));
  });

  it("2.10.b: підряд ✅ ⏰ ✅ — підтвердження ✅ не повторюється дослівно (колонка на пул)", async () => {
    const tg = mockTelegram();
    const a = await sentRow();
    const b = await sentRow();
    const c = await sentRow();
    await press(`rm:${a.r}:ok`);
    const t1 = toast(tg);
    await press(`rm:${b.r}:s15`);
    await press(`rm:${c.r}:ok`);
    expect(toast(tg)).not.toBe(t1);
  });
});

describe("S2.6 анти-шум", () => {
  async function many(u: number, n: number, over: (k: number) => Record<string, unknown> = () => ({})) {
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(await rem(u, await mkItem(u, { title: `справа ${k}` }), { fire_at: NOW - 1000 + k, ...over(k) }));
    return out;
  }

  it("2.6.a: 8 нагадувань в одну годину → 6 окремих + 1 зведення з двома; 9-й в ту ж годину чекає", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    await many(u, 8);
    await cron();
    expect(sent(tg)).toHaveLength(7);
    const all = await rems();
    expect(all.filter((r) => r.sent_as === "single")).toHaveLength(6);
    const summary = all.filter((r) => r.sent_as === "summary");
    expect(summary).toHaveLength(2);
    expect(new Set(summary.map((r) => r.tg_message_id)).size).toBe(1);
    const msg = sent(tg).at(-1)!;
    expect(String(msg.body.text).split("\n").filter((l) => l.startsWith("•"))).toHaveLength(2);
    // кнопки ✅ 1, ✅ 2 і після відправки «Усе на …» (потрібен id повідомлення)
    expect(kbOf(msg)[0]!.map((b) => b.text)).toEqual(["✅ 1", "✅ 2"]);
    const mk = tg.calls.find((c) => c.method === "editMessageReplyMarkup")!;
    expect(kbOf(mk).flat().map((b) => b.callback_data)).toEqual([...summary.map((r) => `rm:${r.id}:ok`), `sm:${summary[0]!.tg_message_id}:s60`, `sm:${summary[0]!.tg_message_id}:tom`]);

    const [ninth] = await many(u, 1, () => ({ fire_at: NOW + 20 * MIN - 1000 }));
    at$(NOW + 20 * MIN);
    await cron();
    expect(sent(tg)).toHaveLength(7); // 9-й чекає, у вікні 6 окремих + 1 зведення
    expect((await rems(`id = ${ninth}`))[0]).toMatchObject({ status: "pending", attempt: 1, lease_until: null });
    at$(NOW + 61 * MIN); // вікно звільнилось
    await cron();
    expect(sent(tg)).toHaveLength(8);
  });

  it("S2.6 п.1: 2 запізнілих + 1 свіжий → одне зведення з трьох (пуш слідом за зведенням — шум)", async () => {
    const tg = mockTelegram();
    const u = await user();
    await many(u, 3, (k) => ({ fire_at: [NOW - 10 * MIN, NOW - 8 * MIN, NOW - 1000][k]! }));
    await cron();
    expect(sent(tg)).toHaveLength(1);
    expect((await rems()).map((r) => r.sent_as)).toEqual(["summary", "summary", "summary"]);
  });

  it("S2.3.d + S2.6: закриті записи не займають місця в доборі (7 рядків, 2 закриті → 5 окремих, без зведення)", async () => {
    const tg = mockTelegram();
    const u = await user();
    const items: number[] = [];
    for (let k = 0; k < 7; k++) {
      const i = await mkItem(u, { title: `справа ${k}` });
      items.push(i);
      await rem(u, i, { fire_at: NOW - 1000 + k });
    }
    for (const i of items.slice(0, 2)) await DB.prepare("UPDATE items SET status = 'done', done_at = ? WHERE id = ?").bind(NOW, i).run();
    await cron();
    expect(sent(tg)).toHaveLength(5);
    expect((await rems()).map((r) => r.sent_as ?? r.status)).toEqual(["cancelled", "cancelled", "single", "single", "single", "single", "single"]);
  });

  it("2.9.b: один запізнілий + свіжий — обидва окремо", async () => {
    const tg = mockTelegram();
    const u = await user();
    await many(u, 2, (k) => ({ fire_at: [NOW - 10 * MIN, NOW - 1000][k]! }));
    await cron();
    expect(sent(tg)).toHaveLength(2);
    expect((await rems()).map((r) => r.sent_as)).toEqual(["single", "single"]);
  });

  it("2.6.c/f: нащадки рядків-зі-зведення йдуть зведенням, а не пушами; шум не росте", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    // три important, відправлені зведенням о 12:00
    await many(u, 3, (k) => ({ fire_at: NOW - 12 * MIN + k, max_attempts: 4, kind: "due" }));
    // позначимо їх запізнілими: два+ запізнілих → зведення
    await cron();
    expect(sent(tg)).toHaveLength(1);
    const kids = (await rems("kind = 'repeat'")).map((r) => r.attempt);
    expect(kids).toEqual([2, 2, 2]);
    at$(NOW + 5 * MIN + 1000); // нащадки due: батьки — зведення → ≥ 2 повторів-зі-зведення
    await cron();
    expect(sent(tg)).toHaveLength(1); // зведення в останню годину вже було → чекають, не пуш
    expect((await rems("kind = 'repeat' AND status = 'pending'")).length).toBe(3);
    at$(NOW + 61 * MIN);
    await cron();
    expect(sent(tg)).toHaveLength(2); // одне зведення повторів
    expect((await rems("kind = 'repeat' AND attempt = 2")).map((r) => r.sent_as)).toEqual(["summary", "summary", "summary"]);
  });

  it("2.6.b: «Показати ще» і «⏰ Усе на +1 год» у зведенні; 🗑 у зведенні немає", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    await many(u, 10, (k) => ({ fire_at: NOW - 20 * MIN + k })); // усі запізнілі → одне зведення з 10
    await cron();
    expect(sent(tg)).toHaveLength(1);
    const msg = sent(tg)[0]!;
    expect(String(msg.body.text).split("\n").filter((l) => l.startsWith("•"))).toHaveLength(5);
    expect(String(msg.body.text)).toContain("…ще 5");
    const mid = (await rems())[0]!.tg_message_id!;
    await press(`sm:${mid}:more:5`, { mid });
    const edited = tg.calls.filter((c) => c.method === "editMessageText").at(-1)!;
    expect(String(edited.body.text)).toContain("справа 5");
    expect(JSON.stringify(kbOf(edited))).not.toContain(":rel");
    await press(`sm:${mid}:s60`, { mid });
    const roots = (await rems("status = 'pending'")).map((r) => r.fire_at);
    expect(roots).toHaveLength(10);
    expect(new Set(roots)).toEqual(new Set([NOW + 60 * MIN]));
    expect((await DB.prepare("SELECT SUM(snooze_count) AS n FROM items").first<{ n: number }>())!.n).toBe(10);
    await press(`sm:${mid}:s60`, { mid }); // подвійний тап
    expect(toast(tg)).toBe(ALREADY_SNOOZED);
    expect((await DB.prepare("SELECT SUM(snooze_count) AS n FROM items").first<{ n: number }>())!.n).toBe(10);
  });

  it("2.4.m: sm: чужого повідомлення (той самий tg_message_id у чаті іншого користувача) → «не знаю такого»", async () => {
    const tg = mockTelegram({ seqIds: true });
    const u = await user();
    await user(222);
    await many(u, 3, (k) => ({ fire_at: NOW - (20 - k) * MIN }));
    await cron();
    const mid = (await rems())[0]!.tg_message_id!;
    const before = JSON.stringify(await rems());
    await press(`sm:${mid}:s60`, { from: 222, mid });
    expect(toast(tg)).toBe(UNKNOWN_REMINDER);
    expect(JSON.stringify(await rems())).toBe(before);
  });
});
