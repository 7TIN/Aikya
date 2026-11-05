import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPreviewComment } from "./comment.ts";
import { runPreview, type PreviewResult, type SubjectPreviewConfig } from "./preview.ts";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aikya-preview-subject-"));
  roots.push(root);
  return root;
}

const subject: SubjectPreviewConfig = {
  repo: "local/fixture",
  neon: { projectId: "subject-project", apiKey: "napi_subject", database: "neondb" },
  source: "C:/fixtures/does-not-exist",
  ref: "abc123",
  parent: "main",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("subject preview planning", () => {
  test("fork previews skip before touching Neon or the checkout", async () => {
    const artifactsDir = await tempDir();

    const result = await runPreview({
      pr: 9,
      event: "opened",
      name: "preview/local-fixture-pr-9",
      fork: true,
      artifactsDir,
      subject,
    });

    expect(result.status).toBe("skipped");
    expect(result.subject).toEqual({
      repo: "local/fixture",
      projectId: "subject-project",
      source: "C:/fixtures/does-not-exist",
      ref: "abc123",
      parent: "main",
      database: "neondb",
      backend: "local",
    });
    expect(result.steps[0]).toMatchObject({
      name: "create branch",
      status: "skipped",
    });
    expect(result.report).toBeUndefined();
  });

  test("subject previews require a repo-scoped branch name", async () => {
    await expect(
      runPreview({ pr: 9, event: "opened", subject }),
    ).rejects.toThrow(/repo-scoped branch name/);
  });

  test("the comment names the subject project and commit", () => {
    const result: PreviewResult = {
      pr: 9,
      event: "opened",
      action: "create",
      status: "ready",
      branch: "preview/local-fixture-pr-9",
      parent: "main",
      reason: "create a fresh preview branch",
      steps: [],
      subject: {
        repo: "local/fixture",
        projectId: "subject-project",
        source: "C:/fixtures/does-not-exist",
        ref: "abc123",
        parent: "main",
        database: "neondb",
        backend: "local",
      },
      comment: "",
    };

    const comment = renderPreviewComment(result);
    expect(comment).toContain("| Subject repo | `local/fixture` |");
    expect(comment).toContain("| Neon project | `subject-project` |");
    expect(comment).toContain("| Commit | `abc123` |");
  });
});
