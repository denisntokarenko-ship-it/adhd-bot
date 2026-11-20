import type { Clock } from "./clock";
import { openDb } from "./db/index";
import { heartbeat, markPingOk } from "./db/system";
import type { AppEnv } from "./env";

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
export async function runScheduled(env: AppEnv, clock: Clock): Promise<void> {
  const db = openDb(env);
  try {
    await heartbeat(db, KEY, clock.now());
  } catch (err) {
    console.error("cron: heartbeat write failed", err instanceof Error ? err.name : "unknown");
    throw err;
  }
  await pingMonitor(env, clock);
  try {
    await processQueue(env, clock);
  } catch (err) {
    console.error("cron: extra work failed", err instanceof Error ? err.name : "unknown");
  }
}

// TODO(2.2): обробка черги нагадувань і відправка — крок 2.1–2.2. Тут навмисно порожньо.
async function processQueue(_env: AppEnv, _clock: Clock): Promise<void> {}
