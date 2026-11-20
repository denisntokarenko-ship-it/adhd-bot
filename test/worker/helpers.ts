import { env } from "cloudflare:test";
import { vi } from "vitest";
import { handleRequest } from "../../src/app";
import type { BotDeps } from "../../src/bot";
import type { AppEnv } from "../../src/env";

export const NOW = Date.parse("2026-11-20T10:00:00Z");
export const SECRET = "test-webhook-secret";

export function baseEnv(overrides: Partial<Record<keyof AppEnv, unknown>> = {}): AppEnv {
  const merged = { ...(env as unknown as AppEnv), ...overrides } as Record<string, unknown>;
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged as AppEnv;
}

export function deps(over: Partial<BotDeps> & { now?: number } = {}): BotDeps {
  const now = over.now ?? NOW;
  return { clock: over.clock ?? { now: () => now }, rand: over.rand ?? (() => 0), ...(over.ai !== undefined ? { ai: over.ai } : {}),
    ...(over.aiTimeoutMs !== undefined ? { aiTimeoutMs: over.aiTimeoutMs } : {}),
  };
}

export interface TgCall {
  method: string;
  body: Record<string, unknown>;
}

// Підміняє fetch: жодних реальних викликів Telegram (НФ-11). Записує кожен виклик API.
export function mockTelegram(opts: { failSend?: boolean } = {}) {
  const calls: TgCall[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = /\/bot[^/]+\/(\w+)/.exec(url);
    const method = m?.[1] ?? "unknown";
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      /* multipart не потрібен */
    }
    calls.push({ method, body });
    if (opts.failSend) throw new TypeError("network down");
    const result = method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: 1, type: "private" } } : true;
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  });
  return { calls, spy, sent: () => calls.filter((c) => c.method === "sendMessage") };
}

let updateId = 1000;

export function textUpdate(text: string, opts: { from?: number; chatType?: string; chatId?: number } = {}) {
  const from = opts.from ?? 111;
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: opts.chatId ?? from, type: opts.chatType ?? "private" },
      from: { id: from, is_bot: false, first_name: "T" },
      text,
    },
  };
}

export function post(update: unknown, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return new Request("https://bot.test/webhook", { method: "POST", headers, body: JSON.stringify(update) });
}

export async function send(update: unknown, e: AppEnv = baseEnv(), d: BotDeps = deps(), secret: string | null = SECRET) {
  return handleRequest(post(update, secret), e, d);
}

export async function userRows(): Promise<Record<string, unknown>[]> {
  const r = await env.DB!.prepare("SELECT * FROM users ORDER BY id").all<Record<string, unknown>>();
  return r.results;
}
