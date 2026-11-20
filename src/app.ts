import { BotError } from "grammy";
import type { Update } from "grammy/types";
import { processUpdate, type BotDeps } from "./bot";
import { systemClock } from "./clock";
import { secretsEqual } from "./config";
import type { AppEnv } from "./env";
import { RetryableError } from "./errors";
import { healthResponse } from "./health";

const defaultDeps: BotDeps = { clock: systemClock, rand: Math.random };

const text = (status: number, body: string): Response => new Response(body, { status });

export async function handleRequest(
  request: Request,
  env: AppEnv,
  deps: BotDeps = defaultDeps,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/health") {
    if (request.method !== "GET") return text(405, "");
    return healthResponse(env, deps.clock);
  }

  if (pathname === "/webhook") {
    if (request.method !== "POST") return text(405, "");
    // Fail-closed: без секрету (undefined, "", пробіли) не пускаємо нікого — до allowlist і до розбору тіла (0.1.e, 0.1.g).
    const expected = env.WEBHOOK_SECRET;
    if (expected === undefined || expected.trim() === "") return text(401, "");
    const given = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (given === null || !(await secretsEqual(given, expected))) return text(401, "");

    let update: Update;
    try {
      update = (await request.json()) as Update;
    } catch {
      return text(400, "");
    }
    // Отруйний update не має блокувати чергу доставки: помилку лише логуємо, Telegram отримує 200 (0.7.a).
    // Хук помилок grammY у вебхуку не викликається (він для polling), тому ловимо тут (0.7.b).
    try {
      await processUpdate(update, env, deps);
    } catch (err) {
      console.error("update failed", err instanceof Error ? err.name : "unknown");
      // Нічого не збережено (збій D1 на ensureUser/захопленні) → 500: Telegram повторить, а запис не загубиться (S1.4.h).
      // grammY заворачує помилки обробника в BotError — розпаковуємо.
      if ((err instanceof BotError ? err.error : err) instanceof RetryableError) return text(500, "");
    }
    return text(200, "");
  }

  return text(404, "");
}
