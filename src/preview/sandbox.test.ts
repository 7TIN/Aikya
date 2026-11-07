import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PreviewContract } from "./contract.ts";
import {
  runSandbox,
  SANDBOX_STEPS,
  type SandboxStepName,
} from "./sandbox.ts";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aikya-sandbox-test-"));
  roots.push(root);
  return root;
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await tempDir();
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

function contract(
  commands: Partial<Record<SandboxStepName, string>>,
): PreviewContract {
  return {
    version: 1,
    source: "manifest",
    root: "fixture",
    manifestPath: null,
    runtime: "bun",
    packageManager: "bun",
    install: commands.install ?? null,
    migrate: commands.migrate ?? null,
    seed: commands.seed ?? null,
    build: commands.build ?? null,
    test: commands.test ?? null,
    app: null,
    envRequired: [],
    migrationsDir: null,
    database: { required: false, provider: null },
    warnings: [],
  };
}

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("runSandbox", () => {
  test("runs a step, captures output, and removes the checkout", async () => {
    const source = await fixture({ "marker.txt": "hello\n" });
    const workRoot = await tempDir();

    const result = await runSandbox({
      source,
      workRoot,
      contract: contract({ test: `bun -e "console.log('sandbox-ok')"` }),
      steps: ["test"],
    });

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe("ok");
    expect(result.steps[0]?.exitCode).toBe(0);
    expect(result.steps[0]?.output).toContain("sandbox-ok");
    expect(result.dir).toBeNull();
    // The source is untouched and the scratch parent is empty again.
    expect(await readdir(source)).toContain("marker.txt");
    expect(await readdir(workRoot)).toEqual([]);
  });

  test("reports the exit code and output tail for a failed step", async () => {
    const source = await fixture({ "package.json": "{}" });

    const result = await runSandbox({
      source,
      contract: contract({
        test: `bun -e "console.error('boom'); process.exit(3)"`,
      }),
      steps: ["test"],
    });

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.exitCode).toBe(3);
    expect(result.steps[0]?.output).toContain("boom");
    expect(result.error).toContain('"test" failed');
    expect(result.error).toContain("exit code 3");
  });

  test("kills a step that exceeds its timeout", async () => {
    const source = await fixture({ "package.json": "{}" });

    const result = await runSandbox({
      source,
      contract: contract({
        test: `bun -e "setTimeout(() => {}, 60000)"`,
      }),
      steps: ["test"],
      stepTimeoutMs: 400,
    });

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.timedOut).toBe(true);
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.durationMs).toBeLessThan(15_000);
  });

  test("does not inherit control-plane secrets", async () => {
    const source = await fixture({ "package.json": "{}" });
    process.env.AIKYA_TEST_SECRET = "leak-me";

    try {
      const result = await runSandbox({
        source,
        contract: contract({
          test: `bun -e "console.log('secret=' + (process.env.AIKYA_TEST_SECRET ?? 'absent')); console.log('explicit=' + process.env.EXPLICIT_VAR);"`,
        }),
        steps: ["test"],
        env: { EXPLICIT_VAR: "visible" },
      });

      expect(result.ok).toBe(true);
      expect(result.steps[0]?.output).toContain("secret=absent");
      expect(result.steps[0]?.output).toContain("explicit=visible");
    } finally {
      delete process.env.AIKYA_TEST_SECRET;
    }
  });

  test("caps retained output per stream", async () => {
    const source = await fixture({ "package.json": "{}" });

    const result = await runSandbox({
      source,
      contract: contract({ test: `bun -e "console.log('x'.repeat(50000))"` }),
      steps: ["test"],
      maxOutputChars: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(result.steps[0]?.output.length).toBeLessThanOrEqual(2_001);
    expect(result.steps[0]?.output).toContain("x");
  });

  test("marks unconfigured steps as skipped", async () => {
    const source = await fixture({ "package.json": "{}" });

    const result = await runSandbox({
      source,
      contract: contract({ test: `bun -e "console.log('only-test')"` }),
    });

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.name)).toEqual([
      ...SANDBOX_STEPS,
    ]);
    expect(
      result.steps.filter((step) => step.status === "skipped"),
    ).toHaveLength(4);
    expect(result.steps.at(-1)?.status).toBe("ok");
  });

  test("stops after the first failure and skips the rest", async () => {
    const source = await fixture({ "package.json": "{}" });

    const result = await runSandbox({
      source,
      contract: contract({
        install: `bun -e "process.exit(2)"`,
        build: `bun -e "console.log('should-not-run')"`,
        test: `bun -e "console.log('should-not-run')"`,
      }),
      steps: ["install", "build", "test"],
    });

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[1]?.status).toBe("skipped");
    expect(result.steps[2]?.status).toBe("skipped");
    expect(result.steps[1]?.output).toContain("previous step failed");
  });

  test("checks out an earlier commit by SHA", async () => {
    const repo = await fixture({ "version.txt": "v1\n" });
    git(repo, ["init", "--quiet"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Sandbox Test"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "--quiet", "-m", "v1"]);
    const first = git(repo, ["rev-parse", "HEAD"]).trim();

    await writeFile(join(repo, "version.txt"), "v2\n", "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "--quiet", "-m", "v2"]);

    const result = await runSandbox({
      source: repo,
      ref: first,
      contract: contract({
        test: `bun -e "console.log(require('fs').readFileSync('version.txt','utf8'))"`,
      }),
      steps: ["test"],
    });

    expect(result.ok).toBe(true);
    expect(result.steps[0]?.output).toContain("v1");
    expect(result.steps[0]?.output).not.toContain("v2");
  });

  test("honours cancellation", async () => {
    const source = await fixture({ "package.json": "{}" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const result = await runSandbox({
      source,
      contract: contract({
        test: `bun -e "setTimeout(() => {}, 60000)"`,
      }),
      steps: ["test"],
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.cancelled).toBe(true);
    expect(result.error).toContain("cancelled");
    expect(result.durationMs).toBeLessThan(15_000);
  });

  test("keeps the checkout when asked", async () => {
    const source = await fixture({ "package.json": "{}" });

    const result = await runSandbox({
      source,
      contract: contract({ test: `bun -e "console.log('kept')"` }),
      steps: ["test"],
      keepDir: true,
    });

    expect(result.ok).toBe(true);
    expect(result.dir).not.toBeNull();
    expect(await readdir(result.dir as string)).toContain("package.json");
    await rm(dirname(result.dir as string), { recursive: true, force: true });
  });

  test("fails closed when the source does not exist", async () => {
    const result = await runSandbox({
      source: join(tmpdir(), `aikya-missing-${Date.now()}`),
      contract: contract({ test: `bun -e "console.log('nope')"` }),
      steps: ["test"],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("neither a local directory nor a git URL");
    expect(result.steps).toHaveLength(0);
    expect(result.dir).toBeNull();
  });

  test("reviewer is skipped on the local backend instead of running the app on the host", async () => {
    const source = await fixture({ "package.json": "{}" });

    const result = await runSandbox({
      source,
      contract: contract({ test: `bun -e "console.log('ok')"` }),
      steps: ["test"],
      review: { enabled: true },
    });

    expect(result.ok).toBe(true);
    expect(result.review?.status).toBe("skipped");
    expect(result.review?.reason).toContain("Vercel backend");
  });
});
