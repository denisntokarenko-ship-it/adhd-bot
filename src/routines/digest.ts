// Рутини в оглядах (docs/spec/phase-4.md, S4.8–S4.9; Р4.6: огляди — код без ШІ, читати рутини їм можна).
// Ранок — рутини дня одним рядком; вечір — «прийнято N з M» за `scheduled_for` у межах доби (4.9.d), без провалів.
import type { Db } from "../db/index";
import { listLogs, listRoutines } from "../db/routines";
import { localIso } from "../time";
import { eveningRoutinesLine, morningRoutinesLine, type MorningRoutine } from "./render";
import { slotsOfDay } from "./schedule";

// Активні рутини зі слотами в локальній добі `[dayStart, dayEnd)`; `✓` — лише слоти з `taken` (4.8.a).
export async function morningRoutines(userId: number, db: Db, tz: string, dayStart: number, dayEnd: number): Promise<string | null> {
  const date = localIso(dayStart, tz).slice(0, 10);
  const [routines, logs] = await Promise.all([listRoutines(userId, db), listLogs(userId, db, dayStart, dayEnd)]);
  const taken = new Set(logs.filter((l) => l.status === "taken").map((l) => `${l.routine_id}:${l.scheduled_for}`));
  const rows: (MorningRoutine & { first: number; id: number })[] = [];
  for (const r of routines) {
    if (!r.active) continue;
    const slots = slotsOfDay(r, date, tz).filter((s) => s >= dayStart && s < dayEnd);
    if (slots.length === 0) continue;
    rows.push({
      id: r.id,
      kind: r.kind,
      title: r.title,
      first: slots[0]!,
      slots: slots.map((s) => ({ at: localIso(s, tz).slice(11, 16), taken: taken.has(`${r.id}:${s}`) })),
    });
  }
  rows.sort((a, b) => a.first - b.first || a.id - b.id);
  return morningRoutinesLine(rows);
}

// M — рядки `routine_logs` доби (`taken` + `skipped` + `missed`), N — `taken`. Слоти без рядка не рахуються (4.9.a).
export async function eveningRoutines(userId: number, db: Db, dayStart: number, dayEnd: number): Promise<string | null> {
  const logs = await listLogs(userId, db, dayStart, dayEnd);
  return eveningRoutinesLine(logs.filter((l) => l.status === "taken").length, logs.length);
}
