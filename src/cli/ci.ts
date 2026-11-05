import { flagBool, flagString, parseArgs } from "../lib/args.ts";
import {
  printPreviewResult,
  runPreview,
  type SubjectPreviewConfig,
} from "../ci/preview.ts";
import type { SandboxBackend } from "../preview/sandbox.ts";
import { parsePullRequestNumber } from "../ci/events.ts";
import { monitorBranchName } from "../github/monitor.ts";
import {
  loadRepoRegistry,
  readEnvFile,
  requireSubjectRepo,
  resolveSubjectNeonContext,
} from "../preview/registry.ts";

const { flags, positional } = parseArgs(Bun.argv.slice(2));
const command = positional[0];

function usage(): never {
  console.error(
    [
      "Usage:",
      "  bun run ci:preview --pr <number> [--event opened|synchronize|reopened|closed]",
      "  bun run ci:cleanup --pr <number>",
      "  bun run ci:preview --repo <owner/name> --pr <number> [--ref <sha>]",
      "",
      "Options:",
      "  --pr <number>        Pull request number (required)",
      "  --event <event>      Defaults to opened; cleanup defaults to closed",
      "  --repo <owner/name>  Run the watched repo's own contract in its own Neon project",
      "  --source <path|url>  Override the registry source (local fixture or PR clone)",
      "  --ref <sha|ref>      Checkout override for a subject preview",
      "  --backend <local|vercel>  Execution backend (registry default: local)",
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
const repoFlag = flagString(flags, "repo");
const sourceFlag = flagString(flags, "source");
const ref = flagString(flags, "ref");
const backendFlag = flagString(flags, "backend") as SandboxBackend | undefined;

if (backendFlag && backendFlag !== "local" && backendFlag !== "vercel") {
  console.error("");
  console.error('--backend must be "local" or "vercel".');
  console.error("");
  process.exit(1);
}

if (!repoFlag && (sourceFlag || ref || backendFlag)) {
  usage();
}

let subject: SubjectPreviewConfig | undefined;
let subjectBranch: string | undefined;

if (repoFlag) {
  try {
    const registry = await loadRepoRegistry();
    for (const warning of registry.warnings) {
      console.warn(`[registry] ${warning}`);
    }

    const entry = requireSubjectRepo(registry, repoFlag);
    const neon = resolveSubjectNeonContext(entry);
    const backend = backendFlag ?? entry.backend;
    const vercel =
      backend === "vercel"
        ? {
            vcpus: entry.vcpus,
            region: entry.region,
            image: entry.image,
            networkPolicy: entry.networkPolicy,
            sandboxTimeoutMs: entry.sandboxTimeoutMs,
          }
        : undefined;

    subject = {
      repo: entry.repo,
      neon,
      source: sourceFlag ?? entry.source,
      ref: ref ?? null,
      parent: entry.parent,
      env: entry.envFrom ? await readEnvFile(entry.envFrom) : undefined,
      steps: entry.steps,
      stepTimeoutMs: entry.stepTimeoutMs,
      backend,
      vercel,
    };
    subjectBranch = monitorBranchName(entry.repo, pr);
  } catch (error) {
    console.error("");
    console.error(
      `Subject preview unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("");
    process.exit(1);
  }
}

const result = await runPreview({
  pr,
  event,
  parent,
  name: name ?? subjectBranch,
  expiresIn,
  artifactsDir,
  reset,
  fork,
  runTests,
  subject,
});

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printPreviewResult(result);
}

if (result.status === "failed") {
  process.exitCode = 1;
}
