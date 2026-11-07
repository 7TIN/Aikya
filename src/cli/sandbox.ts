import { flagBool, flagString, parseArgs } from "../lib/args.ts";
import { formatDuration, parseDuration } from "../lib/duration.ts";
import { bold, dim, paint } from "../lib/format.ts";
import {
  runSandbox,
  SANDBOX_STEPS,
  type SandboxOptions,
  type SandboxStepName,
} from "../preview/sandbox.ts";

const { flags } = parseArgs(Bun.argv.slice(2));
const source = flagString(flags, "repo");
const ref = flagString(flags, "ref");
const stepsFlag = flagString(flags, "steps");
const timeoutFlag = flagString(flags, "timeout");
const maxOutputFlag = flagString(flags, "max-output");
const envFlag = flagString(flags, "env");
const backendFlag = flagString(flags, "backend") ?? "local";
const vcpusFlag = flagString(flags, "vcpus");
const region = flagString(flags, "region");
const image = flagString(flags, "image");
const networkPolicy = flagString(flags, "network-policy") as
  | "allow-all"
  | "deny-all"
  | undefined;
const sandboxTimeoutFlag = flagString(flags, "sandbox-timeout");
const keep = flagBool(flags, "keep");
const reviewEnabled = flagBool(flags, "review");
const reviewDisabled = flagBool(flags, "no-review");
const reviewTimeoutFlag = flagString(flags, "review-timeout");
const json = flagBool(flags, "json");

function fail(error: unknown): never {
  console.error("");
  console.error(
    paint("red", error instanceof Error ? error.message : String(error)),
  );
  console.error("");
  process.exit(1);
}

if (!["local", "vercel"].includes(backendFlag)) {
  fail(new Error('--backend must be "local" or "vercel".'));
}

if (reviewEnabled && reviewDisabled) {
  fail(new Error("Cannot pass both --review and --no-review."));
}

let vercel: SandboxOptions["vercel"] | undefined;
if (backendFlag === "vercel") {
  if (keep) {
    fail(new Error("--keep applies only to the local backend."));
  }

  let vcpus: number | undefined;
  if (vcpusFlag) {
    if (!/^\d+$/.test(vcpusFlag) || Number(vcpusFlag) <= 0) {
      fail(new Error("--vcpus must be a positive integer."));
    }
    vcpus = Number(vcpusFlag);
  }

  if (
    networkPolicy &&
    networkPolicy !== "allow-all" &&
    networkPolicy !== "deny-all"
  ) {
    fail(new Error("--network-policy must be allow-all or deny-all."));
  }

  let sandboxTimeoutMs: number | undefined;
  if (sandboxTimeoutFlag) {
    try {
      sandboxTimeoutMs = /^\d+$/.test(sandboxTimeoutFlag)
        ? Number(sandboxTimeoutFlag)
        : parseDuration(sandboxTimeoutFlag);
    } catch (error) {
      fail(error);
    }
  }

  vercel = { vcpus, region, image, networkPolicy, sandboxTimeoutMs };
}

if (!source) {
  fail(
    new Error(
      "Missing --repo <path|url>. Example: bun run preview:sandbox --repo ../gh-lab --steps test",
    ),
  );
}

let steps: SandboxStepName[] | undefined;
if (stepsFlag) {
  steps = stepsFlag
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0) as SandboxStepName[];

  for (const step of steps) {
    if (!(SANDBOX_STEPS as readonly string[]).includes(step)) {
      fail(
        new Error(
          `Unknown step "${step}". Use one of: ${SANDBOX_STEPS.join(", ")}.`,
        ),
      );
    }
  }
  if (steps.length === 0) {
    fail(new Error("--steps was empty. Use a comma-separated list of steps."));
  }
}

let stepTimeoutMs: number | undefined;
if (timeoutFlag) {
  try {
    stepTimeoutMs = /^\d+$/.test(timeoutFlag)
      ? Number(timeoutFlag)
      : parseDuration(timeoutFlag);
  } catch (error) {
    fail(error);
  }
}

let maxOutputChars: number | undefined;
if (maxOutputFlag) {
  if (!/^\d+$/.test(maxOutputFlag) || Number(maxOutputFlag) <= 0) {
    fail(new Error("--max-output must be a positive integer."));
  }
  maxOutputChars = Number(maxOutputFlag);
}

const env: Record<string, string> = {};
if (envFlag) {
  const equals = envFlag.indexOf("=");
  if (equals <= 0) {
    fail(new Error("--env must be KEY=VALUE."));
  }
  env[envFlag.slice(0, equals)] = envFlag.slice(equals + 1);
}

let reviewTimeoutMs: number | undefined;
if (reviewTimeoutFlag) {
  try {
    reviewTimeoutMs = /^\d+$/.test(reviewTimeoutFlag)
      ? Number(reviewTimeoutFlag)
      : parseDuration(reviewTimeoutFlag);
  } catch (error) {
    fail(error);
  }
}

const review: SandboxOptions["review"] =
  reviewEnabled || reviewDisabled
    ? { enabled: reviewEnabled, timeoutMs: reviewTimeoutMs }
    : undefined;

const result = await runSandbox({
  source,
  backend: backendFlag as SandboxOptions["backend"],
  ref,
  steps,
  stepTimeoutMs,
  maxOutputChars,
  env,
  keepDir: keep,
  vercel,
  review,
  log: json ? undefined : (line) => console.error(dim(line)),
});

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("");
  console.log(bold(paint("cyan", "Sandbox run")));
  console.log("─".repeat(72));
  console.log(`source      ${result.source}`);
  console.log(`backend     ${result.backend}`);
  console.log(`ref         ${result.ref ?? dim("(default)")}`);
  if (result.contract) {
    console.log(
      `contract    ${result.contract.source}${
        result.contract.manifestPath
          ? ` (${result.contract.manifestPath})`
          : ""
      }`,
    );
  }
  console.log(`result      ${result.ok ? paint("green", "ok") : paint("red", "failed")} ${dim(`in ${formatDuration(result.durationMs)}`)}`);

  if (result.steps.length > 0) {
    console.log("");
    for (const step of result.steps) {
      const mark =
        step.status === "ok"
          ? paint("green", "✔")
          : step.status === "failed"
            ? paint("red", "✖")
            : dim("·");
      const detail =
        step.status === "skipped"
          ? dim(` ${step.output}`)
          : dim(
              ` ${formatDuration(step.durationMs)}${
                step.exitCode !== null ? ` · exit ${step.exitCode}` : ""
              }${step.timedOut ? " · timed out" : ""}${
                step.cancelled ? " · cancelled" : ""
              }`,
            );
      console.log(`${mark} ${step.name.padEnd(8)}${detail}`);
      if (step.command) console.log(`    ${dim(step.command)}`);

      if (step.status === "failed" && step.output) {
        const tail = step.output.split(/\r?\n/).slice(-15).join("\n    ");
        console.log(`    ${tail}`);
      }
    }
  }

  if (result.review) {
    console.log("");
    console.log(bold("Advisory reviewer"));
    console.log(
      `status      ${result.review.status}${result.review.reason ? ` ${dim(`(${result.review.reason})`)}` : ""} ${dim(`in ${formatDuration(result.review.durationMs)}`)}`,
    );
    for (const finding of result.review.findings) {
      const mark =
        finding.status === "ok"
          ? paint("green", "✔")
          : finding.status === "failed"
            ? paint("yellow", "!")
            : dim("·");
      console.log(`  ${mark} ${finding.title}${finding.detail ? dim(` — ${finding.detail}`) : ""}`);
    }
  }

  if (result.contract?.warnings.length) {
    console.log("");
    console.log(bold("Contract warnings"));
    for (const warning of result.contract.warnings) {
      console.log(`  • ${warning}`);
    }
  }

  if (result.dir) {
    console.log("");
    console.log(`checkout    ${result.dir} ${dim("(kept)")}`);
  }

  if (result.error) {
    console.log("");
    console.log(paint("red", result.error));
  }

  console.log("");
}

process.exit(result.ok ? 0 : 1);
