export class NeonCliError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = "NeonCliError";
  }
}

export function neonProjectId(): string {
  const projectId = process.env.NEON_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      "NEON_PROJECT_ID is not set. Add it to .env.local (Neon console → Project settings) " +
        "or run the branch commands with a claimed Neon project.",
    );
  }
  return projectId;
}

function troubleshootingHint(stderr: string): string {
  if (stderr.includes("before claim")) {
    return (
      "\n\nThis is an unclaimed Claimable Neon project. Branch creation is a management\n" +
      "operation that unlocks after the project is claimed. Run `neon claim accept`\n" +
      "(opens a browser, needs a Neon account), then retry. You can also point\n" +
      "NEON_PROJECT_ID at an existing claimed project.\n"
    );
  }

  if (
    stderr.includes("being claimed") ||
    stderr.includes("claim-status polling") ||
    stderr.includes("claim_in_progress")
  ) {
    return (
      "\n\nThis project's claim transfer is still in progress, so only claim status\n" +
      "is available. Run `neon claim status`. If it reports `reconciled: true`,\n" +
      "authenticate the Neon CLI (`neon login` or `NEON_API_KEY`), refresh env with\n" +
      "`neon env pull`, then retry.\n"
    );
  }

  if (
    stderr.includes("Not signed in") ||
    stderr.includes("no stored credential") ||
    stderr.includes("authentication")
  ) {
    return (
      "\n\nThe Neon CLI is not authenticated. The database connection can still work,\n" +
      "but branch management uses the Neon API. Either:\n" +
      "  • run `neon login` (opens a browser), or\n" +
      "  • create an API key (Neon console → Account settings → API keys) and add\n" +
      "    NEON_API_KEY=napi_... to .env.local, then retry.\n"
    );
  }

  return "";
}

/** Run the Neon CLI and return stdout. Throws NeonCliError on failure. */
export async function runNeon(args: string[]): Promise<string> {
  const proc = Bun.spawn(["neon", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new NeonCliError(
      `neon ${args.join(" ")} failed: ${detail}${troubleshootingHint(detail)}`,
      args,
      detail,
    );
  }

  return stdout;
}

/** Run a Neon CLI command with `-o json` and parse the result. */
export async function runNeonJson<T>(args: string[]): Promise<T> {
  const output = await runNeon([...args, "-o", "json"]);
  return parseJson<T>(output);
}

function parseJson<T>(output: string): T {
  const text = output.trim();
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const candidates = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = candidates.length > 0 ? Math.min(...candidates) : 0;
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch (error) {
    throw new Error(
      `Could not parse Neon CLI JSON output: ${(error as Error).message}\n${text.slice(0, 500)}`,
    );
  }
}

export function defaultDatabaseName(): string {
  const explicit = process.env.NEON_DATABASE_NAME;
  if (explicit) return explicit;

  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      const name = new URL(url).pathname.replace(/^\//, "");
      if (name) return decodeURIComponent(name);
    } catch {
      // fall through
    }
  }

  return "neondb";
}

export function parentBranchName(): string {
  return process.env.NEON_PARENT_BRANCH || "main";
}
