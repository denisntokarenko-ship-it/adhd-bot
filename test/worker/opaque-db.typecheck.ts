// Не тест, а перевірка типів (`npm run typecheck`): дескриптор Db непрозорий — поза src/db/ компілятор
// не дає дістатися до D1 (спека 0.4.c, рев'ю 0.4 В1). Якщо поле d1 знову стане доступним,
// директива нижче стане «зайвою» і typecheck почервоніє.
import type { Db } from "../../src/db/index";

declare const db: Db;

// @ts-expect-error Db не має публічного поля d1
export const leak = db.d1;
