import type { AppEnv } from "../env";

// Непрозорий дескриптор БД: єдине місце, де код бере біндинг із env. Решта src/** (поза src/db/)
// про біндинг не знає й передає цей дескриптор у функції шару даних (спека 0.4.c).
export interface Db {
  readonly d1: NonNullable<AppEnv["DB"]>;
}

export function openDb(env: AppEnv): Db {
  const d1 = env.DB;
  if (!d1) throw new Error("DB binding is missing");
  return { d1 };
}
