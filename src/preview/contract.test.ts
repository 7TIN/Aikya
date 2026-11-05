import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PreviewContractError,
  resolvePreviewContract,
} from "./contract.ts";

const roots: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aikya-contract-"));
  roots.push(root);

  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("resolvePreviewContract — manifest tier", () => {
  test("manifest commands override detection and merge the rest", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        packageManager: "npm@10.8.0",
        scripts: { test: "node --test", build: "tsc" },
        dependencies: { "@neondatabase/serverless": "^1.0.0" },
      }),
      "bun.lock": "",
      "drizzle.config.ts": 'export default { out: "./db/migrations" };',
      ".env.example": "DATABASE_URL=\nSESSION_SECRET=\n",
      ".aikya/preview.yml": [
        "version: 1",
        "commands:",
        "  install: bun install --frozen-lockfile",
        "  test: bun test",
        "app:",
        "  command: bun run dev",
        "  port: 4000",
        "env:",
        "  required: [DATABASE_URL]",
        "",
      ].join("\n"),
    });

    const contract = await resolvePreviewContract(root);

    expect(contract.source).toBe("manifest");
    expect(contract.manifestPath).toBe(".aikya/preview.yml");
    expect(contract.install).toBe("bun install --frozen-lockfile");
    expect(contract.test).toBe("bun test");
    // Omitted commands fall back to detection.
    expect(contract.build).toBe("npm run build");
    expect(contract.migrate).toBeNull();
    expect(contract.app).toEqual({ command: "bun run dev", port: 4000 });
    expect(contract.migrationsDir).toBe("db/migrations");
    expect(contract.database).toEqual({ required: true, provider: "neon" });
    expect(contract.envRequired).toEqual(["DATABASE_URL", "SESSION_SECRET"]);
    expect(contract.warnings.some((line) => line.includes("no db:migrate"))).toBe(
      true,
    );
  });

  test("supports a JSON manifest without package.json", async () => {
    const root = await fixture({
      ".aikya/preview.json": JSON.stringify({
        version: 1,
        runtime: "node",
        packageManager: "npm",
        commands: { install: "npm ci", test: "npm test" },
        database: { required: false },
      }),
    });

    const contract = await resolvePreviewContract(root);

    expect(contract.source).toBe("manifest");
    expect(contract.manifestPath).toBe(".aikya/preview.json");
    expect(contract.runtime).toBe("node");
    expect(contract.packageManager).toBe("npm");
    expect(contract.install).toBe("npm ci");
    expect(contract.test).toBe("npm test");
    expect(contract.database.required).toBe(false);
    expect(
      contract.warnings.some((line) => line.includes("No package.json")),
    ).toBe(true);
  });

  test("warns about unknown manifest keys but keeps the valid ones", async () => {
    const root = await fixture({
      "package.json": "{}",
      ".aikya/preview.yml": [
        "version: 1",
        "unknownThing: true",
        "commands:",
        "  test: echo ok",
        "  deploy: echo nope",
        "",
      ].join("\n"),
    });

    const contract = await resolvePreviewContract(root);

    expect(contract.test).toBe("echo ok");
    expect(
      contract.warnings.some((line) => line.includes('"unknownThing"')),
    ).toBe(true);
    expect(
      contract.warnings.some((line) => line.includes('"commands.deploy"')),
    ).toBe(true);
  });
});

describe("resolvePreviewContract — detection tier", () => {
  test("detects a Bun project with Drizzle migrations", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        scripts: {
          dev: "bun run src/index.ts",
          build: "bun build src/index.ts",
          test: "bun test",
          "db:migrate": "bun run src/db/migrate.ts",
          "db:seed": "bun run src/db/seed.ts",
        },
        dependencies: { postgres: "^4.0.0" },
      }),
      "bun.lock": "",
      "drizzle.config.ts": 'export default { out: "./drizzle" };',
      ".env.example": [
        "# Database",
        "DATABASE_URL=",
        "",
        "export SESSION_SECRET=",
        "DATABASE_URL=duplicate",
        "",
      ].join("\n"),
    });

    const contract = await resolvePreviewContract(root);

    expect(contract.source).toBe("detected");
    expect(contract.manifestPath).toBeNull();
    expect(contract.runtime).toBe("bun");
    expect(contract.packageManager).toBe("bun");
    expect(contract.install).toBe("bun install --frozen-lockfile");
    expect(contract.migrate).toBe("bun run db:migrate");
    expect(contract.seed).toBe("bun run db:seed");
    expect(contract.build).toBe("bun run build");
    expect(contract.test).toBe("bun run test");
    expect(contract.app).toEqual({ command: "bun run dev", port: 3000 });
    expect(contract.migrationsDir).toBe("drizzle");
    expect(contract.envRequired).toEqual(["DATABASE_URL", "SESSION_SECRET"]);
    expect(contract.database).toEqual({ required: true, provider: "postgres" });
    expect(
      contract.warnings.some((line) => line.includes("No .aikya/preview.yml")),
    ).toBe(true);
    expect(
      contract.warnings.some((line) => line.includes("assuming 3000")),
    ).toBe(true);
  });

  test("uses npm ci for a package-lock project", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        scripts: { test: "node --test" },
      }),
      "package-lock.json": "{}",
    });

    const contract = await resolvePreviewContract(root);

    expect(contract.packageManager).toBe("npm");
    expect(contract.runtime).toBe("node");
    expect(contract.install).toBe("npm ci");
    expect(contract.test).toBe("npm run test");
    expect(contract.database.required).toBe(false);
  });

  test("assumes npm when no lockfile or packageManager is present", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({ scripts: { test: "echo ok" } }),
    });

    const contract = await resolvePreviewContract(root);

    expect(contract.packageManager).toBe("npm");
    expect(contract.install).toBe("npm ci");
    expect(
      contract.warnings.some((line) => line.includes("assuming npm")),
    ).toBe(true);
  });
});

describe("resolvePreviewContract — fail closed", () => {
  test("rejects a directory with neither a manifest nor package.json", async () => {
    const root = await fixture({ "README.md": "# empty\n" });

    await expect(resolvePreviewContract(root)).rejects.toThrow(
      PreviewContractError,
    );
    await expect(resolvePreviewContract(root)).rejects.toThrow(
      /No preview contract found/,
    );
  });

  test("rejects an unsupported manifest version", async () => {
    const root = await fixture({
      "package.json": "{}",
      ".aikya/preview.yml": "version: 2\n",
    });

    await expect(resolvePreviewContract(root)).rejects.toThrow(
      /unsupported version 2/,
    );
  });

  test("rejects a non-string command with the field name", async () => {
    const root = await fixture({
      "package.json": "{}",
      ".aikya/preview.yml": "version: 1\ncommands:\n  test: 42\n",
    });

    await expect(resolvePreviewContract(root)).rejects.toThrow(
      /commands\.test must be a non-empty string/,
    );
  });

  test("rejects invalid package.json", async () => {
    const root = await fixture({ "package.json": "{ not json" });

    await expect(resolvePreviewContract(root)).rejects.toThrow(
      /package\.json: invalid JSON/,
    );
  });

  test("rejects an invalid env variable name", async () => {
    const root = await fixture({
      "package.json": "{}",
      ".aikya/preview.yml":
        "version: 1\nenv:\n  required: ['NOT A NAME']\n",
    });

    await expect(resolvePreviewContract(root)).rejects.toThrow(
      /env\.required contains an invalid name/,
    );
  });
});
