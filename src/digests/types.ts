// Запис у змісті огляду: лише поля, потрібні тексту й порядку (без БД — щоб render.ts лишався чистим).
export interface DigestItem {
  id: number;
  title: string;
  due_at: number | null;
  all_day: number;
  priority: "normal" | "important";
  created_at: number;
}
