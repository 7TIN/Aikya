import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalQaSandbox } from "./sandbox.ts";

const roots: string[] = [];

async function sourceRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aikya-qa-source-"));
  roots.push(root);

  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(root, ".env.local"), "SECRET=do-not-copy\n", "utf8");
  await writeFile(join(root, "bun.lock"), "", "utf8");

  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "node_modules/pkg/index.js"), "x", "utf8");

  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const hasGit = Bun.which("git") !== null;

describe("LocalQaSandbox", () => {
  test.skipIf(!hasGit)("copies a safe checkout and captures a patch", async () => {
    const source = await sourceRepo();
    const sandbox = await LocalQaSandbox.create({ source, install: false });

    try {
      expect(await sandbox.read("src/a.ts")).toBe("export const a = 1;\n");
      expect(await sandbox.exists("src/a.ts")).toBe(true);

      const files = await sandbox.list();
      expect(files).toContain("src/a.ts");
      expect(files).toContain("bun.lock");
      expect(files).not.toContain(".env.local");
      expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);

      await expect(sandbox.read(".env.local")).rejects.toThrow();

      await sandbox.write("src/b.ts", "export const b = 2;\n");
      await sandbox.write("src/a.ts", "export const a = 3;\n");

      const patch = await sandbox.diff();
      expect(patch).toContain("diff --git a/src/a.ts b/src/a.ts");
      expect(patch).toContain("diff --git a/src/b.ts b/src/b.ts");
      expect(patch).not.toContain("SECRET");

      await sandbox.remove("src/b.ts");
      expect(await sandbox.exists("src/b.ts")).toBe(false);
    } finally {
      await sandbox.close();
    }

    await expect(stat(sandbox.root)).rejects.toThrow();
  });

  test.skipIf(!hasGit)("rejects writes outside the workspace", async () => {
    const source = await sourceRepo();
    const sandbox = await LocalQaSandbox.create({ source, install: false });

    try {
      await expect(sandbox.write("../escape.ts", "bad")).rejects.toThrow();
      await expect(sandbox.write(".git/config", "bad")).rejects.toThrow();
      await expect(sandbox.write(".env", "SECRET=1")).rejects.toThrow();
    } finally {
      await sandbox.close();
    }
  });
});
