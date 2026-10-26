import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getDefaultSlateDate,
  sanitizeDateStrings,
} from "../morning/espnSlate.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("default slate date (America/Chicago, next day from 10 PM CT)", () => {
  it("before 10 PM CT is today's CT date", () => {
    expect(getDefaultSlateDate(new Date("2026-10-26T02:59:00Z"))).toBe(
      "2026-10-25",
    ); // 9:59 PM CDT Oct 25
    expect(getDefaultSlateDate(new Date("2026-10-26T15:00:00Z"))).toBe(
      "2026-10-26",
    ); // 10 AM CDT
  });

  it("from 10 PM CT it is tomorrow, including across month/year ends and in CST", () => {
    expect(getDefaultSlateDate(new Date("2026-10-26T03:00:00Z"))).toBe(
      "2026-10-26",
    ); // 10:00 PM CDT Oct 25
    expect(getDefaultSlateDate(new Date("2026-11-01T04:30:00Z"))).toBe(
      "2026-11-01",
    ); // 11:30 PM CDT Oct 31
    expect(getDefaultSlateDate(new Date("2027-01-01T04:00:00Z"))).toBe(
      "2027-01-01",
    ); // 10 PM CST Dec 31
    expect(getDefaultSlateDate(new Date("2026-12-01T03:59:00Z"))).toBe(
      "2026-11-30",
    ); // 9:59 PM CST Nov 30
  });

  it("sanitizeDateStrings() with no input uses the pinned clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T03:20:00Z")); // 10:20 PM CDT Oct 25
    expect(sanitizeDateStrings()).toEqual({
      gameDate: "2026-10-26",
      espnDate: "20261026",
    });
    expect(sanitizeDateStrings("2026-10-25").gameDate).toBe("2026-10-25");
  });
});
