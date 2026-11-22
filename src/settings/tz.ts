// Перевірка назви поясу для `/tz` (S3.7.c). Окремо від `choices.ts`: без імпортів, тож її тестує й node-проєкт.
// `/tz <назва>`: 1–64 символи, форма IANA (літери, цифри, `_ + - /`; відсікає зсуви на кшталт «+02:00»), і `Intl` її знає.
// Повертає канонічну назву (регістр виправляється) або `null`. Нічого не змінює — зміну робить виклик.
export function parseTz(raw: string): string | null {
  const name = raw.trim();
  if (name.length < 1 || name.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(name)) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
