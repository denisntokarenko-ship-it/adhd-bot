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
const D1_PATTERNS: [string, RegExp][] = [
  ["env.DB / .DB", /\.DB\b/],
  [".prepare(", /\.prepare\s*\(/],
  ["D1Database", /D1Database/],
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

// 0.4.d: перший параметр кожної експортованої функції src/db/users.ts — userId, окрім явного списку винятків.
export const USERID_EXCEPTIONS: Record<string, string[]> = {
  "src/db/users.ts": ["ensureUser"],
};
export const SYSTEM_FILES = ["src/db/system.ts"]; // функції без власника — закритий список винятків за спекою

export function exportedFunctions(text: string): { name: string; firstParam: string | null }[] {
  const re = /export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(\s*([^,:)\s]*)/g;
  const out: { name: string; firstParam: string | null }[] = [];
  for (const m of text.matchAll(re)) out.push({ name: m[1]!, firstParam: m[2] ? m[2] : null });
  return out;
}

export function userIdViolations(files: SourceFile[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    if (!f.path.startsWith("src/db/") || f.path === "src/db/index.ts" || SYSTEM_FILES.includes(f.path)) continue;
    const allowed = USERID_EXCEPTIONS[f.path] ?? [];
    for (const fn of exportedFunctions(f.text)) {
      if (fn.firstParam !== "userId" && !allowed.includes(fn.name)) bad.push(`${f.path}: ${fn.name}(${fn.firstParam ?? ""})`);
    }
  }
  return bad;
}
