import { afterEach, describe, expect, test } from "bun:test";
import { defaultDatabaseName, neonChildEnv, neonProjectId } from "./cli.ts";

const original = {
  NEON_API_KEY: process.env.NEON_API_KEY,
  NEON_PROJECT_ID: process.env.NEON_PROJECT_ID,
  NEON_DATABASE_NAME: process.env.NEON_DATABASE_NAME,
  DATABASE_URL: process.env.DATABASE_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("neonChildEnv", () => {
  test("replaces ambient credentials with the subject's explicit values", () => {
    process.env.NEON_API_KEY = "napi_aikya";
    process.env.NEON_PROJECT_ID = "aikya-project";

    const env = neonChildEnv({
      projectId: "subject-project",
      apiKey: "napi_subject",
    });

    expect(env.NEON_API_KEY).toBe("napi_subject");
    expect(env.NEON_PROJECT_ID).toBe("subject-project");
  });

  test("removes ambient credentials when the context omits them", () => {
    process.env.NEON_API_KEY = "napi_aikya";
    process.env.NEON_PROJECT_ID = "aikya-project";

    const env = neonChildEnv({ projectId: "subject-project" });

    expect(env.NEON_PROJECT_ID).toBe("subject-project");
    expect(env.NEON_API_KEY).toBeUndefined();
  });
});

describe("neonProjectId", () => {
  test("uses the subject project without reading the ambient one", () => {
    process.env.NEON_PROJECT_ID = "aikya-project";
    expect(neonProjectId({ projectId: "subject-project" })).toBe(
      "subject-project",
    );
  });

  test("fails closed when a context has no project id", () => {
    expect(() => neonProjectId({ apiKey: "napi_subject" })).toThrow(
      /context has no projectId/,
    );
  });
});

describe("defaultDatabaseName", () => {
  test("does not infer the subject database from Aikya's DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgres://localhost/aikya_database";
    expect(defaultDatabaseName({ projectId: "subject" })).toBe("neondb");
  });

  test("uses the context database when provided", () => {
    process.env.NEON_DATABASE_NAME = "ambient";
    expect(defaultDatabaseName({ projectId: "subject", database: "subjectdb" })).toBe(
      "subjectdb",
    );
  });
});
