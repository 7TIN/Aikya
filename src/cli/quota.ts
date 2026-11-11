import { flagBool, flagString, parseArgs } from "../lib/args.ts";
import { bold, dim, paint } from "../lib/format.ts";
import { formatQuotaUsage } from "../preview/quota.ts";
import { collectQuotaStatuses } from "../preview/quota-status.ts";

/**
 * Show current guardrail usage against the limits for each watched repo.
 * Read-only: it lists branches and reads the event log, nothing else.
 */

const { flags } = parseArgs(Bun.argv.slice(2));
const json = flagBool(flags, "json");
const repo = flagString(flags, "repo");

const report = await collectQuotaStatuses({ repo });

for (const warning of report.warnings) {
  console.warn(`[registry] ${warning}`);
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.repos.some((entry) => entry.error) ? 1 : 0;
} else {
  console.log("");
  console.log(bold(paint("cyan", "Preview quotas")));
  console.log("─".repeat(72));

  if (report.repos.length === 0) {
    console.log(dim("No repositories registered in config/repos.json."));
  }

  for (const entry of report.repos) {
    console.log("");
    console.log(`${bold(entry.repo)} ${dim(`(${entry.projectId})`)}`);

    if (entry.error || !entry.decision) {
      console.log(paint("red", `  unavailable: ${entry.error ?? "no quota decision"}`));
      continue;
    }

    const decision = entry.decision;
    const mark = decision.allowed ? paint("green", "✔ within limits") : paint("red", "✖ over quota");
    console.log(`  ${mark}`);
    console.log(dim(`  ${formatQuotaUsage(decision)}`));

    for (const violation of decision.violations) {
      console.log(`  ${paint("red", "·")} ${violation.message}`);
    }
  }

  console.log("");
  console.log(
    dim(
      "Limits: registry quota → AIKYA_QUOTA_* env → built-in defaults. " +
        "Refusals do not delete an existing preview branch.",
    ),
  );
  console.log("");

  process.exitCode = report.repos.some(
    (entry) => entry.error || (entry.decision && !entry.decision.allowed),
  )
    ? 1
    : 0;
}
