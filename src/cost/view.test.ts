import { describe, expect, test } from "bun:test";
import {
  buildCostView,
  computeBranchCosts,
  computeSandboxCost,
  costRatesFromEnv,
  DEFAULT_COST_RATES,
} from "./view.ts";
import type { NeonBranch } from "../neon/branches.ts";
import type { AikyaEvent } from "../events/log.ts";

function branch(overrides: Partial<NeonBranch> = {}): NeonBranch {
  return {
    id: "br-1",
    name: "main",
    projectId: "proj",
    default: true,
    primary: true,
    protected: true,
    currentState: "ready",
    stateChangedAt: "",
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    logicalSize: 40_000_000,
    writtenDataBytes: 0,
    cpuUsedSec: 3_600,
    computeTimeSeconds: 7_200,
    ...overrides,
  };
}

function event(overrides: Partial<AikyaEvent> = {}): AikyaEvent {
  return {
    id: "1",
    type: "review.completed",
    at: "2026-11-10T00:00:00.000Z",
    status: "ok",
    durationMs: 60_000,
    ...overrides,
  };
}

describe("costRatesFromEnv", () => {
  test("uses defaults when no env is set", () => {
    const { rates, fromEnv } = costRatesFromEnv({});
    expect(rates).toEqual(DEFAULT_COST_RATES);
    expect(fromEnv).toBe(false);
  });

  test("overrides individual rates from env", () => {
    const { rates, fromEnv } = costRatesFromEnv({
      AIKYA_COST_STORAGE_PER_GB_HOUR_USD: "0.001",
      AIKYA_COST_SANDBOX_PER_HOUR_USD: "0.1",
    });
    expect(rates.storagePerGbHourUsd).toBe(0.001);
    expect(rates.sandboxPerHourUsd).toBe(0.1);
    expect(fromEnv).toBe(true);
  });

  test("ignores invalid values", () => {
    const { rates, fromEnv } = costRatesFromEnv({
      AIKYA_COST_COMPUTE_PER_CU_HOUR_USD: "not-a-number",
      AIKYA_COST_STORAGE_PER_GB_HOUR_USD: "-1",
    });
    expect(rates.computePerCuHourUsd).toBe(DEFAULT_COST_RATES.computePerCuHourUsd);
    expect(rates.storagePerGbHourUsd).toBe(DEFAULT_COST_RATES.storagePerGbHourUsd);
    expect(fromEnv).toBe(false);
  });
});

describe("computeBranchCosts", () => {
  test("bills a root branch on full logical size", () => {
    const now = Date.parse("2026-11-10T00:00:00.000Z");
    const costs = computeBranchCosts(
      [branch({ createdAt: "2026-11-09T00:00:00.000Z", logicalSize: 1_000_000_000 })],
      DEFAULT_COST_RATES,
      now,
    );
    expect(costs).toHaveLength(1);
    expect(costs[0]?.estimatedStorageBytes).toBe(1_000_000_000);
    expect(costs[0]?.ageHours).toBe(24);
    expect(costs[0]?.storageCostUsd).toBeGreaterThan(0);
    expect(costs[0]?.computeCostUsd).toBeGreaterThan(0);
  });

  test("bills a child branch on the delta capped at logical size", () => {
    const now = Date.parse("2026-11-10T00:00:00.000Z");
    const parent = branch({ id: "br-0", name: "main", logicalSize: 40_000_000 });
    const child = branch({
      id: "br-1",
      name: "preview/pr-1",
      parentId: "br-0",
      parentName: "main",
      logicalSize: 40_000_100,
      createdAt: "2026-11-09T00:00:00.000Z",
    });
    const costs = computeBranchCosts([parent, child], DEFAULT_COST_RATES, now);
    expect(costs[1]?.estimatedStorageBytes).toBe(100);
  });

  test("caps a negative delta at zero", () => {
    const now = Date.parse("2026-11-10T00:00:00.000Z");
    const parent = branch({ id: "br-0", name: "main", logicalSize: 40_000_000 });
    const child = branch({
      id: "br-1",
      name: "preview/pr-1",
      parentId: "br-0",
      parentName: "main",
      logicalSize: 40_000_000,
      createdAt: "2026-11-09T00:00:00.000Z",
    });
    const costs = computeBranchCosts([parent, child], DEFAULT_COST_RATES, now);
    expect(costs[1]?.estimatedStorageBytes).toBe(0);
  });
});

describe("computeSandboxCost", () => {
  test("sums reviewer durations for successful runs", () => {
    const events = [
      event({ type: "review.completed", status: "ok", durationMs: 3_600_000 }),
      event({ type: "review.completed", status: "failed", durationMs: 1_000_000 }),
      event({ type: "review.completed", status: "ok", durationMs: 1_800_000 }),
      event({ type: "sync.started" }),
    ];
    const { sandboxUsd, sandboxSeconds } = computeSandboxCost(events, DEFAULT_COST_RATES);
    expect(sandboxSeconds).toBe(5400);
    expect(sandboxUsd).toBeGreaterThan(0);
  });

  test("returns zero when there are no reviewer events", () => {
    const { sandboxUsd, sandboxSeconds } = computeSandboxCost([], DEFAULT_COST_RATES);
    expect(sandboxUsd).toBe(0);
    expect(sandboxSeconds).toBe(0);
  });
});

describe("buildCostView", () => {
  test("sums storage, compute, and sandbox costs", () => {
    const now = Date.parse("2026-11-10T00:00:00.000Z");
    const branches = [branch({ createdAt: "2026-11-09T00:00:00.000Z", logicalSize: 1_000_000_000 })];
    const events = [event({ type: "review.completed", status: "ok", durationMs: 3_600_000 })];
    const view = buildCostView({ branches, events, now });

    expect(view.totalUsd).toBeGreaterThan(0);
    expect(view.totalUsd).toBeCloseTo(view.storageUsd + view.computeUsd + view.sandboxUsd, 6);
    expect(view.branches).toHaveLength(1);
    expect(view.generatedAt).toBe(new Date(now).toISOString());
    expect(view.sandboxSeconds).toBe(3600);
  });
});
