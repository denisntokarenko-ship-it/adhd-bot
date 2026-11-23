// Відправка нагадувань з cron (docs/spec/phase-2.md, S2.3, S2.5, S2.6). Порядок: STALE → тиша → оренда → по
// користувачах: перевірка записів → добір (окремі/зведення) → відправка → закриття ПІСЛЯ відправки.
// Краще двічі, ніж жодного: рядок стає `sent` лише після `sendMessage`; збій процесу між ними лишає `pending` з орендою.
import { Api } from "grammy";
import type { Clock } from "../clock";
import { openDb, type Db } from "../db/index";
import { listByIds, type Item } from "../db/items";
import {
  cancelOne,
  closeSent,
  closeSummary,
  lastSummaryHeadIdx,
  lastVariantIdx,
  parentSentAs,
  releaseLease,
  sentCounts,
  type NextAttempt,
  type Reminder,
} from "../db/reminders";
import { cancelStaleReminders, claimDueReminders, listQuietUserIds, releaseLeases } from "../db/system";
import { getDelivery } from "../db/users";
import type { AppEnv } from "../env";
import { formatDue } from "../format";
import { SUMMARY_HEAD_POOL, pickVariant } from "../texts";
import { CLAIM_LIMIT, RUN_BUDGET_MS, STALE_MS, leaveMoot, nextRepeat, selectBatch, timedEvent, type BatchRow } from "./plan";
import { poolFor, singleMessage, summaryMessage, type SummaryLine } from "./render";
import { classify } from "./send-failure";
import { dispatchDigests } from "../digests/dispatch";
import { isDigestKind } from "../digests/schedule";
import { dispatchRoutineRows, isRoutineRow } from "../routines/dispatch";

export interface DispatchDeps {
  rand?: () => number;
  api?: Api; // лише для тестів
}

export async function dispatchReminders(env: AppEnv, clock: Clock, deps: DispatchDeps = {}): Promise<void> {
  const db = openDb(env);
  const start = clock.now();
  await cancelStaleReminders(db, start, STALE_MS);
  const quiet = await listQuietUserIds(db, start);
  const paused = await listQuietUserIds(db, start, true); // рядки рутин тиша не тримає, пауза — так (S4.5.h)
  const claimed = await claimDueReminders(db, start, CLAIM_LIMIT, quiet, paused);
  if (claimed.length === 0) return; // порожня черга: один запит claim, без записів

  const unsent = new Set(claimed.map((r) => r.id));
  try {
    const token = env.BOT_TOKEN;
    if (!token && deps.api === undefined) {
      console.error("dispatch: BOT_TOKEN is missing");
      return;
    }
    const api = deps.api ?? new Api(token!);
    const rand = deps.rand ?? Math.random;
    const byUser = new Map<number, Reminder[]>();
    for (const r of claimed) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
    for (const [userId, rows] of byUser) {
      if (clock.now() - start >= RUN_BUDGET_MS) break; // нових відправок немає; решта чекає тику (S2.3.e)
      try {
        await dispatchUser({ api, db, clock, rand, start, unsent }, userId, rows);
      } catch (err) {
        console.error("dispatch: user failed", userId, err instanceof Error ? err.name : "unknown"); // id, без тексту
      }
    }
  } finally {
    // Нерозіслані (бюджет, вікно анти-шуму, збій Telegram): оренда знімається, спроба не витрачена (S2.3 крок 5).
    try {
      await releaseLeases(db, [...unsent]);
    } catch (err) {
      console.error("dispatch: lease release failed", err instanceof Error ? err.name : "unknown");
    }
  }
}

interface Ctx {
  api: Api;
  db: Db;
  clock: Clock;
  rand: () => number;
  start: number;
  unsent: Set<number>;
}

const overBudget = (c: Ctx) => c.clock.now() - c.start >= RUN_BUDGET_MS;

// Наступна спроба ланцюга від ФАКТИЧНОЇ відправки (S2.2.d); для подій з часом спроба після початку не створюється
// (S2.2.e). Подія `all_day` — як задача: її `due_at` (північ) не обрізає ланцюг (рев'ю R-2, Б1).
const nextFor = (r: Reminder, item: Item, sentAt: number): NextAttempt | null =>
  nextRepeat({ attempt: r.attempt, max_attempts: r.max_attempts, sent_at: sentAt }, timedEvent(item) ? item.due_at : null);

async function dispatchUser(c: Ctx, userId: number, claimedAll: Reminder[]): Promise<void> {
  const { db } = c;
  // Огляди (S3.1) — окрема гілка ДО перевірки запису й добору: не зливаються в зведення, не чекають ліміту 6/год.
  // Ранок (S3.4) може забрати `due` відрендерених записів: їх із подальшої відправки прибираємо.
  const digests = claimedAll.filter((r) => isDigestKind(r.kind));
  // Рутини (S4.5) — теж окрема гілка: без перевірки запису, зведення й очікування ліміту (4.5.i).
  const routines = claimedAll.filter(isRoutineRow);
  let claimed = claimedAll.filter((r) => !isDigestKind(r.kind) && !isRoutineRow(r));
  if (routines.length > 0) await dispatchRoutineRows(c, userId, routines);
  if (digests.length > 0) {
    const gone = await dispatchDigests(c, userId, digests, claimed);
    claimed = claimed.filter((r) => !gone.has(r.id));
  }
  if (claimed.length === 0) return;
  const dl = await getDelivery(userId, db);
  if (dl === null) return;
  // 1) Запис не `open` (done/released/видалений) → рядок `cancelled` без повідомлення (S2.3.d).
  const ids = claimed.flatMap((r) => (r.item_id === null ? [] : [r.item_id]));
  const items = new Map((await listByIds(userId, db, ids)).map((i) => [i.id, i]));
  const live: { r: Reminder; item: Item }[] = [];
  for (const r of claimed) {
    const item = r.item_id === null ? undefined : items.get(r.item_id);
    if (item === undefined || item.status !== "open" || leaveMoot(r, item, c.clock.now())) {
      await cancelOne(userId, db, r.id); // і «час виходити», затриманий за початок події (S2.2.e, борг 2.2)
      c.unsent.delete(r.id);
    } else live.push({ r, item });
  }
  if (live.length === 0) return;

  // 2) Добір: окремі / зведення / чекають (S2.6).
  const now = c.clock.now();
  const counts = await sentCounts(userId, db, now);
  const parents = await parentSentAs(userId, db, live.flatMap(({ r }) => (r.parent_id === null ? [] : [r.parent_id])));
  const rowsById = new Map(live.map((x) => [x.r.id, x]));
  const batchRows: BatchRow[] = live.map(({ r, item }) => ({
    id: r.id,
    fireAt: r.fire_at,
    important: item.priority === "important",
    parentSentAs: r.parent_id === null ? null : (parents.get(r.parent_id) ?? null),
    noWait: timedEvent(item) && (r.kind === "leave_now" || r.kind === "repeat"), // S2.6 п.1, виняток R-2 Б2
  }));
  const plan = selectBatch(batchRows, { now, singlesLastHour: counts.singles, summariesLastHour: counts.summaries });

  // 3) Окремі.
  for (const b of plan.singles) {
    if (overBudget(c)) return;
    const { r } = rowsById.get(b.id)!;
    // Перевірка безпосередньо перед відправкою: ✅ міг прийти після claim (S2.5.b).
    const [fresh] = await listByIds(userId, db, [r.item_id!]);
    if (fresh === undefined || fresh.status !== "open" || leaveMoot(r, fresh, c.clock.now())) {
      await cancelOne(userId, db, r.id);
      c.unsent.delete(r.id);
      continue;
    }
    const choice = poolFor(r.kind, r.attempt);
    const idx = pickVariant(choice.pool.length, await lastVariantIdx(userId, db, choice.kinds, choice.attempt), c.rand);
    // «Напередодні» і «час виходити» без часу події безглузді (S2.7.f); так само повтор ланцюга події з часом.
    const withWhen = fresh.due_at !== null && (r.kind === "eve_before" || r.kind === "leave_now" || (r.kind === "repeat" && timedEvent(fresh)));
    const when = withWhen ? formatDue(fresh.due_at!, fresh.all_day === 1, dl.tz, c.clock.now()) : undefined;
    const msg = singleMessage(choice.pool[idx] ?? choice.pool[0] ?? "", fresh.title, r.id, r.kind, when);
    let sent: { message_id: number };
    try {
      sent = await c.api.sendMessage(dl.tg_id, msg.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: msg.keyboard } });
    } catch (err) {
      const f = classify(err, c.clock.now());
      if (f.kind === "dead") {
        console.error("dispatch: chat unavailable, reminder cancelled", r.id, f.code); // id й код, без тексту
        await cancelOne(userId, db, r.id);
        c.unsent.delete(r.id);
        continue;
      }
      await releaseLease(userId, db, r.id, f.kind === "rate" ? f.until : null);
      c.unsent.delete(r.id);
      return; // 429/5xx: решта користувача чекає тику (спроби не витрачені, їхню оренду зніме finally)
    }
    const sentAt = c.clock.now();
    c.unsent.delete(r.id); // з цього місця рядок уже відправлено: оренда лишається, поки не закриємо
    try {
      const closed = await closeSent(userId, db, r, { sentAt, sentAs: "single", tgMessageId: sent.message_id, variantIdx: idx }, nextFor(r, fresh, sentAt), sentAt);
      if (!closed) await c.api.deleteMessage(dl.tg_id, sent.message_id).catch(() => undefined); // ✅ випередив (S2.5.c)
    } catch (err) {
      console.error("dispatch: close failed", r.id, err instanceof Error ? err.name : "unknown"); // оренда збіжить — допустимий дубль
    }
  }

  // 4) Зведення (S2.6): записи ще раз перевіряємо перед відправкою, порожнього зведення не буває.
  if (plan.summary.length > 0 && !overBudget(c)) {
    const want = plan.summary.map((b) => rowsById.get(b.id)!);
    const fresh = new Map((await listByIds(userId, db, want.map((x) => x.r.item_id!))).map((i) => [i.id, i]));
    const sendable: { r: Reminder; item: Item }[] = [];
    for (const x of want) {
      const item = fresh.get(x.r.item_id!);
      if (item === undefined || item.status !== "open" || leaveMoot(x.r, item, c.clock.now())) {
        await cancelOne(userId, db, x.r.id);
        c.unsent.delete(x.r.id);
      } else sendable.push({ r: x.r, item });
    }
    if (sendable.length > 0) await sendSummary(c, userId, dl, sendable);
  }
}

async function sendSummary(c: Ctx, userId: number, dl: { tg_id: number; tz: string }, rows: { r: Reminder; item: Item }[]): Promise<void> {
  const { db } = c;
  const headIdx = pickVariant(SUMMARY_HEAD_POOL.length, await lastSummaryHeadIdx(userId, db), c.rand);
  const head = SUMMARY_HEAD_POOL[headIdx] ?? "";
  const now = c.clock.now();
  const lines: SummaryLine[] = rows.map(({ r, item }) => ({
    id: r.id,
    kind: r.kind,
    title: item.title,
    dueAt: item.due_at,
    allDay: item.all_day === 1,
    open: true,
  }));
  const first = summaryMessage(head, lines, 0, dl.tz, now, null);
  let sent: { message_id: number };
  try {
    sent = await c.api.sendMessage(dl.tg_id, first.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: first.keyboard } });
  } catch (err) {
    const f = classify(err, c.clock.now());
    for (const { r } of rows) {
      if (f.kind === "dead") await cancelOne(userId, db, r.id);
      else await releaseLease(userId, db, r.id, f.kind === "rate" ? f.until : null);
      c.unsent.delete(r.id);
    }
    if (f.kind === "dead") console.error("dispatch: chat unavailable, summary cancelled", rows.length, f.code);
    return;
  }
  const sentAt = c.clock.now();
  for (const { r } of rows) c.unsent.delete(r.id);
  try {
    const closed = await closeSummary(
      userId,
      db,
      rows.map(({ r, item }) => ({ r, next: nextFor(r, item, sentAt) })),
      sent.message_id,
      sentAt,
      sentAt,
      headIdx,
    );
    if (!closed.some(Boolean)) {
      await c.api.deleteMessage(dl.tg_id, sent.message_id).catch(() => undefined);
      return;
    }
    // Кнопки «Усе на …» потребують id повідомлення — додаємо після відправки (best effort).
    const full = summaryMessage(head, lines, 0, dl.tz, now, sent.message_id);
    await c.api.editMessageReplyMarkup(dl.tg_id, sent.message_id, { reply_markup: { inline_keyboard: full.keyboard } }).catch(() => undefined);
  } catch (err) {
    console.error("dispatch: summary close failed", err instanceof Error ? err.name : "unknown");
  }
}
