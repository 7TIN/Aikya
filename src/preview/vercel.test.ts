import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SandboxStepName } from "./sandbox.ts";
import { repoDirFromSource, runVercelSandbox, type SandboxClient } from "./vercel.ts";
import type { PreviewContract } from "./contract.ts";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aikya-vercel-test-"));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH, Path: process.env.Path },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`,
    );
  }
  return proc.stdout.toString();
}

function tempContract(
  commands: Partial<Record<SandboxStepName, string>>,
): PreviewContract {
  return {
    version: 1,
    source: "manifest",
    root: "fixture",
    manifestPath: ".aikya/preview.yml",
    runtime: "bun",
    packageManager: "bun",
    install: commands.install ?? null,
    migrate: commands.migrate ?? null,
    seed: commands.seed ?? null,
    build: commands.build ?? null,
    test: commands.test ?? null,
    app: null,
    envRequired: ["DATABASE_URL"],
    migrationsDir: "drizzle",
    database: { required: true, provider: "neon" },
    warnings: [],
  };
}

interface FakeCall {
  params: Record<string, unknown>;
  commands: Array<{
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }>;
}

interface FakeCommand {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function fakeFactory(options: {
  onCommand?: (
    command: FakeCommand,
    index: number,
  ) => { exitCode: number; stdout: string; stderr: string; durationMs?: number };
  createError?: Error;
}): { factory: (params: Record<string, unknown>) => Promise<SandboxClient>; calls: FakeCall } {
  const calls: FakeCall = { params: {}, commands: [] };

  return {
    calls,
    factory: async (params) => {
      if (options.createError) throw options.createError;
      calls.params = params;

      return {
        name: "aikya-test-sandbox",
        async runCommand(command) {
          calls.commands.push({
            cmd: command.cmd,
            args: command.args ?? [],
            cwd: command.cwd,
            env: command.env,
            timeoutMs: command.timeoutMs,
          });

          const index = calls.commands.length - 1;
          const result = options.onCommand?.(command, index) ?? {
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            durationMs: 12,
          };
          return {
            exitCode: result.exitCode,
            durationMs: result.durationMs ?? 12,
            stdout: async () => result.stdout,
            stderr: async () => result.stderr,
          };
        },
        async delete() {
          calls.params = { ...calls.params, deleted: true, deleteOrphanSnapshots: true };
        },
      };
    },
  };
}

afterEach(async () => {
  delete process.env.AIKYA_TEST_AMBIENT_SECRET;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("repoDirFromSource", () => {
  test("derives the repository directory from HTTPS URLs", () => {
    expect(repoDirFromSource("https://github.com/owner/repo.git")).toBe("repo");
    expect(repoDirFromSource("https://github.com/owner/repo/")).toBe("repo");
    expect(repoDirFromSource("https://example.com/path/to/my-repo.git/")).toBe("my-repo");
  });
});

describe("runVercelSandbox", () => {
  test("denies a plain local directory before creating a sandbox", async () => {
    const root = await tempDir();
    const fixture = join(root, "plain");
    await mkdir(fixture);
    const { factory, calls } = fakeFactory({});

    const result = await runVercelSandbox({
      source: fixture,
      backend: "vercel",
      contract: tempContract({ test: "echo ok" }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Commit it to a git remote");
    expect(calls.params).toEqual({});
    expect(calls.commands).toEqual([]);
  });

  test("uses a local git repo's public HTTPS origin and passes only explicit secrets", async () => {
    const root = await tempDir();
    const fixture = join(root, "repo");
    await mkdir(fixture);
    await writeFile(join(fixture, ".gitkeep"), "x");
    git(fixture, ["init", "--quiet"]);
    git(fixture, ["remote", "add", "origin", "https://github.com/example/repo.git"]);

    process.env.AIKYA_TEST_AMBIENT_SECRET = "must-not-pass";
    const { factory, calls } = fakeFactory({});

    const result = await runVercelSandbox(
      {
        source: fixture,
        backend: "vercel",
        ref: "0123456789abcdef0123456789abcdef01234567",
        contract: tempContract({
          migrate: "bun run migrate.ts",
          test: "bun run test.ts",
        }),
        env: { DATABASE_URL: "postgres://subject-branch" },
        steps: ["install", "migrate", "test"],
        stepTimeoutMs: 5_000,
      },
      { createSandbox: factory },
    );

    expect(result.ok).toBe(true);
    expect(calls.params).toMatchObject({
      source: {
        type: "git",
        url: "https://github.com/example/repo.git",
        revision: "0123456789abcdef0123456789abcdef01234567",
      },
      persistent: false,
      snapshotExpiration: 0,
      networkPolicy: "allow-all",
      deleted: true,
      deleteOrphanSnapshots: true,
    });
    expect(calls.commands.map((command) => command.cmd)).toEqual(["sh", "sh"]);
    expect(calls.commands[0]?.args).toEqual(["-c", "bun run migrate.ts"]);
    expect(calls.commands[0]?.cwd).toBe("repo");
    expect(calls.commands[0]?.env?.DATABASE_URL).toBe("postgres://subject-branch");
    expect(calls.commands[0]?.env?.AIKYA_TEST_AMBIENT_SECRET).toBeUndefined();
    expect(result.steps.map((step) => step.name)).toEqual([
      "install",
      "migrate",
      "test",
    ]);
    expect(result.steps[0]?.status).toBe("skipped");
    expect(result.steps[1]?.output).toContain("ok");
    expect(result.dir).toBeNull();
    expect(result.backend).toBe("vercel");
  });

  test("stops after a failed command and deletes the sandbox", async () => {
    const { factory, calls } = fakeFactory({
      onCommand: (_command, index) =>
        index === 0
          ? { exitCode: 1, stdout: "before failure", stderr: "boom" }
          : { exitCode: 0, stdout: "must-not-run", stderr: "" },
    });

    const result = await runVercelSandbox(
      {
        source: "https://github.com/example/repo.git",
        backend: "vercel",
        contract: tempContract({ migrate: "bun run migrate.ts", test: "bun test" }),
        steps: ["migrate", "test"],
      },
      { createSandbox: factory },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("migrate");
    expect(result.steps.map((step) => step.status)).toEqual(["failed", "skipped"]);
    expect(result.steps[0]?.output).toContain("boom");
    expect(calls.commands).toHaveLength(1);
    expect(calls.params.deleted).toBe(true);
  });

  test("marks a command that reaches its timeout as timed out", async () => {
    const { factory } = fakeFactory({
      onCommand: () => ({
        exitCode: 137,
        stdout: "",
        stderr: "killed",
        durationMs: 1_000,
      }),
    });

    const result = await runVercelSandbox(
      {
        source: "https://github.com/example/repo.git",
        backend: "vercel",
        contract: tempContract({ migrate: "sleep 60" }),
        steps: ["migrate"],
        stepTimeoutMs: 900,
      },
      { createSandbox: factory },
    );

    expect(result.steps[0]?.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
  });

  test("honors a pre-aborted run without contacting Vercel", async () => {
    const controller = new AbortController();
    controller.abort();
    const { factory } = fakeFactory({});

    const result = await runVercelSandbox(
      {
        source: "https://github.com/example/repo.git",
        backend: "vercel",
        contract: tempContract({ test: "echo ok" }),
        signal: controller.signal,
      },
      { createSandbox: factory },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cancelled");
    expect(result.steps).toEqual([]);
  });

  test("marks a run cancelled when the signal aborts during a command", async () => {
    const controller = new AbortController();
    const { factory } = fakeFactory({
      onCommand: () => {
        controller.abort();
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });

    const result = await runVercelSandbox(
      {
        source: "https://github.com/example/repo.git",
        backend: "vercel",
        contract: tempContract({ test: "echo ok" }),
        signal: controller.signal,
      },
      { createSandbox: factory },
    );

    expect(result.ok).toBe(false);
    expect(result.steps.find((step) => step.name === "test")?.cancelled).toBe(true);
    expect(result.error).toContain("cancelled");
  });

  test("reports a Vercel creation failure instead of falling back locally", async () => {
    const result = await runVercelSandbox(
      {
        source: "https://github.com/example/repo.git",
        backend: "vercel",
        contract: tempContract({ test: "echo ok" }),
      },
      { createSandbox: async () => {
        throw new Error("authentication failed");
      } },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not be created: authentication failed");
    expect(result.backend).toBe("vercel");
    expect(result.dir).toBeNull();
  });
});
