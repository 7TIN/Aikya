import { bold, dim, paint } from "../lib/format.ts";
import { flagBool, flagString, parseArgs } from "../lib/args.ts";
import { parseDuration } from "../lib/duration.ts";
import { parseRepos } from "../github/client.ts";
import {
  resolveWatchConfig,
  WatchService,
  type WatchConfig,
} from "../github/service.ts";
import type { SyncSummary } from "../github/monitor.ts";

const { flags, positional } = parseArgs(Bun.argv.slice(2));

const loop = flagBool(flags, "loop");
const json = flagBool(flags, "json");
const repoFlag = flagString(flags, "repo") ?? positional[0];

function usage(): never {
  console.error(
    [
      "Usage:",
      "  bun run watch [--repo owner/name] [--once] [--json]",
      "  bun run watch --loop [--interval 120s]",
      "",
      "Options:",
      "  --repo <owner/name>  Repository to watch (default: GITHUB_REPO)",
      "  --loop               Keep polling instead of running once",
      "  --interval <dur>     Poll interval, e.g. 120s (default: GITHUB_POLL_MS or 120s)",
      "  --parent <branch>    Parent branch for previews (default: main)",
      "  --no-tests           Skip tests for each preview branch",
      "  --state <path>       Override artifacts/monitor/state.json",
      "  --json               Machine-readable summaries",
      "",
      "Configuration: GITHUB_REPO, GITHUB_TOKEN (optional), GITHUB_POLL_MS.",
      "The watched repository's code is never executed; migrations come from this project.",
    ].join("\n"),
  );
  process.exit(1);
}

function buildConfig(): WatchConfig {
  const envConfig = resolveWatchConfig();
  const repos = parseRepos(
    repoFlag ?? process.env.GITHUB_REPOS ?? process.env.GITHUB_REPO,
  );
  if (repos.length === 0) usage();

  const interval = flagString(flags, "interval");
  return {
    repos,
    pollMs: interval
      ? parseDuration(interval)
      : (envConfig?.pollMs ?? 120_000),
    watchOnStart: loop,
    parent: flagString(flags, "parent") ?? envConfig?.parent,
    runTests:
      envConfig?.runTests !== false && !flagBool(flags, "no-tests"),
    retryMs: envConfig?.retryMs,
    statePath: flagString(flags, "state") ?? envConfig?.statePath,
  };
}

function printSummaries(summaries: SyncSummary[]): void {
  for (const summary of summaries) {
    console.log("");
    console.log(bold(paint("cyan", `Watched repository · ${summary.repo}`)));
    console.log("─".repeat(72));

    if (summary.error) {
      console.log(paint("red", summary.error));
      continue;
    }

    console.log(
      `Open PRs   ${summary.fetched} fetched${summary.complete ? "" : " (partial page; deletions skipped)"}`,
    );
    console.log(
      `Changes    +${summary.created} created · ~${summary.recreated} recreated · ` +
        `${summary.reopened} reopened · -${summary.deleted} deleted`,
    );
    console.log(
      `Skipped    ${summary.unchanged} unchanged · ${summary.failed} failed`,
    );

    if (summary.pullRequests.length === 0) {
      console.log(dim("\nNo pull requests found."));
      continue;
    }

    console.log("");
    for (const item of summary.pullRequests) {
      const mark =
        item.action === "delete"
          ? paint("green", "🧹")
          : item.status === "failed"
            ? paint("red", "✖")
            : item.action === "skip" || item.action === "retry"
              ? dim("·")
              : paint("green", "✔");
      console.log(
        `${mark} #${item.number} ${item.action} → ${item.status} ` +
          dim(item.branch) +
          (item.error ? `\n    ${paint("red", item.error)}` : ""),
      );
    }
  }
  console.log("");
}

const config = buildConfig();
const service = new WatchService(config);

if (loop) {
  await service.start();
  console.log(dim("\nCtrl+C to stop the watcher."));
} else {
  await service.init();
  const result = await service.syncNow("cli");
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummaries(result.summaries);
  }
  if (result.error || result.summaries.some((summary) => summary.failed > 0)) {
    process.exitCode = 1;
  }
}
