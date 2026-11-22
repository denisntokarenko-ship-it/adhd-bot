// /settings, /tz, зміна поясу, меню команд (docs/spec/phase-3-settings-prod.md S3.7–S3.9; крок 3.2).
// Час фіксований (`vi.setSystemTime`), D1 справжній, Telegram — мок. Київ взимку = UTC+2, Лісабон = UTC+0, Варшава = UTC+1.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../../src/db/index";
import { applySetting } from "../../src/db/settings";
import { create, type NewItem } from "../../src/db/items";
import { ensureUser } from "../../src/db/users";
import { planDigests } from "../../src/digests/planner";
import { runScheduled } from "../../src/scheduled";
import { EVENING_CHOICES, MORNING_CHOICES, TZ_CHOICES, digestPromise } from "../../src/settings/choices";
import { SOON_POOL, ST_TZ_HINT, ST_TZ_SAME, ST_TZ_UNKNOWN } from "../../src/texts";
import { baseEnv, deps, mockTelegram, send, textUpdate, type TgCall } from "./helpers";

const DB = env.DB!;
const db = () => openDb(baseEnv());
const MIN = 60_000;
const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
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
const cron = () => runScheduled(baseEnv(), clock, { rand: () => 0 });
const tickAt = async (iso8601: string) => {
  vi.setSystemTime(at(iso8601));
  await cron();
};
const user = async (tgId = 111) => (await ensureUser(tgId, db(), Date.now())).id;
const mk = async (userId: number, over: Partial<NewItem> = {}) => (await create(userId, db(), { kind: "task", title: "справа", source: "text", ...over }, Date.now())).id;
const setU = (userId: number, cols: Record<string, number>) =>
  DB.prepare(`UPDATE users SET ${Object.keys(cols).map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).bind(...Object.values(cols), userId).run();
const U = (userId: number) => DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<Record<string, number | string | null>>();

interface Row {
  id: number;
  user_id: number;
  item_id: number | null;
  kind: string;
  fire_at: number;
  status: string;
  lease_until: number | null;
  max_attempts: number;
}
const rows = async (where = "1=1") => (await DB.prepare(`SELECT * FROM reminders WHERE ${where} ORDER BY id`).all<Row>()).results;
const pending = (kind: string, userId?: number) => rows(`kind = '${kind}' AND status = 'pending'${userId === undefined ? "" : ` AND user_id = ${userId}`}`);
const itemRow = (id: number) => DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<{ due_at: number | null; all_day: number; planned_at: number | null }>();

async function rem(userId: number, itemId: number | null, over: Record<string, unknown> = {}): Promise<number> {
  const all: Record<string, unknown> = { user_id: userId, item_id: itemId, kind: "due", fire_at: NOW - 1000, attempt: 1, max_attempts: 1, created_at: NOW, ...over };
  if (all.status === "sent" || all.status === "answered") {
    all.sent_at ??= NOW - MIN;
    all.sent_as ??= "single";
    all.tg_message_id ??= 5;
  }
  const keys = Object.keys(all);
  return (await DB.prepare(`INSERT INTO reminders (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")}) RETURNING id`).bind(...Object.values(all)).first<{ id: number }>())!.id;
}

type Kb = { text: string; callback_data: string }[][];
const kbOf = (c: TgCall): Kb => (c.body.reply_markup as { inline_keyboard: Kb } | undefined)?.inline_keyboard ?? [];
const textOf = (c: TgCall) => String(c.body.text);
const say = (text: string, from = 111) => send(textUpdate(text, { from }), baseEnv(), deps({ now: Date.now() }));
let cbId = 9000;
const press = (data: string, from = 111) =>
  send(
    {
      update_id: ++cbId,
      callback_query: { id: `cb${cbId}`, chat_instance: "x", from: { id: from, is_bot: false, first_name: "T" }, data, message: { message_id: 1, date: 0, chat: { id: from, type: "private" } } },
    },
    baseEnv(),
    deps({ now: Date.now() }),
  );
const lastEdit = (tg: ReturnType<typeof mockTelegram>) => tg.calls.filter((c) => c.method === "editMessageText").at(-1)!;
const buttons = (c: TgCall) => kbOf(c).flat().map((b) => b.text);
const cbs = (c: TgCall) => kbOf(c).flat().map((b) => b.callback_data);

// ── S3.7: екран і кнопки ────────────────────────────────────────────────────────────────────────────────

describe("S3.7 /settings: одне повідомлення, що редагується", () => {
  it("/settings показує поточні значення й кнопки розділів; вибір значення редагує те саме повідомлення й повертає головний екран", async () => {
    const tg = mockTelegram();
    const u = await user();
    await say("/settings");
    const m = tg.sent().at(-1)!;
    expect(textOf(m)).toContain("Пояс: Київ (Europe/Kyiv)");
    expect(textOf(m)).toContain("Тиха ніч: 23:00–08:00");
    expect(textOf(m)).toContain("Ранок: 09:00");
    expect(textOf(m)).toContain("Вечір: 21:00");
    expect(textOf(m)).toContain("Тижневий огляд: неділя, 09:00");
    expect(textOf(m)).not.toContain("⚠");
    expect(cbs(m)).toEqual(["st:z", "st:q", "st:m", "st:e", "st:d"]);

    await press("st:m");
    expect(buttons(lastEdit(tg))).toContain("10:00");
    await press("st:m:600");
    const home = lastEdit(tg);
    expect(textOf(home)).toContain("Ранок: 10:00");
    expect(textOf(home)).toContain("Тижневий огляд: неділя, 10:00");
    expect(cbs(home)).toEqual(["st:z", "st:q", "st:m", "st:e", "st:d"]); // повернувся головний екран
    expect(tg.sent()).toHaveLength(1); // нових повідомлень немає — лише редагування
    expect((await U(u))!.morning_at).toBe(600);
  });

  it("3.7.j: кнопки поясу — Київ + 4, поточний позначено ✓; callback-и ≤ 64 байти; сміттєвий st:… — головний екран без змін", async () => {
    const tg = mockTelegram();
    const u = await user();
    expect(TZ_CHOICES.map((c) => c.tz)).toEqual(["Europe/Kyiv", "Europe/Warsaw", "Europe/Berlin", "Europe/London", "America/New_York"]);
    expect(MORNING_CHOICES).toHaveLength(12);
    expect(EVENING_CHOICES).toHaveLength(12);
    expect([MORNING_CHOICES[0], MORNING_CHOICES.at(-1)]).toEqual([360, 690]);
    expect([EVENING_CHOICES[0], EVENING_CHOICES.at(-1)]).toEqual([1080, 1410]);
    await say("/settings");
    await press("st:z");
    expect(buttons(lastEdit(tg))).toContain("✓ Київ");
    const all = new Set<string>();
    for (const s of ["st:z", "st:q", "st:qf:1380", "st:m", "st:e", "st:d", "st:zo"]) {
      await press(s);
      for (const c of cbs(lastEdit(tg))) all.add(c);
    }
    for (const c of all) expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(64);
    const before = JSON.stringify(await U(u));
    for (const junk of ["st:", "st:zzz", "st:m:abc", "st:m:99999", "st:d:9", "st:z:7", "st:qt:5:5"]) {
      tg.calls.length = 0;
      await press(junk);
      expect(textOf(lastEdit(tg))).toContain("Налаштування"); // головний екран
    }
    for (const stale of ["st:e:0", "st:m:1380", "st:e:1380"]) await press(stale); // за регексом коректні, але значення не з кнопок
    expect(JSON.stringify(await U(u))).toBe(before);
    expect(await rows()).toHaveLength(0);
  });

  it("день тижня: st:d:6 → тижневий огляд на найближчу суботу, ранок і вечір не зачеплено; той самий день — нічого не змінює", async () => {
    mockTelegram();
    const u = await user();
    await cron(); // огляди заплановано
    const before = { m: await pending("digest_morning", u), e: await pending("digest_evening", u), w: await pending("digest_weekly", u) };
    expect(iso(before.w[0]!.fire_at)).toBe("2026-11-22T07:00:00Z"); // неділя 09:00 Київ
    await press("st:d:6");
    expect((await U(u))!.weekly_dow).toBe(6);
    const w = await pending("digest_weekly", u);
    expect(w).toHaveLength(1);
    expect(iso(w[0]!.fire_at)).toBe("2026-11-21T07:00:00Z"); // субота 21.11 09:00 Київ
    expect((await pending("digest_morning", u))[0]!.id).toBe(before.m[0]!.id);
    expect((await pending("digest_evening", u))[0]!.id).toBe(before.e[0]!.id);
    const cancelledBefore = (await rows("status = 'cancelled'")).length;
    await press("st:d:6");
    expect((await rows("status = 'cancelled'")).length).toBe(cancelledBefore); // нічого не переплановано
  });
});

describe("3.7.a ранок 08:00 → 07:00", () => {
  it("рівно один pending digest_morning на найближчі 07:00; старий cancelled; о 07:00 огляд приходить, о 08:00 — нічого", async () => {
    const tg = mockTelegram();
    const u = await user();
    await setU(u, { morning_at: 480, quiet_to: 420 }); // тиша 23:00–07:00: 07:00 — уже не тиша, кнопка є
    await mk(u, { title: "купити хліб" });
    await cron();
    const old = (await pending("digest_morning", u))[0]!;
    expect(iso(old.fire_at)).toBe("2026-11-21T06:00:00Z"); // 08:00 Київ
    await say("/settings");
    await press("st:m");
    await press("st:m:420");
    const now = await pending("digest_morning", u);
    expect(now).toHaveLength(1);
    expect(iso(now[0]!.fire_at)).toBe("2026-11-21T05:00:00Z"); // 07:00 Київ
    expect((await rows(`id = ${old.id}`))[0]!.status).toBe("cancelled");

    tg.calls.length = 0;
    await tickAt("2026-11-21T05:00:30Z");
    const sent = await rows("kind = 'digest_morning' AND status = 'sent'");
    expect(sent).toHaveLength(1);
    expect(iso(sent[0]!.fire_at)).toBe("2026-11-21T05:00:00Z");
    expect(tg.sent()).toHaveLength(1);
    await tickAt("2026-11-21T06:00:30Z"); // о 08:00 — нічого
    expect(await rows("kind = 'digest_morning' AND status = 'sent'")).toHaveLength(1);
  });

  it("3.7.d подвійний тап одного вибору: pending ранку один, помилки людині немає", async () => {
    const tg = mockTelegram();
    const u = await user();
    await cron();
    await Promise.all([press("st:m:600"), press("st:m:600")]);
    expect(await pending("digest_morning", u)).toHaveLength(1);
    expect(await pending("digest_weekly", u)).toHaveLength(1);
    expect(textOf(lastEdit(tg))).toContain("Ранок: 10:00");
  });

  it("3.7.e: натискання з чужого акаунта змінює лише налаштування натискача", async () => {
    mockTelegram();
    const a = await user(111);
    const b = await user(222);
    await cron();
    const aRows = JSON.stringify(await rows(`user_id = ${a}`));
    await press("st:m:600", 222); // «повідомлення» формально чуже, але ctx.from — 222
    expect((await U(a))!.morning_at).toBe(540);
    expect((await U(b))!.morning_at).toBe(600);
    expect(JSON.stringify(await rows(`user_id = ${a}`))).toBe(aRows);
  });

  it("3.7.g: субота 28.11, ранок 08:00 → 07:00: digest_weekly — неділя 29.11 07:00, старий cancelled", async () => {
    mockTelegram();
    const u = await user();
    await setU(u, { morning_at: 480, quiet_to: 420 });
    vi.setSystemTime(at("2026-11-28T10:00:00Z"));
    await planDigests(db(), Date.now());
    const old = (await pending("digest_weekly", u))[0]!;
    expect(iso(old.fire_at)).toBe("2026-11-29T06:00:00Z"); // неділя 08:00 Київ
    await press("st:m:420");
    const w = await pending("digest_weekly", u);
    expect(w).toHaveLength(1);
    expect(iso(w[0]!.fire_at)).toBe("2026-11-29T05:00:00Z");
    expect((await rows(`id = ${old.id}`))[0]!.status).toBe("cancelled");
  });

  it("вечір міняє лише digest_evening; тиха ніч не чіпає жодного pending огляду", async () => {
    mockTelegram();
    const u = await user();
    await cron();
    const m = (await pending("digest_morning", u))[0]!;
    const w = (await pending("digest_weekly", u))[0]!;
    const e0 = (await pending("digest_evening", u))[0]!;
    await press("st:e:1200"); // 20:00
    const e = await pending("digest_evening", u);
    expect(e).toHaveLength(1);
    expect(iso(e[0]!.fire_at)).toBe("2026-11-20T18:00:00Z"); // 20:00 Київ сьогодні (ще попереду о 12:00)
    expect((await rows(`id = ${e0.id}`))[0]!.status).toBe("cancelled");
    expect((await pending("digest_morning", u))[0]!.id).toBe(m.id);
    expect((await pending("digest_weekly", u))[0]!.id).toBe(w.id);
    const all = JSON.stringify(await rows());
    await press("st:qt:1320:540"); // тиша 22:00–09:00
    expect(JSON.stringify(await rows())).toBe(all);
    expect(await U(u)).toMatchObject({ quiet_from: 1320, quiet_to: 540 });
  });
});

// ── 3.7.b / 3.7.i / 3.7.h: години проти тихих годин (В1 рев'ю 3.1) ──────────────────────────────────────

describe("В1 рев'ю 3.1: години оглядів і тиха ніч — обидва напрямки", () => {
  it("3.7.b / 3.7.i (↓ кнопки): тиша 23:00–08:00 — у ранку немає 06:00–07:30, є 08:00; у вечорі немає 23:00 і 23:30, є 22:00 і 21:30", async () => {
    const tg = mockTelegram();
    await user();
    await press("st:m");
    const morning = buttons(lastEdit(tg));
    for (const h of ["06:00", "06:30", "07:00", "07:30"]) expect(morning).not.toContain(h);
    for (const h of ["08:00", "11:30"]) expect(morning).toContain(h);
    await press("st:e");
    const evening = buttons(lastEdit(tg));
    for (const h of ["23:00", "23:30"]) expect(evening).not.toContain(h);
    for (const h of ["22:00", "21:30", "18:00"]) expect(evening).toContain(h);
    // тиша 22:00–08:00: 22:00 теж зникає; без тихих годин — є все
    await press("st:qt:1320:480");
    await press("st:e");
    expect(buttons(lastEdit(tg))).not.toContain("22:00");
    await press("st:qn");
    await press("st:e");
    expect(buttons(lastEdit(tg))).toEqual(expect.arrayContaining(["23:00", "23:30", "22:00"]));
    await press("st:m");
    expect(buttons(lastEdit(tg))).toContain("06:00");
  });

  it("застаріла кнопка години, що потрапила в тишу після показу, нічого не міняє", async () => {
    mockTelegram();
    const u = await user();
    await press("st:e:1380"); // 23:00 — у тиші 23:00–08:00
    expect((await U(u))!.evening_at).toBe(1260);
    await press("st:m:360");
    expect((await U(u))!.morning_at).toBe(540);
  });

  it("3.7.i (↑ тиша): вечір 23:00 (без тихих годин), тиша 23:00–08:00 → «⚠ … не прийде» і кнопка «Пересунути вечір»; вибір 21:00 — попередження зникає, один pending на найближчі 21:00", async () => {
    const tg = mockTelegram();
    const u = await user();
    await setU(u, { quiet_from: 480, quiet_to: 480, evening_at: 1380 }); // без тихих годин, вечір 23:00
    await cron();
    expect(iso((await pending("digest_evening", u))[0]!.fire_at)).toBe("2026-11-20T21:00:00Z"); // 23:00 Київ
    await press("st:q");
    await press("st:qf:1380");
    await press("st:qt:1380:480");
    const home = lastEdit(tg);
    expect(textOf(home)).toContain("⚠ вечірній огляд зараз у тихих годинах — не прийде");
    expect(textOf(home)).not.toContain("ранковий огляд зараз");
    expect(cbs(home)).toContain("st:e");
    expect(buttons(home)).toContain("⏰ Пересунути вечір");
    expect((await pending("digest_evening", u))[0]!.fire_at).toBe(at("2026-11-20T21:00:00Z")); // сама тиша огляд не переплановує

    await press("st:e");
    await press("st:e:1260"); // 21:00
    expect(textOf(lastEdit(tg))).not.toContain("⚠");
    const e = await pending("digest_evening", u);
    expect(e).toHaveLength(1);
    expect(iso(e[0]!.fire_at)).toBe("2026-11-20T19:00:00Z"); // 21:00 Київ сьогодні
  });

  it("3.7.i: тиша 23:00–08:00 і всі огляди поза нею — попереджень немає", async () => {
    const tg = mockTelegram();
    await user();
    await say("/settings");
    await press("st:h");
    expect(textOf(lastEdit(tg))).not.toContain("⚠");
    expect(buttons(lastEdit(tg))).not.toContain("⏰ Пересунути ранок");
  });

  it("3.7.h: ранок 06:00 + тиша 23:00–09:00 → «не прийде» (180 хв); тиша 23:00–08:00 → «прийде о 08:00» (120 хв)", async () => {
    const tg = mockTelegram();
    const u = await user();
    await setU(u, { quiet_from: 480, quiet_to: 480, morning_at: 360 });
    await press("st:qt:1380:540");
    expect(textOf(lastEdit(tg))).toContain("⚠ ранковий огляд зараз у тихих годинах — не прийде");
    expect(buttons(lastEdit(tg))).toContain("⏰ Пересунути ранок");
    await press("st:qt:1380:480");
    const t = textOf(lastEdit(tg));
    expect(t).toContain("⚠ ранковий огляд зараз у тихих годинах — прийде о 08:00");
    expect(t).not.toContain("не прийде");
  });

  it("digestPromise — чисте правило: межа 180 хв, через північ, поза тишею — undefined", () => {
    const q = (from: number, to: number) => ({ quiet_from: from, quiet_to: to });
    expect(digestPromise(360, q(1380, 540))).toEqual({ comes: null }); // 180 хв — не менше TTL
    expect(digestPromise(361, q(1380, 540))).toEqual({ comes: 540 }); // 179 хв
    expect(digestPromise(1380, q(1380, 480))).toEqual({ comes: null }); // 9 год
    expect(digestPromise(1439, q(1380, 480))).toEqual({ comes: null });
    expect(digestPromise(480, q(1380, 480))).toBeUndefined(); // рівно кінець тиші — вже не тиша
    expect(digestPromise(540, q(1380, 480))).toBeUndefined();
    expect(digestPromise(600, q(600, 600))).toBeUndefined(); // тихих годин немає
  });
});

// ── 3.7.c, 3.8: пояс ────────────────────────────────────────────────────────────────────────────────────

describe("3.7.c /tz", () => {
  it("невідомий пояс → відмова без змін users і reminders; Europe/Lisbon → збережено; регістр виправляється", async () => {
    const tg = mockTelegram();
    const u = await user();
    await cron();
    const before = JSON.stringify(await rows());
    const uBefore = JSON.stringify(await U(u));
    for (const bad of ["Mars/Olympus", "+02:00", "Europe/Kyiv; DROP TABLE users", "x".repeat(65), "123"]) {
      await say(`/tz ${bad}`);
      expect(textOf(tg.sent().at(-1)!)).toBe(ST_TZ_UNKNOWN);
    }
    expect(JSON.stringify(await U(u))).toBe(uBefore);
    expect(JSON.stringify(await rows())).toBe(before);

    await say("/tz");
    expect(textOf(tg.sent().at(-1)!)).toBe(ST_TZ_HINT.replace("{tz}", "Київ (Europe/Kyiv)"));
    expect((await U(u))!.tz).toBe("Europe/Kyiv");

    await say("/tz europe/lisbon");
    expect((await U(u))!.tz).toBe("Europe/Lisbon");
    await say("/tz Europe/Lisbon");
    expect(textOf(tg.sent().at(-1)!)).toBe(ST_TZ_SAME);
  });

  it("«пояс Лісабон» без / — звичайний запис, а не команда (decisions.md)", async () => {
    const tg = mockTelegram();
    const u = await user();
    await say("пояс Лісабон");
    expect((await U(u))!.tz).toBe("Europe/Kyiv");
    expect(tg.calls.some((c) => c.method === "sendMessage" && SOON_POOL.includes(textOf(c)))).toBe(false);
  });

  it("кнопка Варшава змінює пояс і повертає головний екран; «інший…» дає підказку /tz", async () => {
    const tg = mockTelegram();
    const u = await user();
    await press("st:z:1");
    expect((await U(u))!.tz).toBe("Europe/Warsaw");
    expect(textOf(lastEdit(tg))).toContain("Пояс: Варшава (Europe/Warsaw)");
    await press("st:zo");
    expect(textOf(lastEdit(tg))).toContain("/tz Europe/Lisbon");
  });
});

describe("S3.8 зміна поясу", () => {
  it("3.8.a: all_day зберігає локальну дату (північ Лісабона), зустріч з часом — ту саму мить", async () => {
    mockTelegram();
    const u = await user();
    const day = await mk(u, { dueAt: at("2026-11-24T22:00:00Z"), allDay: true }); // 25.11 00:00 Київ
    const meet = await mk(u, { kind: "event", title: "зустріч", dueAt: at("2026-11-25T12:00:00Z") }); // 14:00 Київ
    await say("/tz Europe/Lisbon");
    expect(iso((await itemRow(day))!.due_at!)).toBe("2026-11-25T00:00:00Z");
    expect((await itemRow(day))!.all_day).toBe(1);
    expect(iso((await itemRow(meet))!.due_at!)).toBe("2026-11-25T12:00:00Z"); // та сама мить (у Лісабоні — 12:00)
  });

  it("3.8.b: eve_before 24.11 20:00 Київ → cancelled, новий 24.11 20:00 Лісабон; leave_now того ж запису — той самий рядок", async () => {
    mockTelegram();
    const u = await user();
    const meet = await mk(u, { kind: "event", title: "зустріч", dueAt: at("2026-11-25T12:00:00Z") });
    await cron();
    const eve = (await rows(`item_id = ${meet} AND kind = 'eve_before'`))[0]!;
    const leave = (await rows(`item_id = ${meet} AND kind = 'leave_now'`))[0]!;
    expect(iso(eve.fire_at)).toBe("2026-11-24T18:00:00Z"); // 20:00 Київ
    await say("/tz Europe/Lisbon");
    await cron();
    expect((await rows(`id = ${eve.id}`))[0]!.status).toBe("cancelled");
    const eves = await rows(`item_id = ${meet} AND kind = 'eve_before' AND status = 'pending'`);
    expect(eves).toHaveLength(1);
    expect(iso(eves[0]!.fire_at)).toBe("2026-11-24T20:00:00Z"); // 20:00 Лісабон
    expect(await rows(`item_id = ${meet} AND kind = 'leave_now'`)).toEqual([leave]); // не чіпали
    expect(await rows(`item_id = ${meet} AND kind = 'eve_before'`)).toHaveLength(2); // старий + новий, без дублів
  });

  it("3.8.c: ранок 23.11 о 09:00 Київ уже sent; о 10:00 Київ /tz Lisbon → 3 pending: ранок 24.11 09:00 Лісабон, вечір 23.11 21:00 Лісабон, тиждень неділя 29.11 09:00 Лісабон", async () => {
    mockTelegram();
    const u = await user();
    vi.setSystemTime(at("2026-11-23T08:00:00Z")); // 10:00 Київ, пн
    await rem(u, null, { kind: "digest_morning", fire_at: at("2026-11-23T07:00:00Z"), status: "sent", sent_at: at("2026-11-23T07:00:10Z") });
    await planDigests(db(), Date.now());
    expect(iso((await pending("digest_morning", u))[0]!.fire_at)).toBe("2026-11-24T07:00:00Z"); // 09:00 Київ завтра
    await say("/tz Europe/Lisbon");
    const m = await pending("digest_morning", u);
    const e = await pending("digest_evening", u);
    const w = await pending("digest_weekly", u);
    expect([m.length, e.length, w.length]).toEqual([1, 1, 1]);
    expect(iso(m[0]!.fire_at)).toBe("2026-11-24T09:00:00Z");
    expect(iso(e[0]!.fire_at)).toBe("2026-11-23T21:00:00Z");
    expect(iso(w[0]!.fire_at)).toBe("2026-11-29T09:00:00Z");
    expect(await rows("status = 'pending' AND kind LIKE 'digest_%'")).toHaveLength(3);
  });

  it("3.8.e: збій посеред batch (D1 відхиляє другий оператор) — жодна зі змін 1–4 не застосована", async () => {
    mockTelegram();
    const u = await user();
    const day = await mk(u, { dueAt: at("2026-11-24T22:00:00Z"), allDay: true });
    await cron();
    const before = { users: JSON.stringify(await U(u)), items: JSON.stringify(await itemRow(day)), rem: JSON.stringify(await rows()) };
    // Proxy над справжнім D1: оператор вставки нового огляду отримує неіснуючий `kind` → CHECK падає ВЖЕ під час batch,
    // після `UPDATE users` і зсуву `due_at` (вони стоять у batch раніше).
    const real = env.DB!;
    const broken = new Proxy(real, {
      get(t, k) {
        if (k === "prepare")
          return (sql: string) => {
            const st = t.prepare(sql);
            if (!sql.includes("VALUES (?1, NULL, ?2, ?3, 1, 1, ?4)")) return st;
            return new Proxy(st, {
              get(s, key) {
                if (key === "bind") return (...a: unknown[]) => s.bind(a[0], "bogus_kind", ...a.slice(2));
                const v = Reflect.get(s, key) as unknown;
                return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(s) : v;
              },
            });
          };
        const v = Reflect.get(t, k) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    await expect(applySetting(u, openDb(baseEnv({ DB: broken })), { field: "tz", value: "Europe/Lisbon" }, Date.now())).rejects.toThrow();
    expect(JSON.stringify(await U(u))).toBe(before.users);
    expect(JSON.stringify(await itemRow(day))).toBe(before.items);
    expect(JSON.stringify(await rows())).toBe(before.rem);
  });

  it("зміна поясу одного користувача не чіпає записів і рядків іншого", async () => {
    mockTelegram();
    const a = await user(111);
    const b = await user(222);
    const bi = await mk(b, { dueAt: at("2026-11-24T22:00:00Z"), allDay: true });
    await cron();
    const bRows = JSON.stringify(await rows(`user_id = ${b}`));
    const bItem = JSON.stringify(await itemRow(bi));
    await say("/tz Europe/Lisbon", 111);
    expect((await U(a))!.tz).toBe("Europe/Lisbon");
    expect(JSON.stringify(await rows(`user_id = ${b}`))).toBe(bRows);
    expect(JSON.stringify(await itemRow(bi))).toBe(bItem);
    expect((await U(b))!.tz).toBe("Europe/Kyiv");
  });
});

// ── 3.7.f, 3.8.f: перенос коренів планувальника ─────────────────────────────────────────────────────────

describe("3.7.f перенос коренів планувальника при зміні ранку", () => {
  const MON_0830 = "2026-11-23T06:30:00Z"; // 08:30 Київ

  async function setup() {
    const u = await user();
    vi.setSystemTime(at(MON_0830));
    const today = await mk(u, { title: "сьогодні", dueAt: at("2026-11-22T22:00:00Z"), allDay: true }); // 23.11 00:00 Київ
    const tomorrow = await mk(u, { title: "завтра", dueAt: at("2026-11-23T22:00:00Z"), allDay: true });
    await cron();
    return { u, today, tomorrow };
  }
  const dueRoots = (item: number) => rows(`item_id = ${item} AND kind = 'due'`);

  it("ранок 09:00 → 10:00 о 08:30: обидва старі cancelled, нові due сьогодні 10:00 і завтра 10:00 (після тику — без дублів)", async () => {
    mockTelegram();
    const { today, tomorrow } = await setup();
    expect((await dueRoots(today))[0]!.fire_at).toBe(at("2026-11-23T07:00:00Z")); // 09:00 Київ
    await press("st:m:600");
    await cron();
    for (const [item, when] of [[today, "2026-11-23T08:00:00Z"], [tomorrow, "2026-11-24T08:00:00Z"]] as const) {
      const r = await dueRoots(item);
      expect(r.map((x) => x.status)).toEqual(["cancelled", "pending"]);
      expect(iso(r[1]!.fire_at)).toBe(when);
    }
  });

  it("натомість 08:00: завтрашній → завтра 08:00, а сьогоднішній лишається на 09:00 і приходить пушем (нова мить уже позаду)", async () => {
    const tg = mockTelegram();
    const { today, tomorrow } = await setup();
    await press("st:m:480");
    const t = await dueRoots(today);
    expect(t).toHaveLength(1);
    expect([t[0]!.status, iso(t[0]!.fire_at)]).toEqual(["pending", "2026-11-23T07:00:00Z"]);
    const tm = await dueRoots(tomorrow);
    expect(tm.map((x) => x.status)).toEqual(["cancelled", "pending"]);
    expect(iso(tm[1]!.fire_at)).toBe("2026-11-24T06:00:00Z");
    expect((await itemRow(tomorrow))!.planned_at).toBeNull(); // перенесений запис планувальник перерахує (спека)
    expect((await itemRow(today))!.planned_at).not.toBeNull(); // не перенесений — позначка лишається
    tg.calls.length = 0;
    await tickAt("2026-11-23T07:00:30Z"); // 09:00 Київ — пуш сьогоднішньої справи
    expect((await dueRoots(today))[0]!.status).toBe("sent");
    expect(tg.sent().length).toBeGreaterThanOrEqual(1);
  });
});

describe("3.8.f ⏰ переживає зміну поясу", () => {
  it("⏰ «+1 год» на 11:00 Київ: /tz Warsaw о 10:30 — той самий рядок, pending, fire_at і planned_at запису не змінені; о 11:00 Київ приходить", async () => {
    const tg = mockTelegram();
    const u = await user();
    vi.setSystemTime(at("2026-11-23T08:30:00Z")); // 10:30 Київ
    const item = await mk(u, { dueAt: at("2026-11-22T22:00:00Z"), allDay: true }); // сьогодні (23.11) all_day
    await DB.prepare("UPDATE items SET planned_at = ? WHERE id = ?").bind(NOW, item).run();
    await rem(u, item, { kind: "due", fire_at: at("2026-11-23T07:00:00Z"), status: "sent" }); // ранковий пуш уже пішов
    const snooze = await rem(u, item, { kind: "due", fire_at: at("2026-11-23T09:00:00Z"), status: "pending" }); // ⏰ → 11:00 Київ
    await say("/tz Europe/Warsaw");
    const r = (await rows(`id = ${snooze}`))[0]!;
    expect([r.status, iso(r.fire_at)]).toEqual(["pending", "2026-11-23T09:00:00Z"]);
    expect((await itemRow(item))!.planned_at).toBe(NOW);
    expect(await rows(`item_id = ${item} AND status = 'cancelled'`)).toHaveLength(0);
    tg.calls.length = 0;
    await tickAt("2026-11-23T09:00:30Z"); // 11:00 Київ
    expect((await rows(`id = ${snooze}`))[0]!.status).toBe("sent");
    expect(tg.sent()).toHaveLength(1);
  });

  it("3.8.f: ⏰ лишається на своїй миті, навіть коли мить планувальника нового поясу ще попереду (Київ → Лондон о 10:30)", async () => {
    mockTelegram();
    const u = await user();
    vi.setSystemTime(at("2026-11-23T08:30:00Z")); // 10:30 Київ = 08:30 Лондон
    const item = await mk(u, { dueAt: at("2026-11-22T22:00:00Z"), allDay: true });
    await DB.prepare("UPDATE items SET planned_at = ? WHERE id = ?").bind(NOW, item).run();
    await rem(u, item, { kind: "due", fire_at: at("2026-11-23T07:00:00Z"), status: "sent" });
    const snooze = await rem(u, item, { kind: "due", fire_at: at("2026-11-23T09:30:00Z"), status: "pending" }); // ⏰ → 11:30 Київ
    await say("/tz Europe/London"); // ранок 09:00 Лондон = 09:00Z ≥ now: plannedFor дав би рядок, але це не корінь планувальника
    const r = await rows(`item_id = ${item} AND status IN ('pending','cancelled')`);
    expect(r.map((x) => [x.id, x.status, iso(x.fire_at)])).toEqual([[snooze, "pending", "2026-11-23T09:30:00Z"]]);
  });

  it("корінь планувальника, чия нова мить уже позаду, лишається й приходить: 09:00 Лісабон → /tz Kyiv о 08:30 Лісабон", async () => {
    const tg = mockTelegram();
    const u = await user();
    await DB.prepare("UPDATE users SET tz = 'Europe/Lisbon' WHERE id = ?").bind(u).run();
    vi.setSystemTime(at("2026-11-23T08:30:00Z")); // 08:30 Лісабон
    const item = await mk(u, { dueAt: at("2026-11-23T00:00:00Z"), allDay: true });
    await DB.prepare("UPDATE items SET planned_at = ? WHERE id = ?").bind(NOW, item).run();
    const root = await rem(u, item, { kind: "due", fire_at: at("2026-11-23T09:00:00Z"), status: "pending" });
    await say("/tz Europe/Kyiv");
    const r = (await rows(`id = ${root}`))[0]!;
    expect([r.status, iso(r.fire_at)]).toEqual(["pending", "2026-11-23T09:00:00Z"]);
    tg.calls.length = 0;
    await tickAt("2026-11-23T09:00:30Z");
    expect((await rows(`id = ${root}`))[0]!.status).toBe("sent");
  });

  it("корінь під активною орендою не переноситься (його вже відправляють)", async () => {
    mockTelegram();
    const u = await user();
    const item = await mk(u, { dueAt: at("2026-11-24T22:00:00Z"), allDay: true });
    await cron();
    const root = (await rows(`item_id = ${item} AND kind = 'due'`))[0]!;
    await DB.prepare("UPDATE reminders SET lease_until = ? WHERE id = ?").bind(Date.now() + 60_000, root.id).run();
    await say("/tz Europe/Lisbon");
    const all = await rows(`item_id = ${item} AND kind = 'due'`);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("pending");
  });
});

// ── S3.9: меню команд ───────────────────────────────────────────────────────────────────────────────────

describe("3.9.a меню команд", () => {
  // Склад меню звіряє з `scripts/set-commands.mjs` node-тест (test/node/set-commands.test.ts); тут — що кожна команда ЖИВА.
  const MENU = ["today", "settings", "pause", "resume", "export"];
  it("кожна команда зі списку має обробник: одна відповідь, не «навчуся скоро»", async () => {
    const tg = mockTelegram();
    await user();
    for (const c of MENU) {
      tg.calls.length = 0;
      await say(`/${c}`);
      const replies = tg.calls.filter((x) => x.method === "sendMessage" || x.method === "sendDocument");
      expect(replies, c).toHaveLength(1);
      if (replies[0]!.method === "sendMessage") expect(SOON_POOL).not.toContain(textOf(replies[0]!));
    }
  });
});
