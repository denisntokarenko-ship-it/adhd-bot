// Розклад оглядів (docs/spec/phase-3.md, S3.1.j–k): `nextDigestAt` — чиста функція, час фіксований (НФ-1, НФ-11).
import { morningMessage } from "../../src/digests/render";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextDigestAt, localDayDiff, type DigestSettings } from "../../src/digests/schedule";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const kyiv: DigestSettings = { tz: "Europe/Kyiv", morning_at: 540, evening_at: 1260, weekly_dow: 7 };

describe("S3.1 nextDigestAt", () => {
  it("3.1.a: пʼятниця 10:15 за Києвом, нічого не відправлено → ранок завтра 09:00, вечір сьогодні 21:00, тиждень — неділя 09:00", () => {
    const now = at("2026-11-20T08:15:00Z");
    expect(iso(nextDigestAt("digest_morning", kyiv, now, null))).toBe("2026-11-21T07:00:00Z");
    expect(iso(nextDigestAt("digest_evening", kyiv, now, null))).toBe("2026-11-20T19:00:00Z");
    expect(iso(nextDigestAt("digest_weekly", kyiv, now, null))).toBe("2026-11-22T07:00:00Z");
  });

  it("3.1.j: межа доби — доба 23 год (весна) і 25 год (осінь): ранок не з'їжджає", () => {
    expect(iso(nextDigestAt("digest_morning", kyiv, at("2026-03-28T22:00:00Z"), null))).toBe("2026-03-29T06:00:00Z"); // 00:00 29.03 → 09:00 EEST
    expect(iso(nextDigestAt("digest_morning", kyiv, at("2026-10-24T21:00:00Z"), null))).toBe("2026-10-25T07:00:00Z"); // 00:00 25.10 → 09:00 EET
  });

  it("3.1.j: неіснуюча хвилина літнього переходу зсувається вперед (03:30 29.03 → 04:30 EEST)", () => {
    const u = { ...kyiv, morning_at: 3 * 60 + 30 };
    expect(iso(nextDigestAt("digest_morning", u, at("2026-03-28T22:00:00Z"), null))).toBe("2026-03-29T01:30:00Z");
  });

  it("3.1.k: ранок 09:00 сьогодні sent, о 09:30 обрано 10:00 → завтра 10:00, не сьогодні (межа доби)", () => {
    const sent = at("2026-11-23T07:00:00Z"); // 09:00 Київ
    const u = { ...kyiv, morning_at: 600 };
    expect(iso(nextDigestAt("digest_morning", u, at("2026-11-23T07:30:00Z"), sent))).toBe("2026-11-24T08:00:00Z");
    // без межі той самий виклик дав би 10:00 сьогодні: межа — те, що її тримає
    expect(iso(nextDigestAt("digest_morning", u, at("2026-11-23T07:30:00Z"), null))).toBe("2026-11-23T08:00:00Z");
  });

  it("3.1.k: вечір — те саме: 21:00 sent, о 21:30 обрано 22:00 → завтра", () => {
    const u = { ...kyiv, evening_at: 22 * 60 };
    expect(iso(nextDigestAt("digest_evening", u, at("2026-11-23T19:30:00Z"), at("2026-11-23T19:00:00Z")))).toBe("2026-11-24T20:00:00Z");
  });

  it("3.1.k: ранок 09:00 Київ sent, о 10:00 за Києвом /tz Europe/Lisbon → 24.11 09:00 Лісабон, не 23.11 11:00 Київ", () => {
    const lisbon = { ...kyiv, tz: "Europe/Lisbon" };
    expect(iso(nextDigestAt("digest_morning", lisbon, at("2026-11-23T08:00:00Z"), at("2026-11-23T07:00:00Z")))).toBe("2026-11-24T09:00:00Z");
  });

  it("3.1.k: тижневий sent у неділю 29.11, того ж дня weekly_dow → понеділок → 07.12, не 30.11", () => {
    const u = { ...kyiv, weekly_dow: 1 };
    expect(iso(nextDigestAt("digest_weekly", u, at("2026-11-29T08:00:00Z"), at("2026-11-29T07:00:00Z")))).toBe("2026-12-07T07:00:00Z");
  });

  it("тиждень: межа — 6 локальних ДАТ (зсув дати, не 6×24 год) через перехід на зимовий час", () => {
    // 18.10 (EEST) → наступна неділя 25.10, 09:00 уже EET (07:00Z)
    expect(iso(nextDigestAt("digest_weekly", kyiv, at("2026-10-18T07:00:00Z"), at("2026-10-18T06:00:00Z")))).toBe("2026-10-25T07:00:00Z");
  });

  it("тихий випадок: тик рівно в мить слота планує наступний, а не той самий слот", () => {
    const slot = at("2026-11-21T07:00:00Z");
    expect(iso(nextDigestAt("digest_morning", kyiv, slot, null))).toBe("2026-11-22T07:00:00Z");
  });

  it("localDayDiff рахує календарні доби за tz, не 24-годинні відрізки", () => {
    expect(localDayDiff("Europe/Kyiv", at("2026-11-20T22:30:00Z"), at("2026-11-21T10:00:00Z"))).toBe(0); // обидва — 21.11
    expect(localDayDiff("Europe/Kyiv", at("2026-11-20T10:00:00Z"), at("2026-11-23T07:00:00Z"))).toBe(3);
  });
});

// Принцип 3 і правило 4: огляди без ШІ й без рутин — структурно, а не лише «мок не покликали».
describe("S3.1.i / правило 4: код оглядів не імпортує ШІ й не читає рутини", () => {
  const dir = new URL("../../src/digests/", import.meta.url);
  const files = [...readdirSync(dir).map((f) => new URL(f, dir)), new URL("../../src/db/digests.ts", import.meta.url)];
  it("жодного імпорту ../ai/*, жодної згадки routines", () => {
    expect(files.length).toBeGreaterThan(4);
    for (const f of files) {
      const code = readFileSync(f, "utf-8").split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith("//")); // коментарі можуть згадувати правило
      const text = code.join(" ");
      expect(text, f.pathname).not.toMatch(/from\s+["'][^"']*\/ai\//);
      expect(text, f.pathname).not.toMatch(/routine/i);
    }
  });
});

describe("НФ-9: довгий перелік обрізається «…ще N» (S3.2.d)", () => {
  it("«показати все» на 300 справах вкладається в 4096 символів, службові рядки лишаються, N = обрізані", () => {
    const tasks = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, title: `Справа ${i + 1} ${"я".repeat(70)}`, due_at: null, all_day: 0, priority: "normal" as const, created_at: i }));
    const m = morningMessage({ head: "Ранок", events: [], tasks, all: true, tz: "Europe/Kyiv", dayStart: 0, dayEnd: 1 });
    expect(m.text.length).toBeLessThanOrEqual(4096);
    const lines = m.text.split("\n");
    expect(lines[0]).toBe("Ранок");
    const shown = lines.filter((l) => l.startsWith("• ")).length;
    expect(lines.at(-1)).toBe(`…ще ${300 - shown}`);
    expect(m.keyboard).toEqual([]);
  });
});
