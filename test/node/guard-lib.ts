import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../..");

export interface SourceFile {
  path: string; // відносно кореня, зі скісними рисками: src/bot.ts
  text: string;
}

export function readSources(dir = "src"): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith(".ts")) out.push({ path: child, text: readFileSync(path.join(ROOT, child), "utf8") });
    }
  };
  walk(dir);
  return out;
}

export interface Violation {
  file: string;
  rule: string;
}

// 0.4.c: D1 лише в src/db/. Біндинг, SQL і тип D1Database поза шаром даних заборонені.
// Окреме слово DB ловить і `env.DB`, і деструктуризацію `const { DB } = env`, і `env["DB"]`;
// `.d1` / `d1Of` — шлях до біндингу через дескриптор Db.
const D1_PATTERNS: [string, RegExp][] = [
  ["env.DB / .DB", /\bDB\b/],
  [".prepare(", /\.prepare\s*\(/],
  ["D1Database", /D1Database/],
  ["db.d1", /\.d1\b/],
  ["d1Of", /\bd1Of\b/],
];

// 0.4.e: єдине джерело «зараз» — clock.ts.
const TIME_PATTERNS: [string, RegExp][] = [
  ["Date.now()", /\bDate\.now\s*\(/],
  ["new Date() без аргументів", /\bnew\s+Date\s*\(\s*\)/],
];

export function findViolations(files: SourceFile[]): Violation[] {
  const v: Violation[] = [];
  for (const f of files) {
    if (!f.path.startsWith("src/db/")) {
      for (const [rule, re] of D1_PATTERNS) if (re.test(f.text)) v.push({ file: f.path, rule });
    }
    if (f.path !== "src/clock.ts") {
      for (const [rule, re] of TIME_PATTERNS) if (re.test(f.text)) v.push({ file: f.path, rule });
    }
  }
  return v;
}

// 0.4.d: перший параметр кожної експортованої функції шару даних — userId, окрім явного закритого списку винятків.
// `src/db/index.ts` — теж у скані: там дозволено лише openDb (створює дескриптор) і d1Of (віддає D1 лише шару даних).
export const USERID_EXCEPTIONS: Record<string, string[]> = {
  "src/db/users.ts": ["ensureUser"],
  "src/db/index.ts": ["openDb", "d1Of"],
  // Функції над таблицями без власника (Фаза 0: серце cron). Закритий список, не виняток для файлу: новий
  // експорт тут без userId — червоний, поки його свідомо не впишуть сюди (R-0, R5).
  "src/db/system.ts": ["readHeartbeat", "heartbeat", "markPingOk", "queueSize"],
};

type ExportedFn = { name: string; firstParam: string | null };

const FIRST_PARAM = String.raw`\(\s*([^,:)\s]*)`;
const EXPORT_FN_FORMS: RegExp[] = [
  // export [async] function name<T>(first, …)
  new RegExp(String.raw`export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*` + FIRST_PARAM, "g"),
  // export const name[: Type] = [async] [function name] [<T>](first, …) …
  new RegExp(String.raw`export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\s*\w*\s*)?(?:<[^>]*>\s*)?` + FIRST_PARAM, "g"),
  // export const name = [async] first => …
  /export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(\w+)\s*=>/g,
];
// Початок ініціалізатора, який точно не функція: літерал рядка/числа/масиву/об'єкта.
const LITERAL_INIT = /^(?:["'`\d\[{-]|new\s)/;

export function exportedFunctions(text: string): ExportedFn[] {
  const out: ExportedFn[] = [];
  for (const re of EXPORT_FN_FORMS) for (const m of text.matchAll(re)) out.push({ name: m[1]!, firstParam: m[2] ? m[2] : null });
  return out;
}

// Експорти, які сканер не вміє класифікувати (alias, re-export, default) — fail-closed: їх теж треба вписати у виняток.
export function unrecognizedExports(text: string): string[] {
  const known = new Set(exportedFunctions(text).map((f) => f.name));
  const bad: string[] = [];
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+(\w+)[^=]*=\s*([^\n]*)/g)) {
    if (!known.has(m[1]!) && !LITERAL_INIT.test(m[2]!.trim())) bad.push(m[1]!);
  }
  for (const m of text.matchAll(/export\s+(?:let|var)\s+(\w+)/g)) if (!bad.includes(m[1]!)) bad.push(m[1]!);
  if (/export\s*\*/.test(text)) bad.push("export *");
  if (/export\s*\{/.test(text)) bad.push("export { … }");
  if (/export\s+default\b/.test(text)) bad.push("export default");
  return bad;
}

export function userIdViolations(files: SourceFile[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    if (!f.path.startsWith("src/db/")) continue;
    const allowed = USERID_EXCEPTIONS[f.path] ?? [];
    for (const fn of exportedFunctions(f.text)) {
      if (fn.firstParam !== "userId" && !allowed.includes(fn.name)) bad.push(`${f.path}: ${fn.name}(${fn.firstParam ?? ""})`);
    }
    for (const name of unrecognizedExports(f.text)) if (!allowed.includes(name)) bad.push(`${f.path}: ${name} (експорт не розпізнано)`);
  }
  return bad;
}

// 0.5.c: токеноподібний рядок не живе в жодному трекнутому текстовому файлі. Список виключень, а не дозволених
// розширень: новий тип файлу (.mjs, .py, Dockerfile) потрапляє під скан сам.
export const TOKEN_RE = /\d{8,}:[\w-]{30,}/;
const SCAN_EXCLUDED = ["package-lock.json", "worker-configuration.d.ts"];
export function scannableTextFiles(tracked: string[]): string[] {
  return tracked.filter((f) => !SCAN_EXCLUDED.includes(f));
}
