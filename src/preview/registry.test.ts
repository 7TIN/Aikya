import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  findSubjectRepo,
  loadRepoRegistry,
  readEnvFile,
  requireSubjectRepo,
  resolveSubjectNeonContext,
  type SubjectRepoConfig,
} from "./registry.ts";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aikya-registry-test-"));
  roots.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: "7TIN/gh-lab",
    projectId: "flat-resonance-58366530",
    parent: "main",
    apiKeyEnv: "SUBJECT_NEON_KEY",
    database: "neondb",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("loadRepoRegistry", () => {
  test("loads a committed registry and derives safe defaults", async () => {
    const root = await tempDir();
    const path = join(root, "repos.json");
    await writeJson(path, {
      version: 1,
      repos: [{ repo: "7TIN/gh-lab", projectId: "proj" }],
    });

    const registry = await loadRepoRegistry({
      path,
      localPath: join(root, "missing.local.json"),
    });
    const config = findSubjectRepo(registry, "7tin/GH-LAB");

    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      repo: "7TIN/gh-lab",
      projectId: "proj",
      parent: "main",
      apiKeyEnv: "NEON_API_KEY_7TIN_GH_LAB",
      source: "https://github.com/7TIN/gh-lab.git",
      database: "neondb",
      backend: "local",
    });
    expect(registry.warnings).toEqual([]);
  });

  test("a local entry replaces the committed entry with the same repo", async () => {
    const root = await tempDir();
    const path = join(root, "repos.json");
    const localPath = join(root, "repos.local.json");

    await writeJson(path, {
      version: 1,
      repos: [entry()],
    });
    await writeJson(localPath, {
      version: 1,
      repos: [
        entry({
          projectId: "local-project",
          source: "./fixtures/gh-lab",
          stepTimeoutMs: 120000,
        }),
      ],
    });

    const registry = await loadRepoRegistry({ path, localPath });
    expect(registry.repos.size).toBe(1);
    expect(findSubjectRepo(registry, "7TIN/gh-lab")).toMatchObject({
      projectId: "local-project",
      source: join(root, "fixtures", "gh-lab"),
      stepTimeoutMs: 120_000,
    });
  });

  test("accepts a top-level array and a git URL source", async () => {
    const root = await tempDir();
    const path = join(root, "repos.json");
    await writeJson(path, [
      entry({ source: "ssh://git@example.com/team/app.git" }),
    ]);

    const registry = await loadRepoRegistry({
      path,
      localPath: join(root, "missing.local.json"),
    });
    expect(findSubjectRepo(registry, "7TIN/gh-lab")?.source).toBe(
      "ssh://git@example.com/team/app.git",
    );
  });

  test("parses Vercel backend settings without enabling them by default", async () => {
    const root = await tempDir();
    const path = join(root, "repos.json");
    await writeJson(path, {
      version: 1,
      repos: [
        entry({
          backend: "vercel",
          vcpus: 4,
          region: "sin1",
          networkPolicy: "deny-all",
          sandboxTimeoutMs: 900000,
          image: "vercel/sandbox/universal:latest",
        }),
      ],
    });

    const registry = await loadRepoRegistry({
      path,
      localPath: join(root, "missing.local.json"),
    });
    expect(findSubjectRepo(registry, "7TIN/gh-lab")).toMatchObject({
      backend: "vercel",
      vcpus: 4,
      region: "sin1",
      networkPolicy: "deny-all",
      sandboxTimeoutMs: 900_000,
      image: "vercel/sandbox/universal:latest",
    });
  });

  test("rejects invalid Vercel backend settings", async () => {
    const root = await tempDir();
    const path = join(root, "repos.json");

    await writeJson(path, [entry({ backend: "remote" })]);
    await expect(
      loadRepoRegistry({ path, localPath: join(root, "missing.local.json") }),
    ).rejects.toThrow(/backend/);

    await writeJson(path, [entry({ networkPolicy: "blocked" })]);
    await expect(
      loadRepoRegistry({ path, localPath: join(root, "missing.local.json") }),
    ).rejects.toThrow(/networkPolicy/);

    await writeJson(path, [entry({ vcpus: 0 })]);
    await expect(
      loadRepoRegistry({ path, localPath: join(root, "missing.local.json") }),
    ).rejects.toThrow(/vcpus/);
  });

  test("rejects invalid entries instead of guessing", async () => {
    const root = await tempDir();
    const path = join(root, "repos.json");

    await writeJson(path, [{ repo: "7TIN/gh-lab" }]);
    await expect(
      loadRepoRegistry({ path, localPath: join(root, "missing.local.json") }),
    ).rejects.toThrow(/needs a projectId/);

    await writeJson(path, [entry({ steps: ["migrate", "deploy"] })]);
    await expect(
      loadRepoRegistry({ path, localPath: join(root, "missing.local.json") }),
    ).rejects.toThrow(/unknown step|contains "deploy"/i);

    await writeJson(path, [entry({ source: "./a", localPath: "./b" })]);
    await expect(
      loadRepoRegistry({ path, localPath: join(root, "missing.local.json") }),
    ).rejects.toThrow(/cannot set both source and localPath/);

    await writeJson(path, [entry(), entry()]);
    await expect(
      loadRepoRegistry({ path, localPath: join(root, "missing.local.json") }),
    ).rejects.toThrow(/duplicate repository/);

    await writeJson(path, { version: 2, repos: [] });
    await expect(
      loadRepoRegistry({ path, localPath: join(root, "missing.local.json") }),
    ).rejects.toThrow(/unsupported version/);
  });

  test("warns about unknown keys but keeps the entry usable", async () => {
    const root = await tempDir();
    const path = join(root, "repos.json");
    await writeJson(path, [entry({ projectID: "typo" })]);

    const registry = await loadRepoRegistry({
      path,
      localPath: join(root, "missing.local.json"),
    });
    expect(registry.warnings[0]).toContain('unknown key "projectID"');
    expect(findSubjectRepo(registry, "7TIN/gh-lab")?.projectId).toBe(
      "flat-resonance-58366530",
    );
  });
});

describe("resolveSubjectNeonContext", () => {
  const config: SubjectRepoConfig = {
    repo: "7TIN/gh-lab",
    projectId: "proj",
    parent: "main",
    apiKeyEnv: "SUBJECT_NEON_KEY",
    source: "https://github.com/7TIN/gh-lab.git",
    database: "neondb",
    backend: "local",
  };

  test("returns only the explicit subject project and key", () => {
    expect(
      resolveSubjectNeonContext(config, { SUBJECT_NEON_KEY: "napi_subject" }),
    ).toEqual({
      projectId: "proj",
      apiKey: "napi_subject",
      database: "neondb",
    });
  });

  test("fails closed instead of borrowing NEON_API_KEY", () => {
    expect(() =>
      resolveSubjectNeonContext(config, { NEON_API_KEY: "napi_aikya" }),
    ).toThrow(/requires SUBJECT_NEON_KEY/);
  });

  test("requires a non-empty key", () => {
    expect(() =>
      resolveSubjectNeonContext(config, { SUBJECT_NEON_KEY: "   " }),
    ).toThrow(/requires SUBJECT_NEON_KEY/);
  });

  test("explicit apiKeyEnv null uses the CLI login without reading NEON_API_KEY", () => {
    expect(
      resolveSubjectNeonContext(
        { ...config, apiKeyEnv: null },
        { NEON_API_KEY: "napi_aikya" },
      ),
    ).toEqual({ projectId: "proj", database: "neondb" });
  });
});

describe("requireSubjectRepo", () => {
  test("lists configured repos when one is missing", async () => {
    const root = await tempDir();
    const path = join(root, "repos.json");
    await writeJson(path, [entry()]);

    const registry = await loadRepoRegistry({
      path,
      localPath: join(root, "missing.local.json"),
    });

    expect(() => requireSubjectRepo(registry, "other/repo")).toThrow(
      /not in the preview registry.*7TIN\/gh-lab/s,
    );
  });
});

describe("readEnvFile", () => {
  test("parses dotenv values and ignores comments", async () => {
    const root = await tempDir();
    const path = join(root, ".env.subject");
    await writeFile(
      path,
      [
        "# comment",
        "SUBJECT_TOKEN=abc",
        'QUOTED="hello world"',
        "export EXPORTED=yes",
        "EMPTY=",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(await readEnvFile(path)).toEqual({
      SUBJECT_TOKEN: "abc",
      QUOTED: "hello world",
      EXPORTED: "yes",
      EMPTY: "",
    });
  });
});
