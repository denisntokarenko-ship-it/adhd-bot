#!/usr/bin/env python3
"""Прицільні мутанти: підмінити фрагмент → прогнати тести → відкотити.

    python mutate.py mutants.toml [--root .] [--only M1,M3] [--report docs/.../mutants.md]
    python mutate.py --recover [--root .]

Гарантії — кожна закриває провал, що вже траплявся:
- (S0.8.b, правило 9) робоче дерево git має бути чистим: `git status --porcelain` непорожній (або
  це не git-репозиторій) → вихід 2 до будь-якого запису. Мутант підміняє файл, а відкат — це
  відновлення збереженого оригіналу: якщо в файлі були незакомічені правки, мутант і відкат їх
  зносять. Обійти нічим: прапорця «дозволити брудне» немає навмисно;
- `old` знайдено РІВНО один раз, інакше стоп до будь-якого прогону: мутант, що не
  застосувався (sed не зловив рядок із табом), дає фальшиве «passed»;
- базовий прогін на незміненому коді має бути зеленим, інакше «вбиті» всі мутанти;
- оригінал копіюється в .mutate-backup/ ДО мутації, відкат у finally зі звіркою байтів;
  якщо процес убили посеред мутанта — наступний запуск відмовить, `--recover` поверне файл;
- PYTHONDONTWRITEBYTECODE=1 і видалення .pyc мутованого файлу перед кожним прогоном:
  старий .pyc того ж розміру й mtime виконується замість мутанта;
- `match` (regex): мутант рахується вбитим, лише якщо цей текст є у виводі тестів —
  SyntaxError чи ImportError «вбиває» будь-який тест, але нічого не доводить;
- TIMEOUT вбитим не рахується: це питання до людини, а не доказ.

Коди виходу: 0 — усе як в `expect`; 1 — є розбіжності; 2 — помилка налаштування.

Формат mutants.toml:

    test = "python -m pytest -q tests/test_risk.py"   # команда за замовчуванням, з --root
    timeout = 600                                     # секунд на прогін, за замовчуванням 600

    [[mutant]]
    id = "M1"
    file = "src/risk.py"
    old = '''if d <= 0:'''
    new = '''if False:'''
    why = "прибрати захист від нульової відстані до стопу"
    match = "test_zero_stop"      # необовʼязково
    expect = "killed"             # або "survived" — задокументований еквівалентний мутант
    # test = "..."                # необовʼязково: своя команда для цього мутанта
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
from pathlib import Path

BACKUP_DIR = ".mutate-backup"


class SetupError(Exception):
    pass


def load(path, only):
    with open(path, "rb") as f:
        cfg = tomllib.load(f)
    muts = cfg.get("mutant", [])
    if not muts:
        raise SetupError(f"{path}: немає жодного [[mutant]]")
    seen = set()
    for m in muts:
        for k in ("id", "file", "old", "new"):
            if k not in m:
                raise SetupError(f"мутант {m.get('id', '?')}: немає поля «{k}»")
        if m["id"] in seen:
            raise SetupError(f"повторний id {m['id']}")
        seen.add(m["id"])
        m.setdefault("test", cfg.get("test"))
        if not m["test"]:
            raise SetupError(f"{m['id']}: немає команди test — ні в мутанті, ні вгорі файлу")
        m.setdefault("timeout", cfg.get("timeout", 600))
        m.setdefault("expect", "killed")
        if m["expect"] not in ("killed", "survived"):
            raise SetupError(f"{m['id']}: expect має бути killed або survived, а не {m['expect']!r}")
    if only:
        wanted = [x.strip() for x in only.split(",") if x.strip()]
        unknown = [x for x in wanted if x not in seen]
        if unknown:
            raise SetupError(f"--only: немає мутантів {', '.join(unknown)}")
        muts = [m for m in muts if m["id"] in wanted]
    return muts


def hint(data, old):
    first = next((ln.strip() for ln in old.splitlines() if ln.strip()), "")
    squash = lambda s: re.sub(r"\s+", "", s)
    lines = data.decode("utf-8", "replace").splitlines()
    near = [i for i, ln in enumerate(lines, 1) if first and squash(first) in squash(ln)]
    if near:
        return f" Схожий рядок: {', '.join(map(str, near[:5]))} — звір пробіли, таби й лапки."
    return " Схожих рядків немає — можливо, код уже змінився."


def prepare(m, root):
    path = (root / m["file"]).resolve()
    if not path.is_file():
        raise SetupError(f"{m['id']}: файлу немає: {path}")
    data = path.read_bytes()
    old, new = m["old"], m["new"]
    if b"\r\n" in data and "\n" in old and "\r\n" not in old:
        old, new = old.replace("\n", "\r\n"), new.replace("\n", "\r\n")
    ob, nb = old.encode(), new.encode()
    if ob == nb:
        raise SetupError(f"{m['id']}: old і new однакові — це не мутант")
    n = data.count(ob)
    if n == 0:
        raise SetupError(f"{m['id']}: `old` не знайдено в {m['file']}." + hint(data, old))
    if n > 1:
        raise SetupError(f"{m['id']}: `old` знайдено {n} рази в {m['file']}, треба рівно 1 — "
                         "додай навколишній рядок, щоб фрагмент став унікальним.")
    return path, data, data.replace(ob, nb, 1)


def dirty_tree(root):
    """Причина, чому дерево не можна мутувати, або None, якщо воно чисте. Fail-closed: не вийшло
    спитати git (немає git, не репозиторій) — теж відмова, а не «мабуть, чисто»."""
    try:
        p = subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
    except OSError as e:
        return f"не вдалося запустити git: {e}"
    if p.returncode != 0:
        return f"git status завершився з кодом {p.returncode}: {p.stderr.strip()}"
    lines = [ln for ln in p.stdout.splitlines() if ln.strip()]
    if lines:
        return "незакомічені зміни (" + ", ".join(ln.strip() for ln in lines[:5]) + (" …" if len(lines) > 5 else "") + ")"
    return None


def purge_pyc(path):
    if path.suffix == ".py":
        for p in (path.parent / "__pycache__").glob(f"{path.stem}.*.pyc"):
            p.unlink(missing_ok=True)


def kill_tree(p):
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
    else:
        import signal
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run(cmd, root, timeout, log_path):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    kw = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
          else {"start_new_session": True})
    t0 = time.monotonic()
    p = subprocess.Popen(cmd, shell=True, cwd=root, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kw)
    try:
        out, _ = p.communicate(timeout=timeout)
        code = p.returncode
    except subprocess.TimeoutExpired:
        kill_tree(p)
        out, _ = p.communicate()
        code = None
    except BaseException:
        kill_tree(p)
        raise
    text = out.decode("utf-8", "replace")
    log_path.write_text(text, encoding="utf-8")
    return code, text, time.monotonic() - t0


def backup(root, path, original):
    d = root / BACKUP_DIR
    d.mkdir()
    (d / "original").write_bytes(original)
    (d / "journal.json").write_text(json.dumps({"file": str(path)}), encoding="utf-8")


def restore(root, path, original):
    path.write_bytes(original)
    purge_pyc(path)
    if path.read_bytes() != original:
        raise RuntimeError(f"ВІДКАТ НЕ ВДАВСЯ: {path} ≠ оригінал; копія лишилась у {root / BACKUP_DIR}")
    shutil.rmtree(root / BACKUP_DIR)


def recover(root):
    d = root / BACKUP_DIR
    if not d.exists():
        print("Нема чого відновлювати.")
        return 0
    journal, orig = d / "journal.json", d / "original"
    if not (journal.exists() and orig.exists()):
        shutil.rmtree(d)  # упав до запису мутанта — файл не чіпали
        print("Незавершена копія прибрана; вихідний файл не змінювався.")
        return 0
    path = Path(json.loads(journal.read_text(encoding="utf-8"))["file"])
    restore(root, path, orig.read_bytes())
    print(f"Відновлено: {path}")
    return 0


def classify(code, text, match):
    if code is None:
        return "TIMEOUT"
    if code == 0:
        return "SURVIVED"
    if match and not re.search(match, text):
        return "WRONG-KILL"
    return "KILLED"


def render(rows, logs):
    cell = lambda s: str(s).replace("|", "\\|").replace("\n", " ")
    out = ["| id | файл | що ламає | очікування | результат | |", "|---|---|---|---|---|---|"]
    for r in rows:
        out.append(f"| {r['id']} | `{cell(r['file'])}` | {cell(r['why'])} | {r['expect']} "
                   f"| {r['result']} ({r['dt']:.1f} с) | {'✅' if r['ok'] else '❌'} |")
    good = sum(r["ok"] for r in rows)
    out += ["", f"Підсумок: {good}/{len(rows)} як очікувалось. Логи: `{logs}`",
            "WRONG-KILL — тести впали, але у виводі немає `match` (впало не те). "
            "TIMEOUT вбитим не рахується."]
    return "\n".join(out)


def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Прицільні мутанти з гарантованим відкатом.")
    ap.add_argument("mutants", nargs="?", help="TOML зі списком [[mutant]]")
    ap.add_argument("--root", default=".", help="корінь проєкту: звідси шляхи file і запуск test")
    ap.add_argument("--only", help="лише ці id через кому")
    ap.add_argument("--report", help="записати таблицю в markdown-файл")
    ap.add_argument("--logs", help="тека для логів прогонів (за замовчуванням — тимчасова)")
    ap.add_argument("--recover", action="store_true", help="повернути файл після аварійного виходу")
    args = ap.parse_args(argv)
    root = Path(args.root).resolve()

    if args.recover:
        return recover(root)
    if not args.mutants:
        ap.error("потрібен файл мутантів")
    reason = dirty_tree(root)
    if reason:
        print(f"ПОМИЛКА: дерево не чисте — {reason}. Закоміть зміни й запусти знову: "
              "мутант і його відкат зносять незакомічене (правило 9). Нічого не змінено.")
        return 2
    if (root / BACKUP_DIR).exists():
        print(f"ПОМИЛКА: є {BACKUP_DIR}/ — попередній прогін упав посеред мутанта. "
              f"Спершу: python {Path(__file__).name} --recover --root {root}")
        return 2
    try:
        muts = load(args.mutants, args.only)
        prepared = [(m, *prepare(m, root)) for m in muts]  # усе перевірено до першого прогону
    except (SetupError, tomllib.TOMLDecodeError) as e:
        print(f"ПОМИЛКА НАЛАШТУВАННЯ: {e}")
        return 2

    logs = Path(args.logs).resolve() if args.logs else Path(tempfile.mkdtemp(prefix="mutate-"))
    logs.mkdir(parents=True, exist_ok=True)

    for i, cmd in enumerate(dict.fromkeys(m["test"] for m in muts)):
        for _, path, _, _ in prepared:
            purge_pyc(path)
        timeout = max(m["timeout"] for m in muts if m["test"] == cmd)
        log = logs / f"baseline-{i}.log"
        code, _, _ = run(cmd, root, timeout, log)
        if code != 0:
            why = "таймаут" if code is None else f"код {code}"
            print(f"ПОМИЛКА: базовий прогін на незміненому коді червоний ({why}): `{cmd}`. Лог: {log}\n"
                  "Поки тести не зелені на оригіналі, «вбитий мутант» нічого не означає.")
            return 2

    rows = []
    for m, path, original, mutated in prepared:
        backup(root, path, original)
        try:
            path.write_bytes(mutated)
            purge_pyc(path)
            if path.read_bytes() != mutated:
                raise RuntimeError(f"{m['id']}: мутант не записався в {path}")
            code, text, dt = run(m["test"], root, m["timeout"], logs / f"{m['id']}.log")
        finally:
            restore(root, path, original)
        result = classify(code, text, m.get("match"))
        ok = result == ("KILLED" if m["expect"] == "killed" else "SURVIVED")
        rows.append({"id": m["id"], "file": m["file"], "why": m.get("why", ""),
                     "expect": m["expect"], "result": result, "dt": dt, "ok": ok})
        print(f"{'✅' if ok else '❌'} {m['id']}: {result} (очікувалось {m['expect']})", flush=True)

    report = render(rows, logs)
    print("\n" + report)
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(report + "\n", encoding="utf-8")
    return 0 if all(r["ok"] for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
