import { describe, expect, test } from "bun:test";
import {
  BASELINE_TABLES,
  ENVIRONMENTS,
  environmentNames,
  resolveEnvironment,
} from "./environments.ts";

describe("environments", () => {
  test("defines staging and qa on main with baseline tables", () => {
    expect(environmentNames()).toEqual(["staging", "qa"]);
    for (const environment of ENVIRONMENTS) {
      expect(environment.parent).toBe("main");
      expect(environment.requiredTables).toEqual([...BASELINE_TABLES]);
    }
  });

  test("resolves names case-insensitively", () => {
    expect(resolveEnvironment("staging").name).toBe("staging");
    expect(resolveEnvironment(" QA ").name).toBe("qa");
  });

  test("refuses main and arbitrary branches", () => {
    expect(() => resolveEnvironment("main")).toThrow();
    expect(() => resolveEnvironment("preview/pr-1")).toThrow();
    expect(() => resolveEnvironment("demo-coupons")).toThrow();
  });
});
