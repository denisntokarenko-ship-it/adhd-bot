// Нотатка з тексту людини — ЄДИНЕ місце, де з сирого тексту роблять заголовок і тіло запису (шов 1 рев'ю R-1).
// Раніше їх було дві (`saveFallback` у шарі даних і `noteFromText` у розборі) — той самий текст давав різні заголовки
// залежно від того, чи впав ШІ. Тепер обидва шляхи й заголовки від ШІ проходять через цей файл.
import { BODY_MAX } from "./ai/schema";

export const FALLBACK_TITLE_LEN = 80;

// Керуючі символи й нулі (крім \n, \t у body) — геть. У title рядки схлопуються в один.
export const CONTROL_KEEP_NL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function cleanTitle(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(CONTROL_KEEP_NL, "").trim();
}

export function cleanBody(s: string | null): string | null {
  if (s === null) return null;
  const t = s.replace(/\r\n?/g, "\n").replace(CONTROL_KEEP_NL, "").trim();
  return t === "" ? null : Array.from(t).slice(0, BODY_MAX).join("");
}

// Заголовок — перші ~80 символів без керуючих символів, пробіли схлопнуті; порожній текст → «Нотатка».
// Тіло — увесь текст (очищений). Яке з двох брати, вирішує виклик: запасна нотатка тримає тіло (S1.5.a),
// нотатка з порожньої відповіді ШІ — лише заголовок (S1.4.g).
export function noteFromText(text: string): { title: string; body: string | null } {
  const flat = cleanTitle(text).replace(/ {2,}/g, " ");
  const title = Array.from(flat).slice(0, FALLBACK_TITLE_LEN).join("").trim() || "Нотатка";
  return { title, body: cleanBody(text) };
}
