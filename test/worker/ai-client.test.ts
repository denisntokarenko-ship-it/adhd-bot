// Справжній SDK у workerd (живий доказ, що `@anthropic-ai/sdk` працює у Workers) проти підміненого fetch:
// запит перевіряємо за формою, відповідь віддаємо свою. Реальних викликів Claude немає (НФ-11).
import { describe, expect, it } from "vitest";
import { AiCallError, createAiClient, type AiRequest } from "../../src/ai/client";
import { PARSE_SCHEMA } from "../../src/ai/schema";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const okMessage = (text: string) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 7 },
});

const req = (over: Partial<AiRequest> = {}): AiRequest => ({
  model: "claude-haiku-5-5",
  system: "SYSTEM",
  user: "USER",
  schema: PARSE_SCHEMA,
  maxTokens: 4096,
  signal: AbortSignal.timeout(5_000),
  ...over,
});

describe("createAiClient (SDK у workerd)", () => {
  it("форма запиту: structured outputs, system з cache_control, без prefill і без sampling-параметрів", async () => {
    const seen: { url: string; body: Record<string, any>; headers: Headers }[] = [];
    const client = createAiClient("sk-ant-test-key", {
      fetch: async (input, init) => {
        const r = new Request(input as RequestInfo, init);
        seen.push({ url: r.url, body: (await r.json()) as Record<string, any>, headers: r.headers });
        return reply(200, okMessage('{"items":[]}'));
      },
    });
    const res = await client.complete(req());
    expect(res).toEqual({ text: '{"items":[]}', stopReason: "end_turn", inputTokens: 11, outputTokens: 7 });

    expect(seen).toHaveLength(1);
    const { url, body, headers } = seen[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers.get("authorization")).toBe("Bearer sk-ant-test-key"); // SDK 1.x шле apiKey як Bearer
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.output_config.format).toEqual({ type: "json_schema", schema: PARSE_SCHEMA });
    expect(body.output_config.effort).toBe("low");
    expect(body.system).toEqual([{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
    expect(body.messages).toEqual([{ role: "user", content: "USER" }]); // жодного assistant-prefill
    for (const k of ["temperature", "top_p", "top_k", "thinking", "tools"]) expect(body).not.toHaveProperty(k);
  });

  it.each([429, 500, 529])("HTTP %i → AiCallError http, без прихованих повторів SDK", async (status) => {
    let calls = 0;
    const client = createAiClient("k", {
      fetch: async () => {
        calls++;
        return reply(status, { type: "error", error: { type: "api_error", message: "boom" } });
      },
    });
    const err = await client.complete(req()).catch((e) => e);
    expect(err).toBeInstanceOf(AiCallError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(status);
    expect(calls).toBe(1);
  });

  it("тіло помилки Anthropic потрапляє в detail (діагностика), без заголовків і ключа", async () => {
    const client = createAiClient("sk-ant-secret-value", {
      fetch: async () =>
        reply(400, { type: "error", error: { type: "invalid_request_error", message: "output_config.format: bad schema" } }),
    });
    const err = (await client.complete(req()).catch((e) => e)) as AiCallError;
    expect(err.status).toBe(400);
    expect(err.detail).toBe("invalid_request_error: output_config.format: bad schema");
    expect(err.detail).not.toContain("sk-ant-secret-value");
  });

  it("мережа впала → http; сигнал скасовано → timeout", async () => {
    const down = createAiClient("k", {
      fetch: async () => {
        throw new TypeError("network down");
      },
    });
    expect(await down.complete(req()).catch((e) => e.kind)).toBe("http");

    const hang = createAiClient("k", {
      fetch: (_input, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    expect(await hang.complete(req({ signal: AbortSignal.timeout(30) })).catch((e) => e.kind)).toBe("timeout");
  });

  it("refusal без text-блоку → порожній text і stopReason refusal", async () => {
    const client = createAiClient("k", {
      fetch: async () => reply(200, { ...okMessage(""), content: [], stop_reason: "refusal" }),
    });
    const res = await client.complete(req());
    expect(res.text).toBe("");
    expect(res.stopReason).toBe("refusal");
  });
});
