import type { Clock } from "./clock";
import { openDb } from "./db/index";
import { heartbeat, markPingOk } from "./db/system";
import type { AppEnv } from "./env";
import { planDigests } from "./digests/planner";
import { dispatchReminders } from "./reminders/dispatch";
import { planReminders } from "./reminders/planner";
import { processPending, type RetryDeps } from "./retry";

export const PING_TIMEOUT_MS = 5_000;
const KEY = "cron";

// Пінг монітора (НФ-6, крок 2). Ніколи не кидає: збій пінгу лише логуємо, а `last_ping_ok_at` лишаємо старим.
// URL — секрет: у лог іде лише статус чи назва помилки.
async function pingMonitor(env: AppEnv, clock: Clock): Promise<void> {
  const url = env.MONITOR_PING_URL?.trim();
  if (!url) {
    if (env.ENV === "production") console.error("monitor: MONITOR_PING_URL is missing"); // кожен прогін (0.3.e)
    else console.warn("monitor: MONITOR_PING_URL is not set, ping skipped");
    return;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: ctl.signal });
    if (!res.ok) {
      console.error("monitor: ping failed, status", res.status);
      return;
    }
    await markPingOk(openDb(env), KEY, clock.now());
  } catch (err) {
    console.error("monitor: ping error", err instanceof Error ? err.name : "unknown");
  } finally {
    clearTimeout(timer);
  }
}

// Одна хвилина роботи cron (НФ-6): (1) серце → (2) пінг лише після успішного (1) → (3) решта у try/catch.
// Збій (1) НЕ ловимо: прогін падає, пінгу немає, монітор б'є тривогу.
// `deps` — лише для тестів (мок ШІ, STT); у проді cron бере ключі з оточення.
export async function runScheduled(env: AppEnv, clock: Clock, deps: RetryDeps = {}): Promise<void> {
  const db = openDb(env);
  try {
    await heartbeat(db, KEY, clock.now());
  } catch (err) {
    console.error("cron: heartbeat write failed", err instanceof Error ? err.name : "unknown");
    throw err;
  }
  await pingMonitor(env, clock);
  try {
    await processQueue(env, clock, deps);
  } catch (err) {
    console.error("cron: extra work failed", err instanceof Error ? err.name : "unknown");
  }
}

// (3) решта хвилини (S2.3): нагадування → підбір pending-захоплень. Нагадування першими: підбір робить до 3
// довгих викликів ШІ/STT, а нагадування найчутливіші до часу. Кожна частина у своєму try/catch: збій
// планувальника не зупиняє підбір pending (і навпаки), пінг уже пішов.
async function processQueue(env: AppEnv, clock: Clock, deps: RetryDeps): Promise<void> {
  try {
    await planReminders(openDb(env), clock.now());
  } catch (err) {
    console.error("cron: reminders failed", err instanceof Error ? err.name : "unknown");
  }
  // Огляди (S3.1): доплановування відсутнього `pending` — кожен тик, після планувальника записів і до відправки.
  try {
    await planDigests(openDb(env), clock.now());
  } catch (err) {
    console.error("cron: digests planning failed", err instanceof Error ? err.name : "unknown");
  }
  // Відправка: STALE → тиша → оренда → добір → відправка → закриття (S2.3). Свій try/catch: збій відправки не гасить підбір.
  try {
    await dispatchReminders(env, clock, deps.rand === undefined ? {} : { rand: deps.rand });
  } catch (err) {
    console.error("cron: dispatch failed", err instanceof Error ? err.name : "unknown");
  }
  await processPending(env, clock, deps);
}
