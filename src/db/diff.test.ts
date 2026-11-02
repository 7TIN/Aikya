import { describe, expect, test } from "bun:test";
import { diffSchemas } from "./diff.ts";
import type { SchemaSnapshot } from "./schema-snapshot.ts";

function column(
  name: string,
  dataType = "text",
  nullable = true,
  defaultValue: string | null = null,
) {
  return { name, dataType, nullable, defaultValue };
}

function table(
  name: string,
  columns: ReturnType<typeof column>[],
  indexes: Array<{ name: string; definition: string }> = [],
) {
  return { schema: "public", name, columns, indexes };
}

function snapshot(
  tables: ReturnType<typeof table>[],
  enums: Record<string, string[]> = {},
): SchemaSnapshot {
  return { tables, enums, capturedAt: "2026-01-01T00:00:00.000Z" };
}

describe("diffSchemas", () => {
  test("reports no changes for identical snapshots", () => {
    const base = snapshot([table("orders", [column("id", "uuid", false)])]);
    const diff = diffSchemas(base, base);
    expect(diff.hasChanges).toBe(false);
    expect(diff.tablesAdded).toEqual([]);
  });

  test("detects added tables, columns, and indexes", () => {
    const base = snapshot([table("orders", [column("id", "uuid", false)])]);
    const compare = snapshot([
      table(
        "orders",
        [column("id", "uuid", false), column("coupon_code")],
        [{ name: "orders_coupon_code_idx", definition: "CREATE INDEX ..." }],
      ),
      table("coupons", [column("code", "text", false)]),
    ]);

    const diff = diffSchemas(base, compare);

    expect(diff.hasChanges).toBe(true);
    expect(diff.tablesAdded).toEqual(["coupons"]);
    expect(diff.tablesChanged).toHaveLength(1);
    expect(diff.tablesChanged[0]?.columnsAdded).toEqual(["coupon_code"]);
    expect(diff.tablesChanged[0]?.indexesAdded).toEqual([
      "orders_coupon_code_idx",
    ]);
  });

  test("detects removed tables and changed column properties", () => {
    const base = snapshot([
      table("orders", [column("total_cents", "integer", true)]),
      table("legacy", [column("id", "uuid", false)]),
    ]);
    const compare = snapshot([
      table("orders", [column("total_cents", "bigint", false)]),
    ]);

    const diff = diffSchemas(base, compare);

    expect(diff.tablesRemoved).toEqual(["legacy"]);
    const changed = diff.tablesChanged[0];
    expect(changed?.columnsChanged.map((change) => change.field).sort()).toEqual([
      "nullable",
      "type",
    ]);
  });

  test("detects enum value changes", () => {
    const base = snapshot([], { order_status: ["pending", "paid"] });
    const compare = snapshot([], {
      order_status: ["pending", "paid", "refunded"],
    });

    const diff = diffSchemas(base, compare);

    expect(diff.enumsChanged).toEqual([
      { name: "order_status", added: ["refunded"], removed: [] },
    ]);
  });
});
