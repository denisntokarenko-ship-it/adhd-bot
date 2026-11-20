// Єдине місце, що створює клієнт Claude й імпортує SDK (охоронець: test/node/ai-boundary.test.ts).
// Решта коду бачить лише вузький інтерфейс AiClient — його легко підмінити моком (НФ-11).
import Anthropic from "@anthropic-ai/sdk";

export interface AiRequest {
  model: string;
  system: string; // сталий текст: кешується (cache_control на блоці system)
  user: string;
  schema: Record<string, unknown>; // JSON-схема structured outputs
  maxTokens: number;
  signal: AbortSignal; // таймаут тримає викликач (parse.ts): 20 с, НФ-2
}

export interface AiResponse {
  text: string; // перший text-блок; порожній, якщо його немає (refusal, max_tokens)
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

// Недоступність у «людських» категоріях: timeout — скасовано/завис, http — 4xx/429/5xx чи мережа.
export class AiCallError extends Error {
  constructor(
    readonly kind: "timeout" | "http",
    readonly status?: number,
    // «тип: повідомлення» з тіла помилки Anthropic (для діагностики; без заголовків і без ключа). parse.ts його не логує.
    readonly detail?: string,
  ) {
    super(`ai ${kind}${status === undefined ? "" : ` ${status}`}`);
  }
}

export interface AiClient {
  complete(req: AiRequest): Promise<AiResponse>;
}

// Тіло помилки API: { type: "error", error: { type, message } } → "invalid_request_error: …".
function errorDetail(e: { error?: unknown }): string | undefined {
  const inner = (e.error as { error?: { type?: unknown; message?: unknown } } | undefined)?.error;
  if (!inner || typeof inner.message !== "string") return undefined;
  return `${typeof inner.type === "string" ? inner.type : "error"}: ${inner.message}`.slice(0, 500);
}

export function createAiClient(apiKey: string, opts: { fetch?: typeof fetch } = {}): AiClient {
  // maxRetries: 0 — повтори тримає черга захоплень (S1.5), а не SDK: інакше 3 спроби × 20 с з'їдять бюджет НФ-10.
  const sdk = new Anthropic({ apiKey, maxRetries: 0, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  return {
    async complete(req) {
      try {
        const msg = await sdk.messages.create(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            // Лише `low`: розбір фрази — витяг, не міркування; дефолт Haiku 5.5 (`medium`) дорожчий й повільніший.
            output_config: { effort: "low", format: { type: "json_schema", schema: req.schema } },
            system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
            // Без prefill (400 на 4.6+): формат тримає output_config.format, не хвіст відповіді.
            messages: [{ role: "user", content: req.user }],
          },
          { signal: req.signal },
        );
        const block = msg.content.find((b) => b.type === "text");
        return {
          text: block && block.type === "text" ? block.text : "",
          stopReason: msg.stop_reason,
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
        };
      } catch (e) {
        if (e instanceof Anthropic.APIUserAbortError || e instanceof Anthropic.APIConnectionTimeoutError) {
          throw new AiCallError("timeout");
        }
        if (req.signal.aborted) throw new AiCallError("timeout");
        if (e instanceof Anthropic.APIError) throw new AiCallError("http", e.status, errorDetail(e));
        throw new AiCallError("http");
      }
    },
  };
}
