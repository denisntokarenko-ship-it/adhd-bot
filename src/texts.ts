// Репліки бота: «друг з гумором», без сорому (НФ-4). Кожен пул ≥ 3 варіантів, підряд не повторюється.
export const GREET_POOL: readonly string[] = [
  "Привіт! Я твоя зовнішня пам'ять: кидай сюди думки, а я їх підберу 🧠",
  "О, привіт! Тут можна скинути все, що крутиться в голові, — я потримаю 📌",
  "Привіт-привіт! Скидай справи й ідеї сюди, голова хай відпочине ☕",
];

export const SOON_POOL: readonly string[] = [
  "Записувати я ще не вмію — навчуся зовсім скоро 🌱",
  "Поки що я тільки вчуся ловити записи. Дай мені трохи часу 🛠️",
  "Цього я ще не вмію, але вже скоро буде! Заходь пізніше 🙂",
];

// Чужому (поза allowlist) — одна статична відповідь, без варіацій і без ШІ (0.6.a).
export const PRIVATE_BOT_TEXT = "Це приватний бот, тому тут я нічим не допоможу 🙂";

// Індекс варіанта, що не збігається з попереднім (last). rand ∈ [0,1) — інжектується для тестів.
export function pickVariant(poolSize: number, last: number | null, rand: () => number): number {
  const candidates: number[] = [];
  for (let i = 0; i < poolSize; i++) if (i !== last) candidates.push(i);
  const pick = candidates[Math.floor(rand() * candidates.length)];
  return pick ?? 0;
}
