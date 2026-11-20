// Розбір захоплення через Claude Haiku (крок 1.2). ШІ лише ПРОПОНУЄ JSON; тут код суворо валідує, нормалізує
// й рахує дати (НФ-1, НФ-2). Усе, що не вийшло, — `{ fallback: true }`: запис не губиться (НФ-2, S1.5).
import { countToday, log as logAiCall, type AiError } from "../db/aiCalls";
import type { Db } from "../db/index";
import { dayBounds, localIso, localToUtc, weekdayName } from "../time";
import { AiCallError, type AiClient } from "./client";
import { buildPrompt, type CaptureSource } from "./prompt";
import { BODY_MAX, PARSE_SCHEMA, TITLE_MAX, validateShape, type Kind, type Priority, type RawItem } from "./schema";

export const AI_TIMEOUT_MS = 20_000;
export const MAX_TOKENS = 4096;
const MAX_AHEAD_MS = 731 * 86_400_000; // «не далі 2 років» (таблиця рішень S1.3)
const FALLBACK_TITLE_LEN = 80;

// Чому дату не збережено й про що треба спитати (одне повідомлення на захоплення, S1.3.g — це робить 1.3).
export type Clarify = "unclear" | "event_no_date" | "past" | "bad_format" | "too_far";

export interface ParsedItem {
  kind: Kind;
  title: string;
  body: string | null;
  dueAt: number | null; // UTC мс; null — без дати
  allDay: boolean;
  priority: Priority;
  clarify: Clarify | null;
}

export type ParseOutcome =
  | { fallback: false; items: ParsedItem[] }
  // limit — вичерпано денний ліміт (виклику не було); unavailable — таймаут/HTTP/refusal/json/schema.
  | { fallback: true; reason: "limit" | "unavailable" };

export interface ParseContext {
  client: AiClient;
  db: Db;
  userId: number;
  now: number;
  tz: string;
  model: string;
  dailyLimit: number;
  source?: CaptureSource;
  captureId?: number | null;
  timeoutMs?: number;
}

// ── нормалізація тексту ────────────────────────────────────────────────────────────────────────────────────

const cut = (s: string, max: number, mark: string) => {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max - mark.length).join("") + mark;
};

// Керуючі символи й нулі (крім \n, \t у body) — геть. У title рядки схлопуються в один.
const CONTROL_KEEP_NL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function cleanTitle(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(CONTROL_KEEP_NL, "").trim();
}

function cleanBody(s: string | null): string | null {
  if (s === null) return null;
  const t = s.replace(/\r\n?/g, "\n").replace(CONTROL_KEEP_NL, "").trim();
  return t === "" ? null : Array.from(t).slice(0, BODY_MAX).join("");
}

// ── правила дати (таблиця рішень S1.3, НФ-1) ───────────────────────────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function resolveDate(
  raw: RawItem,
  now: number,
  tz: string,
): { dueAt: number | null; allDay: boolean; clarify: Clarify | null } {
  const none = (clarify: Clarify | null) => ({ dueAt: null, allDay: false, clarify });
  if (raw.date_unclear) return none("unclear");
  if (raw.due_local === null) return none(raw.kind === "event" ? "event_no_date" : null);

  const dateOnly = DATE_ONLY.test(raw.due_local);
  if (dateOnly !== raw.all_day) return none("bad_format"); // дата без часу при all_day=false чи час при all_day=true
  const dueAt = localToUtc(raw.due_local, tz);
  if (dueAt === null) return none("bad_format");

  // Для «цілого дня» минуле — лише дата раніша за сьогодні в tz; для часу — `≤ now` (час рівно зараз уже позаду).
  const past = raw.all_day ? dueAt < dayBounds(tz, now)[0] : dueAt <= now;
  if (past) return none("past");
  if (dueAt > now + MAX_AHEAD_MS) return none("too_far");
  return { dueAt, allDay: raw.all_day, clarify: null };
}

function toParsed(raw: RawItem, now: number, tz: string): ParsedItem | null {
  const title = cut(cleanTitle(raw.title), TITLE_MAX, "…");
  if (title === "") return null; // порожній title = порушення схеми
  const d = resolveDate(raw, now, tz);
  return { kind: raw.kind, title, body: cleanBody(raw.body), priority: raw.priority, ...d };
}

// Порожній `items` — не помилка: з тексту виходить одна нотатка (перші ~80 символів).
function noteFromText(text: string): ParsedItem {
  const flat = cleanTitle(text);
  const title = Array.from(flat).slice(0, FALLBACK_TITLE_LEN).join("").trim() || "Нотатка";
  return { kind: "note", title, body: null, dueAt: null, allDay: false, priority: "normal", clarify: null };
}

// ── розбір ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function parseCapture(ctx: ParseContext, text: string): Promise<ParseOutcome> {
  const { client, db, userId, now, tz, model } = ctx;

  // НФ-5: ліміт рахується з ai_calls (усі purpose, успішні й ні). Вичерпано — виклику немає, як «ШІ недоступний».
  if ((await countToday(userId, db, tz, now)) >= ctx.dailyLimit) return { fallback: true, reason: "limit" };

  const { system, user } = buildPrompt({
    text,
    source: ctx.source ?? "text",
    nowLocal: localIso(now, tz),
    tz,
    weekday: weekdayName(now, tz),
  });

  // Журнал виклику: лише лічильники й мітка (НФ-2). Збій журналу не має губити захоплення.
  const record = async (ok: boolean, error: AiError | null, inTok: number, outTok: number) => {
    try {
      await logAiCall(
        userId,
        db,
        { model, purpose: "parse", ok, error, captureId: ctx.captureId ?? null, inputTokens: inTok, outputTokens: outTok },
        now,
      );
    } catch {
      console.error("ai_calls log failed"); // без тексту й id користувача
    }
  };

  const signal = AbortSignal.timeout(ctx.timeoutMs ?? AI_TIMEOUT_MS);
  let res;
  try {
    res = await client.complete({ model, system, user, schema: PARSE_SCHEMA, maxTokens: MAX_TOKENS, signal });
  } catch (e) {
    const kind: AiError = e instanceof AiCallError ? e.kind : signal.aborted ? "timeout" : "http";
    await record(false, kind, 0, 0);
    return { fallback: true, reason: "unavailable" };
  }

  const fail = async (error: AiError): Promise<ParseOutcome> => {
    await record(false, error, res.inputTokens, res.outputTokens);
    return { fallback: true, reason: "unavailable" };
  };

  // refusal (відмова моделі) — тексту немає; для журналу це «відповідь не за схемою». max_tokens — обрізаний JSON.
  if (res.stopReason === "refusal") return fail("schema");
  if (res.stopReason === "max_tokens") return fail("json");

  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    return fail("json");
  }
  const shaped = validateShape(json);
  if (shaped === null) return fail("schema");

  const items: ParsedItem[] = [];
  for (const raw of shaped) {
    const p = toParsed(raw, now, tz);
    if (p === null) return fail("schema");
    items.push(p);
  }

  await record(true, null, res.inputTokens, res.outputTokens);
  return { fallback: false, items: items.length === 0 ? [noteFromText(text)] : items };
}
