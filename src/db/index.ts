import type { AppEnv } from "../env";

// Непрозорий дескриптор БД (спека 0.4.c): у нього немає публічних полів, тож `db.d1` поза шаром даних —
// помилка компіляції (див. test/worker/opaque-db.typecheck.ts). Біндинг лежить у WeakMap цього модуля;
// дістати його можна лише через `d1Of`, яку викликають файли src/db/** (решту стереже тест-сканер).
declare const brand: unique symbol;
export interface Db {
  readonly [brand]: true;
}

const handles = new WeakMap<Db, NonNullable<AppEnv["DB"]>>();

export function openDb(env: AppEnv): Db {
  const d1 = env.DB;
  if (!d1) throw new Error("DB binding is missing");
  const db = Object.freeze({}) as Db;
  handles.set(db, d1);
  return db;
}

export function d1Of(db: Db): NonNullable<AppEnv["DB"]> {
  const d1 = handles.get(db);
  if (!d1) throw new Error("Db handle is not from openDb");
  return d1;
}
