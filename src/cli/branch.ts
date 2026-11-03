import {
  bold,
  dim,
  formatBytes,
  formatBytesDelta,
  formatDate,
  paint,
  renderTable,
} from "../lib/format.ts";
import { flagBool, flagString, parseArgs } from "../lib/args.ts";
import {
  branchConnectionString,
  createBranch,
  deleteBranch,
  listBranches,
  neonSchemaDiff,
} from "../neon/branches.ts";
import { parentBranchName } from "../neon/cli.ts";
import { buildBranchReport, printBranchReport } from "../neon/report.ts";

function fail(error: unknown): never {
  console.error("");
  console.error(paint("red", error instanceof Error ? error.message : String(error)));
  console.error("");
  process.exit(1);
}

const { flags, positional } = parseArgs(Bun.argv.slice(2));
const command = positional[0];
const json = flagBool(flags, "json");

async function main(): Promise<void> {
  switch (command) {
    case "list": {
      const branches = await listBranches();

      if (json) {
        console.log(JSON.stringify(branches, null, 2));
        return;
      }

      const byId = new Map(branches.map((branch) => [branch.id, branch]));

      console.log("");
      console.log(bold(paint("cyan", "Neon branches")));
      console.log("─".repeat(112));
      console.log(
        renderTable(
          ["name", "state", "default", "logical size", "Δ parent", "Neon writes", "created"],
          branches.map((branch) => {
            const parent = branch.parentId ? byId.get(branch.parentId) : undefined;
            const delta =
              parent &&
              parent.logicalSize > 0 &&
              branch.logicalSize > 0
                ? branch.logicalSize - parent.logicalSize
                : undefined;
            return [
              `${branch.name}${branch.default ? " *" : ""}`,
              branch.currentState,
              branch.default ? "yes" : "",
              branch.logicalSize > 0 ? formatBytes(branch.logicalSize) : "n/a",
              delta === undefined ? "—" : formatBytesDelta(delta),
              formatBytes(branch.writtenDataBytes),
              formatDate(branch.createdAt),
            ];
          }),
        ),
      );
      console.log(
        dim(
          "\nlogical size = Neon branch size including inherited pages (all databases).\n" +
            "Δ parent      = branch-local growth since creation, not the full database copy.\n" +
            "Neon writes   = written_data_bytes for this billing period; 0 B can mean lag/unreported.\n" +
            "Use `bun run branch:report <branch>` for the size delta and write activity.",
        ),
      );
      console.log("");
      return;
    }

    case "create": {
      const name = flagString(flags, "name") ?? positional[1];
      if (!name) {
        console.error("Usage: bun run branch:create --name <branch> [--parent main] [--expires-at ISO]");
        process.exit(1);
      }

      const parent = flagString(flags, "parent") ?? parentBranchName();
      const expiresAt = flagString(flags, "expires-at");

      console.log(`Creating branch "${name}" from "${parent}"...`);
      const branch = await createBranch({ name, parent, expiresAt });

      console.log("");
      console.log(paint("green", `✔ Branch ${branch.name} is ${branch.currentState}`));
      console.log(`  id        ${branch.id}`);
      console.log(`  parent    ${parent}`);
      console.log(`  created   ${formatDate(branch.createdAt)}`);
      if (branch.writtenDataBytes > 0) {
        console.log(`  writes    ${formatBytes(branch.writtenDataBytes)}`);
      }

      const url = await branchConnectionString(branch.name, { pooled: true });
      const redacted = url.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/, "$1••••@");
      console.log(`  url       ${redacted}`);
      return;
    }

    case "delete": {
      const name = flagString(flags, "name") ?? positional[1];
      if (!name) {
        console.error("Usage: bun run branch:delete <branch> --yes");
        process.exit(1);
      }
      if (!flagBool(flags, "yes")) {
        console.error(`Refusing to delete "${name}" without --yes.`);
        process.exit(1);
      }
      await deleteBranch(name);
      console.log(paint("green", `✔ Deleted branch ${name}`));
      return;
    }

    case "report": {
      const branch = flagString(flags, "branch") ?? positional[1];
      const parent = flagString(flags, "parent") ?? parentBranchName();
      const baseUrl = flagString(flags, "base-url");
      const branchUrl = flagString(flags, "branch-url");

      if (!branch && !(baseUrl && branchUrl)) {
        console.error(
          "Usage: bun run branch:report <branch> [--parent main]\n" +
            "   or: bun run branch:report --base-url <url> --branch-url <url>",
        );
        process.exit(1);
      }

      const report = await buildBranchReport({
        branch,
        parent,
        baseUrl,
        branchUrl,
        neonDiff: flagBool(flags, "neon-diff"),
      });

      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printBranchReport(report);
      }
      return;
    }

    case "diff": {
      const base = positional[1];
      const compare = positional[2];
      if (!base || !compare) {
        console.error("Usage: bun run branch:diff <base-branch> <compare-branch>");
        process.exit(1);
      }
      const diff = await neonSchemaDiff(base, compare);
      console.log(diff ?? "No schema differences (or the diff is unavailable).");
      return;
    }

    default: {
      console.error(
        [
          "Usage: bun run branch:<command> [args]",
          "",
          "  list                                  List branches, logical size, delta vs parent",
          "  create --name <branch>                Create a branch",
          "  delete <branch> --yes                 Delete a branch",
          "  report <branch> [--parent main]       Storage + schema comparison",
          "  report --base-url U --branch-url U    Compare two arbitrary databases",
          "  diff <base> <compare>                 Neon schema-diff",
          "",
          "Add --json to list/report for machine-readable output.",
        ].join("\n"),
      );
      process.exit(1);
    }
  }
}

main().catch(fail);
