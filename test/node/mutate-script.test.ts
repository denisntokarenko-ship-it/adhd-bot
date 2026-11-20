import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// S0.8.b: scripts/mutate.py відмовляється працювати з брудним деревом (правило 9 CLAUDE.md).
const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/mutate.py");
const python = ["python", "python3"].find((p) => spawnSync(p, ["--version"]).status === 0);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

// Мінімальний проєкт: target.txt з мутованим фрагментом і тест, що червоніє, коли в ньому є MUTANT.
function project(opts: { repo: boolean }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mutate-test-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "target.txt"), "value = GOOD\n");
  writeFileSync(path.join(dir, "check.mjs"), "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('target.txt', 'utf8').includes('MUTANT') ? 1 : 0);\n");
  writeFileSync(
    path.join(dir, "mutants.toml"),
    'test = "node check.mjs"\n[[mutant]]\nid = "M1"\nfile = "target.txt"\nold = "GOOD"\nnew = "MUTANT"\nwhy = "test"\n',
  );
  if (opts.repo) {
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

const run = (dir: string) =>
  spawnSync(python!, ["-I", SCRIPT, "mutants.toml", "--root", dir, "--logs", path.join(dir, ".logs")], { cwd: dir, encoding: "utf8" });
const target = (dir: string) => readFileSync(path.join(dir, "target.txt"), "utf8");

describe("S0.8.b scripts/mutate.py і брудне дерево", () => {
  it("є інтерпретатор Python (інакше решта тестів нічого не доводять)", () => {
    expect(python, "ні `python`, ні `python3` у PATH").toBeDefined();
  });

  it("0.8.b: змінений трекнутий файл → вихід 2, файл не чіпано, бекапу немає", () => {
    const dir = project({ repo: true });
    writeFileSync(path.join(dir, "target.txt"), "value = GOOD\n// незакомічена правка\n");
    const r = run(dir);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("дерево не чисте");
    expect(target(dir)).toBe("value = GOOD\n// незакомічена правка\n");
    expect(existsSync(path.join(dir, ".mutate-backup"))).toBe(false);
  });

  it("0.8.b: новий нетрекнутий файл теж робить дерево брудним", () => {
    const dir = project({ repo: true });
    writeFileSync(path.join(dir, "new.txt"), "x");
    const r = run(dir);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("new.txt");
    expect(target(dir)).toBe("value = GOOD\n");
  });

  it("0.8.b: не git-репозиторій — теж відмова (fail-closed), а не «мабуть, чисто»", () => {
    const dir = project({ repo: false });
    const r = run(dir);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("дерево не чисте");
    expect(target(dir)).toBe("value = GOOD\n");
  });

  it("0.8.b: чисте дерево — скрипт працює: мутант вбито, файл відкочено", () => {
    const dir = project({ repo: true });
    const r = run(dir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("KILLED");
    expect(target(dir)).toBe("value = GOOD\n");
  });
});
