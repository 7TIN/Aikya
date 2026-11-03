import { bold, dim, formatBytesDelta, formatNumber, paint } from "../lib/format.ts";
import {
  createBranch,
  deleteBranch,
  listBranches,
} from "./branches.ts";
import { buildBranchReport, type BranchReport } from "./report.ts";

export interface CowCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface CowVerification {
  branch: string;
  parent: string;
  pass: boolean;
  checks: CowCheck[];
  deleted: boolean;
}

export interface VerifyCowOptions {
  parent: string;
  name?: string;
  /** Keep the temporary branch for inspection instead of deleting it. */
  keep?: boolean;
}

/**
 * Create a no-write branch and assert that it behaves like a pure COW clone:
 * same rows/schema/size, zero branch-local writes, zero storage delta.
 *
 * This turns the manual `cow-empty` proof into a repeatable check.
 */
export async function verifyCow(
  options: VerifyCowOptions,
): Promise<CowVerification> {
  const name = options.name ?? `cow-verify-${Date.now().toString(36)}`;
  const branches = await listBranches();

  if (branches.some((branch) => branch.name === name)) {
    throw new Error(
      `Branch "${name}" already exists. Pass --name with a fresh name, or delete it first.`,
    );
  }
  if (!branches.some((branch) => branch.name === options.parent)) {
    throw new Error(
      `Parent branch "${options.parent}" was not found. Run \`bun run branch:list\`.`,
    );
  }

  let deleted = false;
  await createBranch({ name, parent: options.parent });

  let report: BranchReport | undefined;
  try {
    report = await buildBranchReport({
      branch: name,
      parent: options.parent,
    });
  } finally {
    if (!options.keep) {
      await deleteBranch(name);
      deleted = true;
    }
  }

  if (!report) throw new Error("COW verification did not produce a report.");

  const changedTables = report.tables.filter(
    (table) => table.rowDelta !== 0 || table.byteDelta !== 0,
  );
  const writes = report.branchWrites;
  const noWrites =
    writes.inserts === 0 && writes.updates === 0 && writes.deletes === 0;

  const checks: CowCheck[] = [
    {
      name: "branch-local size delta is 0 B",
      pass: report.sizeDeltaBytes === 0,
      detail: formatBytesDelta(report.sizeDeltaBytes),
    },
    {
      name: "row count matches parent",
      pass: report.rowDelta === 0,
      detail: `${formatNumber(report.compare.totalRows)} rows (${formatNumber(report.base.totalRows)} inherited)`,
    },
    {
      name: "no table row/size changes",
      pass: changedTables.length === 0,
      detail:
        changedTables.length === 0
          ? "all tables identical"
          : changedTables.map((table) => table.table).join(", "),
    },
    {
      name: "no branch-local writes",
      pass: noWrites,
      detail: `${formatNumber(writes.inserts)} ins / ${formatNumber(writes.updates)} upd / ${formatNumber(writes.deletes)} del`,
    },
    {
      name: "schema matches parent",
      pass: !report.schemaDiff.hasChanges,
      detail: report.schemaDiff.hasChanges ? "schema differences found" : "no differences",
    },
  ];

  return {
    branch: name,
    parent: options.parent,
    pass: checks.every((check) => check.pass),
    checks,
    deleted,
  };
}

export function printCowVerification(result: CowVerification): void {
  console.log("");
  console.log(bold(paint("cyan", "COW verification")));
  console.log("─".repeat(72));
  console.log(
    `Branch  ${bold(result.branch)} ${dim(`(from ${result.parent})`)}`,
  );
  console.log("");

  for (const check of result.checks) {
    const mark = check.pass ? paint("green", "✔") : paint("red", "✖");
    console.log(`${mark} ${check.name} ${dim(`(${check.detail})`)}`);
  }

  console.log("");
  if (result.pass) {
    console.log(
      paint(
        "green",
        "PASS  the branch inherited its parent's data without copying it.",
      ),
    );
  } else {
    console.log(
      paint(
        "red",
        "FAIL  the branch did not behave like a pure COW clone; inspect the checks above.",
      ),
    );
  }

  console.log(
    dim(
      result.deleted
        ? "Deleted the temporary verification branch."
        : "Temporary verification branch kept in place (--keep).",
    ),
  );
  console.log("");
}
