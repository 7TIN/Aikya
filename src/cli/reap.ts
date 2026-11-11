import { bold, dim, formatDate, paint, renderTable } from "../lib/format.ts";
import { flagBool, flagString, parseArgs } from "../lib/args.ts";
import { formatDuration, parseDuration } from "../lib/duration.ts";
import { environmentNames } from "../env/environments.ts";
import { parentBranchName, type NeonContext } from "../neon/cli.ts";
import { runReaper } from "../neon/reaper.ts";
import {
  loadRepoRegistry,
  requireSubjectRepo,
  resolveSubjectNeonContext,
} from "../preview/registry.ts";

const { flags } = parseArgs(Bun.argv.slice(2));
const json = flagBool(flags, "json");
const dryRun = !flagBool(flags, "yes") || flagBool(flags, "dry-run");
const olderThanText = flagString(flags, "older-than") ?? "7d";
const olderThanMs = parseDuration(olderThanText);
const prefix = flagString(flags, "prefix");
const parent = flagString(flags, "parent") ?? parentBranchName();
const repo = flagString(flags, "repo");

let context: NeonContext | undefined;

if (repo) {
  try {
    const registry = await loadRepoRegistry();
    for (const warning of registry.warnings) {
      console.warn(`[registry] ${warning}`);
    }
    context = resolveSubjectNeonContext(requireSubjectRepo(registry, repo));
  } catch (error) {
    console.error("");
    console.error(paint("red", error instanceof Error ? error.message : String(error)));
    console.error("");
    process.exit(1);
  }
}

const report = await runReaper({
  context,
  repo,
  prefix,
  olderThanMs,
  parentName: parent,
  protectedNames: environmentNames(),
  dryRun,
});

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("");
  console.log(bold(paint("cyan", "Preview reaper")));
  console.log("─".repeat(96));
  console.log(
    `Target      ${repo ?? "Aikya project"}` +
      ` · prefix ${bold(report.prefix)}` +
      ` · older than ${bold(olderThanText)}` +
      ` · parent ${bold(parent)}`,
  );
  console.log(`Mode        ${report.mode}`);

  if (report.candidates.length === 0) {
    console.log("");
    console.log(dim("No branches match the retention policy."));
  } else {
    console.log("");
    console.log(
      renderTable(
        ["branch", "created", "age", "expires", "reason"],
        report.candidates.map((candidate) => [
          candidate.name,
          formatDate(candidate.createdAt),
          formatDuration(candidate.ageMs),
          candidate.expiresAt ? formatDate(candidate.expiresAt) : "—",
          candidate.reason,
        ]),
      ),
    );

    if (report.mode === "dry-run") {
      console.log(
        dim(
          "\nDry run: nothing was deleted. Re-run with --yes to delete these branches.",
        ),
      );
    } else {
      console.log(
        `\n✔ Deleted ${report.deleted.length} branch${report.deleted.length === 1 ? "" : "es"}.`,
      );
    }
  }

  if (report.failed.length > 0) {
    console.log("");
    for (const failure of report.failed) {
      console.error(paint("red", `✖ ${failure.branch}: ${failure.error}`));
    }
  }

  console.log(dim(`\nLogged reap.completed (${report.durationMs} ms).`));
  console.log("");
}

if (report.failed.length > 0) process.exitCode = 1;
