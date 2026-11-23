// Майстер `/routines`, список і кнопки пушу рутин (docs/spec/phase-4.md, S4.2, S4.3, S4.5, S4.7). Лише кнопки й один
// текст-назва; жодного виклику Claude чи Whisper у цьому шляху (принцип 1, 4.2.i). Назва в логи не йде (НФ-2).
// Лише приватний чат і лише власник: кожен запит несе `user.id` (НФ-3); чужий id → тост без змін.
import type { Context } from "grammy";
import type { Clock } from "../clock";
import { isKnownUpdate } from "../db/captures";
import type { Db } from "../db/index";
import { getReminder } from "../db/reminders";
import {
  answerSlot,
  countRoutines,
  deleteDraft,
  getDraft,
  getLiveDraft,
  getRoutine,
  listRoutines,
  patchDraft,
  pauseRoutine,
  resumeRoutine,
  saveDraft,
  snoozeSlot,
  startDraft,
  takeTitleInput,
  type Draft,
  type Routine,
} from "../db/routines";
import { getQuiet, type User } from "../db/users";
import { edit, pickAck } from "../reminders/buttons";
import type { Keyboard } from "../reminders/render";
import {
  ACK_LATER_POOL,
  ACK_SKIP_POOL,
  ACK_TAKEN_POOL,
  RL_NOT_FOUND,
  RL_PAUSED,
  RL_UPDATED,
  RT_ALREADY,
  RT_LATER_MARK,
  RT_LATER_TOAST,
  RT_SKIP_MARK,
  RT_TAKEN_MARK,
  RW_ALREADY_SAVED,
  RW_CANCELLED,
  RW_DAYS_ASK,
  RW_DEAD,
  RW_HOUR_ASK,
  RW_INTRO,
  RW_LIMIT,
  RW_LIST_HEAD,
  RW_MINUTE_ASK,
  RW_NO_DAYS,
  RW_QUIET_NOTE,
  RW_SAVED,
  RW_TIMES,
  RW_TITLE_ASK,
  RW_TITLE_BAD,
  RW_TITLE_TEXT_ONLY,
  UNKNOWN_REMINDER,
} from "../texts";
import { clipTitle } from "../reminders/render";
import { inQuietHours, localIso } from "../time";
import {
  cardKeyboard,
  confirmKeyboard,
  daysKeyboard,
  emojiOf,
  hoursKeyboard,
  kindRow,
  listKeyboard,
  minutesKeyboard,
  routineLine,
  timesKeyboard,
  titleKeyboard,
} from "./render";
import { ALL_DAYS, normalizeTimes, ROUTINE_SNOOZE_MIN, ROUTINES_MAX, validTitle, WEEKDAYS } from "./schedule";

export interface RoutineDeps {
  db: Db;
  user: User;
  clock: Clock;
  rand: () => number;
}

const RT_RE = /^rt:(\d{1,15}):(ok|skip|s15)$/;
const RW_RE = /^rw:(new:(?:med|habit)|h:(?:[01]\d|2[0-3])|m:(?:[01]\d|2[0-3])(?:00|15|30|45)|more|next|d:[0-6]|dall|dwk|save|x)$/;
const RL_RE = /^rl:(?:([otdnpr]):(\d{1,15})|l)$/;

export const isRoutineCallback = (data: string | undefined) => data !== undefined && (RT_RE.test(data) || RW_RE.test(data) || RL_RE.test(data));

// ── /routines і список (S4.7.a) ───────────────────────────────────────────────────────────────────────────

async function listView(d: RoutineDeps): Promise<{ text: string; keyboard: Keyboard }> {
  const rs = await listRoutines(d.user.id, d.db);
  if (rs.length === 0) return { text: RW_INTRO, keyboard: [kindRow()] };
  return { text: [RW_LIST_HEAD, ...rs.map(routineLine)].join("\n"), keyboard: listKeyboard(rs) };
}

export async function handleRoutinesCommand(ctx: Context, d: RoutineDeps): Promise<void> {
  const v = await listView(d);
  await ctx.reply(v.text, { parse_mode: "HTML", reply_markup: { inline_keyboard: v.keyboard } });
}

const cardText = (r: Routine) => (r.active ? routineLine(r) : `${routineLine(r)}\n${RL_PAUSED}`);

// ── Текст у майстрі (S4.3) ──────────────────────────────────────────────────────────────────────────────────

// Чернетка, що забирає повідомлення: жива (`expires_at > now`) і на кроці `title` (Р4.2: інші кроки — лише кнопки,
// текст там — звичайний запис, 4.3.c). `null` — повідомлення йде далі: «Не так» → захоплення.
export async function titleDraft(d: RoutineDeps): Promise<Draft | null> {
  const draft = await getLiveDraft(d.user.id, d.db, d.clock.now());
  return draft !== null && draft.step === "title" ? draft : null;
}

// Повідомлення кроку `title` (4.3.a, 4.3.e): текст — назва (або «трохи коротше»), голос чи пересилання — «лише текстом».
// Будь-яке з них іде в `routine_inputs` тим самим batch: повтор доставки не стане захопленням (4.3.b). Нічого не йде у
// Whisper чи Claude; повтор того самого `update_id` — тиша (НФ-7).
export async function handleTitleMessage(ctx: Context, d: RoutineDeps, draft: Draft, text: string | null): Promise<void> {
  const updateId = ctx.update.update_id;
  if (await isKnownUpdate(d.user.id, d.db, updateId)) return;
  const now = d.clock.now();
  const title = text === null ? null : text.trim();
  const ok = title !== null && validTitle(title);
  if (!(await takeTitleInput(d.user.id, d.db, updateId, ok ? title : null, now))) return;
  console.log("routine title input", text === null ? "non-text" : Array.from(text).length); // довжина, не текст (НФ-2)
  if (title === null) return void (await ctx.reply(RW_TITLE_TEXT_ONLY));
  if (!ok) return void (await ctx.reply(RW_TITLE_BAD));
  if (draft.routine_id !== null) {
    // ✏️ Назва (4.7.b): назву змінено, чернетки більше немає — показуємо картку
    const r = await getRoutine(d.user.id, d.db, draft.routine_id);
    if (r === null) return;
    await ctx.reply(`${RL_UPDATED}\n${cardText(r)}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: cardKeyboard(r.id, r.active) } });
    return;
  }
  await ctx.reply(`${emojiOf(draft.kind ?? "med")} <b>${clipTitle(title)}</b>\n${RW_HOUR_ASK}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: hoursKeyboard() } });
}

// ── Кнопки ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function handleRoutineCallback(ctx: Context, d: RoutineDeps): Promise<string | undefined> {
  const data = ctx.callbackQuery?.data ?? "";
  const rt = RT_RE.exec(data);
  if (rt !== null) return handlePush(ctx, d, Number(rt[1]), rt[2] as "ok" | "skip" | "s15");
  const rl = RL_RE.exec(data);
  if (rl !== null) return handleCard(ctx, d, rl[1] ?? "l", rl[2] === undefined ? null : Number(rl[2]));
  const rw = RW_RE.exec(data);
  if (rw !== null) return handleWizard(ctx, d, rw[1]!);
  return undefined;
}

// Пуш (S4.5): ✅ / пропущу / +15 хв. Чужий чи не рутинний рядок → «не знаю такого» без змін (4.5.f).
async function handlePush(ctx: Context, d: RoutineDeps, id: number, action: "ok" | "skip" | "s15"): Promise<string | undefined> {
  const userId = d.user.id;
  const r = await getReminder(userId, d.db, id);
  if (r === null || r.routine_id === null || r.slot_at === null) return UNKNOWN_REMINDER;
  const routine = await getRoutine(userId, d.db, r.routine_id);
  if (routine === null) return UNKNOWN_REMINDER;
  const now = d.clock.now();
  const title = `${emojiOf(routine.kind)} <b>${clipTitle(routine.title)}</b>`;
  if (action === "s15") {
    const at = now + ROUTINE_SNOOZE_MIN * 60_000;
    const out = await snoozeSlot(userId, d.db, r.id, routine.id, r.slot_at, at, now);
    if (out !== "snoozed") return RT_ALREADY;
    const q = await getQuiet(userId, d.db);
    const hm = localIso(at, q?.tz ?? d.user.tz).slice(11, 16);
    await pickAck(d, "later", ACK_LATER_POOL); // пам'ять варіанта «+15 хв» — наявний ack_later_idx
    await edit(ctx, `${title} — ${RT_LATER_MARK.replace("{t}", hm)}`);
    return RT_LATER_TOAST.replace("{t}", hm);
  }
  const status = action === "ok" ? "taken" : "skipped";
  if (!(await answerSlot(userId, d.db, r.id, routine.id, r.slot_at, status, now))) return RT_ALREADY;
  await edit(ctx, `${title} — ${status === "taken" ? RT_TAKEN_MARK : RT_SKIP_MARK}`);
  return status === "taken" ? pickAck(d, "taken", ACK_TAKEN_POOL) : pickAck(d, "skip", ACK_SKIP_POOL);
}

// Список і картка (S4.7). Чужий `routine_id` → «не знайшов», без змін (4.7.f).
async function handleCard(ctx: Context, d: RoutineDeps, act: string, id: number | null): Promise<string | undefined> {
  const userId = d.user.id;
  const now = d.clock.now();
  if (act === "l" || id === null) {
    const v = await listView(d);
    await edit(ctx, v.text, v.keyboard);
    return undefined;
  }
  const r = await getRoutine(userId, d.db, id);
  if (r === null) return RL_NOT_FOUND;
  const show = async (x: Routine) => edit(ctx, cardText(x), cardKeyboard(x.id, x.active));
  if (act === "o") return void (await show(r));
  if (act === "p" || act === "r") {
    if (act === "p") await pauseRoutine(userId, d.db, id, now);
    else await resumeRoutine(userId, d.db, id, now);
    const fresh = await getRoutine(userId, d.db, id);
    if (fresh !== null) await show(fresh);
    return undefined;
  }
  // ⏰ Час — порожній вибір; 📅 Дні — поточний; ✏️ Назва — крок `title` (4.7.b–c).
  const step = act === "t" ? "times" : act === "d" ? "days" : "title";
  await startDraft(userId, d.db, { routineId: id, step, kind: r.kind, title: r.title, times: act === "t" ? [] : r.times, daysMask: r.days_mask }, now);
  if (step === "times") await edit(ctx, `${routineLine(r)}\n${RW_HOUR_ASK}`, hoursKeyboard());
  else if (step === "days") await edit(ctx, `${routineLine(r)}\n${RW_DAYS_ASK}`, daysKeyboard(r.days_mask));
  else await edit(ctx, `${routineLine(r)}\n${RW_TITLE_ASK}`, titleKeyboard());
  return undefined;
}

// Підсумок перед збереженням (4.2.e): час у тихих годинах — дописка «нагадаю й у тихі години» (S4.5.h).
async function confirmView(d: RoutineDeps, draft: Draft): Promise<{ text: string; keyboard: Keyboard }> {
  const line = routineLine({ kind: draft.kind ?? "med", title: draft.title ?? "", times: draft.times, days_mask: draft.days_mask ?? ALL_DAYS, active: true });
  const q = await getQuiet(d.user.id, d.db);
  const quiet = q !== null && draft.times.some((t) => inQuietHours(q.quiet_from, q.quiet_to, Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))));
  return { text: quiet ? `${line}\n${RW_QUIET_NOTE}` : line, keyboard: confirmKeyboard() };
}

const timesText = (draft: Draft) => `${emojiOf(draft.kind ?? "med")} <b>${clipTitle(draft.title ?? "")}</b>\n${RW_TIMES.replace("{t}", draft.times.join(", "))}`;

// Кроки майстра (S4.2). Кожна кнопка — лише над живою чернеткою на своєму кроці й продовжує її TTL; мертва чи чужа
// чернетка → «майстер закрився», без змін (4.2.g).
async function handleWizard(ctx: Context, d: RoutineDeps, act: string): Promise<string | undefined> {
  const userId = d.user.id;
  const now = d.clock.now();
  if (act.startsWith("new:")) {
    if ((await countRoutines(userId, d.db)) >= ROUTINES_MAX) return RW_LIMIT; // 4.2.h: чернетка не створюється
    const kind = act === "new:med" ? "med" : "habit";
    await startDraft(userId, d.db, { routineId: null, step: "title", kind, title: null, times: [], daysMask: null }, now);
    await edit(ctx, RW_TITLE_ASK, titleKeyboard());
    return undefined;
  }
  if (act === "x") {
    if (!(await deleteDraft(userId, d.db, now))) return RW_DEAD;
    await edit(ctx, RW_CANCELLED);
    return undefined;
  }
  if (act === "save") {
    const out = await saveDraft(userId, d.db, now);
    if (out.kind === "none") return (await getDraft(userId, d.db)) === null ? RW_ALREADY_SAVED : RW_DEAD;
    if (out.kind === "limit") return RW_LIMIT;
    if (out.kind === "created") {
      const r = await getRoutine(userId, d.db, out.id);
      await edit(ctx, r === null ? RW_SAVED : `${routineLine(r)}\n${RW_SAVED}`);
      return undefined;
    }
    const r = await getRoutine(userId, d.db, out.id); // редагування (4.7.c): назад до картки
    if (r !== null) await edit(ctx, `${RL_UPDATED}\n${cardText(r)}`, cardKeyboard(r.id, r.active));
    return undefined;
  }
  const draft = await getLiveDraft(userId, d.db, now);
  if (draft === null) return RW_DEAD;

  if (act.startsWith("h:") || act === "more") {
    const ok = await patchDraft(userId, d.db, "times", {}, now);
    if (ok === null) return RW_DEAD;
    if (act === "more") await edit(ctx, `${timesText(ok)}\n${RW_HOUR_ASK}`, hoursKeyboard());
    else await edit(ctx, `${timesText(ok)}\n${RW_MINUTE_ASK}`, minutesKeyboard(act.slice(2)));
    return undefined;
  }
  if (act.startsWith("m:")) {
    if (draft.step !== "times") return RW_DEAD;
    const t = `${act.slice(2, 4)}:${act.slice(4, 6)}`;
    const times = normalizeTimes([...draft.times, t]) ?? draft.times; // повтор ігнорується; понад 6 — не додається
    const next = await patchDraft(userId, d.db, "times", { times }, now);
    if (next === null) return RW_DEAD;
    await edit(ctx, timesText(next), timesKeyboard(next.times.length));
    return undefined;
  }
  if (act === "next") {
    if (draft.step === "times") {
      if (draft.times.length === 0) return RW_DEAD;
      // редагування часу (4.7.c) — одразу підсумок; нова рутина — дні, усі ввімкнені (4.2.d)
      const next = await patchDraft(userId, d.db, "times", draft.routine_id !== null ? { step: "confirm" } : { step: "days", daysMask: draft.days_mask ?? ALL_DAYS }, now);
      if (next === null) return RW_DEAD;
      if (next.step === "confirm") {
        const v = await confirmView(d, next);
        await edit(ctx, v.text, v.keyboard);
      } else await edit(ctx, `${timesText(next)}\n${RW_DAYS_ASK}`, daysKeyboard(next.days_mask ?? ALL_DAYS));
      return undefined;
    }
    if (draft.step === "days") {
      if ((draft.days_mask ?? 0) === 0) return RW_NO_DAYS; // 4.2.d: крок не змінюється
      const next = await patchDraft(userId, d.db, "days", { step: "confirm" }, now);
      if (next === null) return RW_DEAD;
      const v = await confirmView(d, next);
      await edit(ctx, v.text, v.keyboard);
      return undefined;
    }
    return RW_DEAD;
  }
  // Дні: перемикач / Щодня / Будні (4.2.d)
  if (draft.step !== "days") return RW_DEAD;
  const mask = act === "dall" ? ALL_DAYS : act === "dwk" ? WEEKDAYS : (draft.days_mask ?? 0) ^ (1 << Number(act.slice(2)));
  const next = await patchDraft(userId, d.db, "days", { daysMask: mask }, now);
  if (next === null) return RW_DEAD;
  await edit(ctx, `${timesText(next)}\n${RW_DAYS_ASK}`, daysKeyboard(mask));
  return undefined;
}
