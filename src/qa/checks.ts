import type { QaCheckResult, QaSandbox } from "./types.ts";

/**
 * Deterministic preflight. These are the checks a human runs first, captured as
 * structured results so the agent gets a precise starting point.
 */

export interface QaCheckDefinition {
  name: string;
  command: string;
  timeoutMs: number;
}

export const QA_CHECKS: QaCheckDefinition[] = [
  { name: "typecheck", command: "bun run typecheck", timeoutMs: 240_000 },
  { name: "test", command: "bun test", timeoutMs: 300_000 },
  { name: "build", command: "bun run build", timeoutMs: 240_000 },
];

export interface RunQaChecksOptions {
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Maximum characters retained per check. */
  maxOutputChars?: number;
  checks?: QaCheckDefinition[];
}

export async function runQaChecks(
  sandbox: QaSandbox,
  options: RunQaChecksOptions = {},
): Promise<QaCheckResult[]> {
  const log = options.log ?? (() => {});
  const maxOutputChars = options.maxOutputChars ?? 12_000;
  const checks = options.checks ?? QA_CHECKS;
  const results: QaCheckResult[] = [];

  for (const check of checks) {
    if (options.signal?.aborted) {
      results.push({
        name: check.name,
        command: check.command,
        status: "skipped",
        exitCode: null,
        durationMs: 0,
        output: "cancelled",
      });
      continue;
    }

    log(`[qa] ${check.name}: ${check.command}`);
    const result = await sandbox.run(check.command, {
      timeoutMs: check.timeoutMs,
      signal: options.signal,
      maxOutputChars,
    });

    results.push({
      name: check.name,
      command: check.command,
      status: result.exitCode === 0 && !result.timedOut ? "ok" : "failed",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    });
  }

  return results;
}
