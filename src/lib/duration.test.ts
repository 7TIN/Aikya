import { describe, expect, test } from "bun:test";
import { formatDuration, parseDuration } from "./duration.ts";

describe("parseDuration", () => {
  test("parses seconds, minutes, hours, and days", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("24h")).toBe(24 * 60 * 60_000);
    expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60_000);
  });

  test("rejects unsupported or empty durations", () => {
    expect(() => parseDuration("7")).toThrow();
    expect(() => parseDuration("1w")).toThrow();
    expect(() => parseDuration("0d")).toThrow();
    expect(() => parseDuration("")).toThrow();
  });
});

describe("formatDuration", () => {
  test("uses the largest useful unit", () => {
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(30 * 60_000)).toBe("30m");
    expect(formatDuration(2 * 60 * 60_000)).toBe("2.0h");
    expect(formatDuration(3 * 24 * 60 * 60_000)).toBe("3.0d");
  });
});
