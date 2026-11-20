import { describe, expect, it } from "vitest";
import { dayBounds } from "../../src/time";

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const bounds = (tz: string, at: string) => dayBounds(tz, Date.parse(at)).map(iso);

describe("dayBounds (НФ-1)", () => {
  it("зима: 22:30Z 20.11 — це вже 21.11 за Києвом", () => {
    expect(bounds("Europe/Kyiv", "2026-11-20T22:30:00Z")).toEqual(["2026-11-20T22:00:00Z", "2026-11-21T22:00:00Z"]);
  });

  it("півдня за Києвом — та сама доба", () => {
    expect(bounds("Europe/Kyiv", "2026-11-20T10:00:00Z")).toEqual(["2026-11-19T22:00:00Z", "2026-11-20T22:00:00Z"]);
  });

  it("початок доби включно: рівно 00:00 за Києвом належить новій добі", () => {
    expect(bounds("Europe/Kyiv", "2026-11-20T22:00:00Z")[0]).toBe("2026-11-20T22:00:00Z");
    expect(bounds("Europe/Kyiv", "2026-11-20T21:59:59Z")[1]).toBe("2026-11-20T22:00:00Z");
  });

  it("весняний перехід 2026-03-29: доба 23 години", () => {
    const [s, e] = dayBounds("Europe/Kyiv", Date.parse("2026-03-29T12:00:00Z"));
    expect([iso(s), iso(e)]).toEqual(["2026-03-28T22:00:00Z", "2026-03-29T21:00:00Z"]);
    expect((e - s) / 3_600_000).toBe(23);
  });

  it("осінній перехід 2026-10-25: доба 25 годин", () => {
    const [s, e] = dayBounds("Europe/Kyiv", Date.parse("2026-10-25T12:00:00Z"));
    expect([iso(s), iso(e)]).toEqual(["2026-10-24T21:00:00Z", "2026-10-25T22:00:00Z"]);
    expect((e - s) / 3_600_000).toBe(25);
  });

  it("інший пояс і межа місяця/року", () => {
    expect(bounds("America/New_York", "2026-12-31T12:00:00Z")).toEqual(["2026-12-31T05:00:00Z", "2027-01-01T05:00:00Z"]);
    expect(bounds("UTC", "2026-12-31T23:59:59Z")).toEqual(["2026-12-31T00:00:00Z", "2027-01-01T00:00:00Z"]);
  });
});
