import { environmentNames } from "../env/environments.ts";
import type { NeonBranch } from "./branches.ts";
import { parentBranchName } from "./cli.ts";

type BranchGuardFields = Pick<
  NeonBranch,
  "name" | "default" | "primary" | "protected"
>;

/**
 * Branches the dashboard and `DELETE /api/branches` must never delete.
 *
 * The CLI can still delete an environment branch with an explicit `--yes`;
 * that path is intentionally operator-only. The dashboard is one click away
 * from the wrong row, so it refuses default/primary/protected branches, the
 * configured parent, and the persistent staging/qa environments.
 */
export function branchDeleteBlockedReason(
  branch: BranchGuardFields,
): string | null {
  if (branch.default) return "the default branch";
  if (branch.primary) return "the primary branch";
  if (branch.protected) return "a Neon-protected branch";
  if (branch.name === "main") return "the main branch";
  if (branch.name === parentBranchName()) return "the configured parent branch";
  if (environmentNames().includes(branch.name)) {
    return "a persistent environment branch";
  }
  return null;
}
