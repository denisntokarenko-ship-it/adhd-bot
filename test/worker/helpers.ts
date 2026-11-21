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
    ...(over.stt !== undefined ? { stt: over.stt } : {}),
    ...(over.aiTimeoutMs !== undefined ? { aiTimeoutMs: over.aiTimeoutMs } : {}),
  };
}

export interface TgCall {
  method: string;
  body: Record<string, unknown>;
}

// Підміняє fetch: жодних реальних викликів Telegram (НФ-11). Записує кожен виклик API.
export interface SendError {
  code: number; // HTTP/Telegram-код відповіді на sendMessage: 429, 403, 500…
  retryAfter?: number;
  description?: string; // текст помилки Telegram (клас помилки в лозі оглядів, 3.1.h); за замовчуванням `mock <code>`
  // яким за рахунком викликам sendMessage (1-based) віддавати помилку; за замовчуванням — усім
  only?: number[];
}

export function mockTelegram(opts: { failSend?: boolean; failDownload?: boolean; seqIds?: boolean; failMethods?: string[]; sendError?: SendError; onSend?: (n: number) => Promise<void> | void } = {}) {
  const calls: TgCall[] = [];
  let sends = 0;
  let seq = 100;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/file/bot")) {
      // Скачування файлу голосового (S1.7): байти, не JSON; фіксуємо як «download».
      calls.push({ method: "download", body: { url } });
      return new Response(new Uint8Array([79, 103, 103, 83]), { status: opts.failDownload ? 500 : 200 });
    }
    const m = /\/bot[^/]+\/(\w+)/.exec(url);
    const method = m?.[1] ?? "unknown";
    let body: Record<string, unknown> = {};
    const raw = init?.body;
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      // Multipart (sendDocument, S1.11): grammY шле потік; розбираємо поля й файл `document` у { name, text }.
      const text = await new Response(raw as BodyInit).text();
      const boundary = text.slice(0, text.indexOf("\r\n"));
      const files: Record<string, { name: string; text: string }> = {};
      for (const part of text.split(boundary).slice(1)) {
        const at = part.indexOf("\r\n\r\n");
        if (at < 0) continue;
        const head = part.slice(0, at);
        const content = part.slice(at + 4).replace(/\r\n$/, "");
        const name = /name="?([^";\r\n]+)/.exec(head)?.[1];
        const filename = /filename="?([^";\r\n]+)/.exec(head)?.[1];
        if (name === undefined) continue;
        if (filename === undefined) body[name] = content;
        else files[name] = { name: filename, text: content };
      }
      // grammY шле файл за схемою attach://<id>: у `document` лежить посилання на частину.
      const ref = typeof body.document === "string" ? body.document.replace("attach://", "") : "";
      if (files[ref]) body.document = files[ref];
    } else {
      try {
        body = JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
      } catch {
        /* не JSON */
      }
    }
    calls.push({ method, body });
    if (opts.failSend) throw new TypeError("network down");
    if (opts.failMethods?.includes(method)) {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "mock 400" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (method === "sendMessage") {
      sends += 1;
      await opts.onSend?.(sends);
      const e = opts.sendError;
      if (e !== undefined && (e.only === undefined || e.only.includes(sends))) {
        return new Response(
          JSON.stringify({ ok: false, error_code: e.code, description: e.description ?? `mock ${e.code}`, ...(e.retryAfter === undefined ? {} : { parameters: { retry_after: e.retryAfter } }) }),
          { status: e.code, headers: { "content-type": "application/json" } },
        );
      }
    }
    const result =
      method === "sendMessage" || method === "sendDocument"
        ? { message_id: opts.seqIds ? ++seq : 1, date: 0, chat: { id: 1, type: "private" } }
        : method === "getFile"
          ? { file_id: String(body.file_id), file_unique_id: "u", file_path: "voice/file_1.oga" }
          : true;
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  });
  return {
    calls,
    spy,
    sent: () => calls.filter((c) => c.method === "sendMessage"),
    docs: () => calls.filter((c) => c.method === "sendDocument"),
  };
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

interface MsgOpts {
  from?: number;
  forward?: boolean; // переслано: forward_origin з іменем відправника (його не має бути в промпті)
}

function base(opts: MsgOpts) {
  const from = opts.from ?? 111;
  const id = ++updateId;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: from, type: "private" },
      from: { id: from, is_bot: false, first_name: "T" },
      ...(opts.forward
        ? { forward_origin: { type: "user", date: 0, sender_user: { id: 999, is_bot: false, first_name: "Секретна", last_name: "Незнайомка" } } }
        : {}),
    },
  };
}

export const voiceUpdate = (duration: number, opts: MsgOpts = {}) => {
  const u = base(opts);
  return { ...u, message: { ...u.message, voice: { file_id: "VOICE_FILE", file_unique_id: "u", duration, mime_type: "audio/ogg" } } };
};
export const forwardText = (text: string) => {
  const u = base({ forward: true });
  return { ...u, message: { ...u.message, text } };
};
export const photoUpdate = (opts: MsgOpts & { caption?: string } = {}) => {
  const u = base(opts);
  return {
    ...u,
    message: {
      ...u.message,
      photo: [{ file_id: "p", file_unique_id: "pu", width: 1, height: 1 }],
      ...(opts.caption === undefined ? {} : { caption: opts.caption }),
    },
  };
};

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
