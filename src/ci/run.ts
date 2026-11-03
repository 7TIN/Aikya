export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Redact these substrings from stdout/stderr before returning them. */
  secrets?: string[];
}

/** Redact connection strings and tokens from captured output. */
function redact(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join("***");
  }
  return result;
}

/**
 * Run a child process and capture output. Used for migrations, resets, and
 * tests so each step runs with a branch-scoped DATABASE_URL and cannot leak a
 * connection string into logs.
 */
export async function runCommand(
  command: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const startedAt = Date.now();
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const secrets = options.secrets ?? [];
  return {
    command: command.join(" "),
    exitCode,
    stdout: redact(stdout, secrets),
    stderr: redact(stderr, secrets),
    durationMs: Date.now() - startedAt,
  };
}

/** Last non-empty lines of a command result, for a compact failure report. */
export function commandTail(result: CommandResult, lines = 25): string {
  const combined = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join("\n");
  if (!combined) return "";

  const all = combined.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

export interface TestSummary {
  passed: number | null;
  failed: number | null;
}

/**
 * Bun prints `N pass` / `N fail` (and sometimes `N fail` only when non-zero).
 * Parse the last occurrence so a nested runner's output cannot confuse it.
 */
export function parseTestSummary(output: string): TestSummary {
  const passMatches = [...output.matchAll(/^\s*(\d+)\s+pass\b/gim)];
  const failMatches = [...output.matchAll(/^\s*(\d+)\s+fail\b/gim)];

  const passed = passMatches.at(-1)?.[1];
  const failed = failMatches.at(-1)?.[1];

  return {
    passed: passed === undefined ? null : Number(passed),
    failed: failed === undefined ? null : Number(failed),
  };
}
