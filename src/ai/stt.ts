// Розпізнавання голосу (крок 1.4): Telegram getFile → байти ogg/opus → Workers AI Whisper.
// Claude аудіо не приймає, тож це окремий від `client.ts` шлях: STT не пишеться в `ai_calls` і не рахується
// в денний ліміт Claude (S1.7.f). Текст голосу — дані, як і будь-який інший текст людини (НФ-2).
export const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const STT_LANGUAGE = "uk";
export const STT_TIMEOUT_MS = 20_000;
export const MAX_VOICE_SECONDS = 300; // припущення (open-questions.md): довше — «розріж на частини»
export const MIN_TEXT_CHARS = 2;

// vad_filter: без нього Whisper на тиші/шумі видає «Дякую за перегляд!» (перевірено живцем) — фантомний запис.
// Те, що потрібно від Workers AI: один виклик моделі. У тестах — мок.
export interface Stt {
  transcribe(audio: ArrayBuffer): Promise<string>;
}

export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function createStt(ai: WorkersAiBinding, timeoutMs = STT_TIMEOUT_MS): Stt {
  return {
    async transcribe(audio) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("stt timeout")), timeoutMs);
      });
      try {
        const out = (await Promise.race([
          ai.run(STT_MODEL, { audio: toBase64(audio), language: STT_LANGUAGE, task: "transcribe", vad_filter: true }),
          limit,
        ])) as { text?: unknown } | null;
        return typeof out?.text === "string" ? out.text.trim() : "";
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// Telegram Bot API: getFile → файл за `file_path`. Токен у URL — лише тут і не логується.
export async function downloadTelegramFile(token: string, filePath: string): Promise<ArrayBuffer> {
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!res.ok) throw new Error(`telegram file ${res.status}`);
  return res.arrayBuffer();
}
