import { flagBool, flagString, parseArgs } from "../lib/args.ts";
import { printPreviewResult, runPreview } from "../ci/preview.ts";
import { parsePullRequestNumber } from "../ci/events.ts";

const { flags, positional } = parseArgs(Bun.argv.slice(2));
const command = positional[0];

function usage(): never {
  console.error(
    [
      "Usage:",
      "  bun run ci:preview --pr <number> [--event opened|synchronize|reopened|closed]",
      "  bun run ci:cleanup --pr <number>",
      "",
      "Options:",
      "  --pr <number>        Pull request number (required)",
      "  --event <event>      Defaults to opened; cleanup defaults to closed",
      "  --parent <branch>    Parent branch (default: NEON_PARENT_BRANCH or main)",
      "  --name <branch>      Branch name override (sanitized)",
      "  --expires-in <dur>   Branch lifetime, default 7d (30s/30m/24h/7d)",
      "  --reset              Drop + migrate + seed instead of inherit + migrate",
      "  --fork               Simulate a fork PR (skips preview, no secrets used)",
      "  --no-tests           Skip the test step",
      "  --artifacts-dir <p>  Override the artifact directory",
      "  --json               Machine-readable result",
      "",
      "Exit code is non-zero when the preview fails.",
    ].join("\n"),
  );
  process.exit(1);
}

if (!command || !["preview", "cleanup"].includes(command)) {
  usage();
}

const prText = flagString(flags, "pr") ?? positional[1];
if (!prText) usage();

const pr = parsePullRequestNumber(prText);
const event =
  flagString(flags, "event") ?? (command === "cleanup" ? "closed" : "opened");

const json = flagBool(flags, "json");
const expiresIn = flagString(flags, "expires-in");
const parent = flagString(flags, "parent");
const name = flagString(flags, "name");
const artifactsDir = flagString(flags, "artifacts-dir");
const reset = flagBool(flags, "reset");
const fork = flagBool(flags, "fork");
const runTests = !flagBool(flags, "no-tests");

const result = await runPreview({
  pr,
  event,
  parent,
  name,
  expiresIn,
  artifactsDir,
  reset,
  fork,
  runTests,
});

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printPreviewResult(result);
}

if (result.status === "failed") {
  process.exitCode = 1;
}
