import { describe, expect, test } from "bun:test";
import { evaluateSmoke, type SmokeInput } from "./smoke.ts";

function input(overrides: Partial<SmokeInput> = {}): SmokeInput {
  return {
    requiredTables: ["customers", "orders"],
    tables: ["customers", "orders", "products"],
    rowCounts: { customers: 2, orders: 3 },
    migrationCount: 1,
    writeOk: true,
    ...overrides,
  };
}

function failedNames(checks: ReturnType<typeof evaluateSmoke>): string[] {
  return checks.filter((check) => !check.pass).map((check) => check.name);
}

describe("evaluateSmoke", () => {
  test("passes for a migrated, populated, writable branch", () => {
    const checks = evaluateSmoke(input());
    expect(failedNames(checks)).toEqual([]);
    expect(checks.every((check) => check.pass)).toBe(true);
  });

  test("fails when a required table is missing", () => {
    const checks = evaluateSmoke(
      input({ tables: ["customers"], rowCounts: { customers: 2 } }),
    );
    expect(failedNames(checks)).toContain("required tables present");
    expect(failedNames(checks)).toContain("baseline tables contain rows");
  });

  test("fails when a baseline table is empty", () => {
    const checks = evaluateSmoke(
      input({ rowCounts: { customers: 2, orders: 0 } }),
    );
    expect(failedNames(checks)).toEqual(["baseline tables contain rows"]);
  });

  test("fails when migrations are not recorded", () => {
    const checks = evaluateSmoke(input({ migrationCount: 0 }));
    expect(failedNames(checks)).toEqual(["migrations recorded"]);
  });

  test("fails when the write probe fails", () => {
    const checks = evaluateSmoke(
      input({ writeOk: false, writeDetail: "permission denied" }),
    );
    const write = checks.find((check) => check.name === "write probe rolled back");
    expect(write?.pass).toBe(false);
    expect(write?.detail).toBe("permission denied");
  });
});
