import { describe, expect, test } from "bun:test";
import {
  assertSafeCommand,
  isTextBuffer,
  QaGuardError,
  resolveInside,
  safeRelPath,
} from "./guard.ts";

describe("safeRelPath", () => {
  test("accepts repository-relative paths", () => {
    expect(safeRelPath("src/index.ts")).toBe("src/index.ts");
    expect(safeRelPath("./src/qa/tools.ts")).toBe("src/qa/tools.ts");
    expect(safeRelPath("src\\qa\\agent.ts")).toBe("src/qa/agent.ts");
    expect(safeRelPath(".")).toBe("");
  });

  test("rejects traversal and absolute paths", () => {
    expect(() => safeRelPath("../secret")).toThrow(QaGuardError);
    expect(() => safeRelPath("src/../../secret")).toThrow(QaGuardError);
    expect(() => safeRelPath("/etc/passwd")).toThrow(QaGuardError);
    expect(() => safeRelPath("C:\\Windows\\win.ini")).toThrow(QaGuardError);
  });

  test("rejects dotenv, git, dependency, and build paths", () => {
    for (const path of [
      ".env",
      ".env.local",
      "src/.env.production",
      ".git/config",
      "node_modules/pkg/index.js",
      "dist/index.js",
      "artifacts/events.jsonl",
    ]) {
      expect(() => safeRelPath(path)).toThrow(QaGuardError);
    }
  });

  test("keeps resolved paths inside the root", () => {
    expect(resolveInside("D:\\repo", "src/index.ts")).toContain("src");
    expect(() => resolveInside("D:\\repo", "..\\escape")).toThrow();
  });
});

describe("assertSafeCommand", () => {
  test("allows the QA workflow commands", () => {
    for (const command of [
      "bun install --frozen-lockfile",
      "bun test",
      "bun test src/qa/agent.test.ts",
      "bun test src/neon/prune.test.ts",
      "bun run typecheck",
      "bun run build",
      "bun check",
      "git status",
      "git diff --stat",
      "rg preview src/github",
      "cat src/index.ts",
    ]) {
      expect(assertSafeCommand(command)).toBe(command);
    }
  });

  test("rejects mutations, network, secrets, and unknown commands", () => {
    for (const command of [
      "git push origin main",
      "git commit -am x",
      "rm -rf src",
      "bun add left-pad",
      "npm publish",
      "curl https://example.com",
      "cat .env",
      "printenv",
      "psql $DATABASE_URL",
      "sed -i s/a/b/ src/index.ts",
      "bun x evil",
      "bash -c whoami",
      "bun run dev",
      "bun run branch:reap --yes",
      "neon branches list",
    ]) {
      expect(() => assertSafeCommand(command)).toThrow(QaGuardError);
    }
  });

  test("rejects shell chaining and redirection", () => {
    for (const command of [
      "bun test; rm -rf src",
      "bun test && git push",
      "bun test | cat",
      "bun test > out.txt",
      "bun test $(whoami)",
      "bun test `whoami`",
    ]) {
      expect(() => assertSafeCommand(command)).toThrow(QaGuardError);
    }
  });

  test("rejects multi-line, absolute, and traversal commands", () => {
    expect(() => assertSafeCommand("bun test\nrm -rf /")).toThrow(QaGuardError);
    expect(() => assertSafeCommand("cat /etc/passwd")).toThrow(QaGuardError);
    expect(() => assertSafeCommand("cat ../secret")).toThrow(QaGuardError);
    expect(() => assertSafeCommand("bun test " + "a".repeat(5_000))).toThrow(
      QaGuardError,
    );
  });
});

describe("isTextBuffer", () => {
  test("detects NUL bytes", () => {
    expect(isTextBuffer(Buffer.from("hello"))).toBe(true);
    expect(isTextBuffer(Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
  });
});
