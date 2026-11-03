/**
 * Long-lived environment branches introduced in Phase 3.
 *
 * These are intentionally a small, explicit allowlist. `branch:reset` refuses
 * anything outside this list so it can never target main, a preview branch, or
 * an ad-hoc branch by accident. `branch:prune` also treats them as protected.
 */
export const BASELINE_TABLES = [
  "customers",
  "products",
  "orders",
  "order_items",
] as const;

export interface EnvironmentDefinition {
  name: string;
  parent: string;
  description: string;
  /** Tables that must exist and contain rows after a refresh. */
  requiredTables: readonly string[];
}

export const ENVIRONMENTS: readonly EnvironmentDefinition[] = [
  {
    name: "staging",
    parent: "main",
    description: "Production-shaped integration environment",
    requiredTables: BASELINE_TABLES,
  },
  {
    name: "qa",
    parent: "main",
    description: "Seeded regression environment, reset on demand",
    requiredTables: BASELINE_TABLES,
  },
];

export function listEnvironments(): readonly EnvironmentDefinition[] {
  return ENVIRONMENTS;
}

export function environmentNames(): string[] {
  return ENVIRONMENTS.map((environment) => environment.name);
}

export function resolveEnvironment(name: string): EnvironmentDefinition {
  const key = name.trim().toLowerCase();
  const environment = ENVIRONMENTS.find((entry) => entry.name === key);
  if (!environment) {
    throw new Error(
      `Unknown environment "${name}". Known environments: ${environmentNames().join(", ")}. ` +
        "Reset only targets the explicit Phase 3 environment allowlist.",
    );
  }
  return environment;
}
