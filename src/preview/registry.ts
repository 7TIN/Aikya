import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRepo } from "../github/client.ts";
import type { NeonContext } from "../neon/cli.ts";
import {
  SANDBOX_STEPS,
  type SandboxBackend,
  type SandboxStepName,
} from "./sandbox.ts";

/**
 * Workstream W2: tell Aikya which Neon project and credential belong to each
 * watched repository.
 *
 * `config/repos.json` is committed and contains no secrets. It names the
 * environment variable that holds the project key:
 *
 *   "apiKeyEnv": "NEON_API_KEY_7TIN_GH_LAB"
 *
 * `config/repos.local.json` is gitignored and replaces a committed entry by
 * `repo` (for a local checkout path or a lab project id).
 *
 * There is deliberately no fallback to `NEON_PROJECT_ID` / `NEON_API_KEY`.
 * A registered repo whose key is absent fails closed instead of borrowing
 * Aikya's credentials.
 */
export interface SubjectRepoConfig {
  repo: string;
  projectId: string;
  /** Branch inside the subject project that previews inherit from. */
  parent: string;
  /**
   * Environment variable holding the subject project's Neon API key.
   * `null` explicitly means "use the local Neon CLI login" (lab only); that
   * still scrubs any ambient `NEON_API_KEY` before the CLI runs.
   */
  apiKeyEnv: string | null;
  /** Local checkout path or git URL checked out by the sandbox. */
  source: string;
  /** Database inside the subject project. */
  database: string;
  /** Optional dotenv file merged into the sandbox environment. */
  envFrom?: string;
  /** Per-step timeout passed to the sandbox. */
  stepTimeoutMs?: number;
  /** Steps to run. Defaults to the sandbox's full step list. */
  steps?: SandboxStepName[];
  /**
   * Reserved for branch-scoped role minting. Recorded now, not applied yet:
   * the branch owner's connection string is used until the remote sandbox can
   * split migrate/test credentials.
   */
  role?: string;
  /** Execution backend. Defaults to `local`. Use `vercel` after live verification. */
  backend: SandboxBackend;
  /** vCPU count for the Vercel backend. */
  vcpus?: number;
  /** Vercel region for the Vercel backend. */
  region?: string;
  /** Vercel image reference. */
  image?: string;
  /** Vercel network policy. */
  networkPolicy?: "allow-all" | "deny-all";
  /** Vercel sandbox TTL in milliseconds. */
  sandboxTimeoutMs?: number;
}

export interface RepoRegistry {
  repos: Map<string, SubjectRepoConfig>;
  warnings: string[];
}

export interface LoadRepoRegistryOptions {
  /** Committed registry. Defaults to `<repo>/config/repos.json`. */
  path?: string;
  /** Optional local override. Defaults to `<repo>/config/repos.local.json`. */
  localPath?: string;
}

export const DEFAULT_REGISTRY_PATH = fileURLToPath(
  new URL("../../config/repos.json", import.meta.url),
);
export const DEFAULT_LOCAL_REGISTRY_PATH = fileURLToPath(
  new URL("../../config/repos.local.json", import.meta.url),
);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGitUrl(value: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(value);
}

function pathFrom(baseDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

/** `7TIN/gh-lab` → `7TIN_GH_LAB`, used to derive a per-repo key name. */
function repoEnvSegment(repo: string): string {
  return repo
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function nonEmptyString(
  value: unknown,
  field: string,
  file: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${file}: ${field} must be a non-empty string.`);
  }
  return value.trim();
}

const KNOWN_KEYS = new Set([
  "repo",
  "projectId",
  "parent",
  "apiKeyEnv",
  "source",
  "localPath",
  "database",
  "envFrom",
  "stepTimeoutMs",
  "steps",
  "role",
  "backend",
  "vcpus",
  "region",
  "image",
  "networkPolicy",
  "sandboxTimeoutMs",
]);

function parsePositiveInteger(
  value: unknown,
  field: string,
  file: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${file}: ${field} must be a positive integer.`);
  }
  return value;
}

function parseBackend(
  value: unknown,
  file: string,
  repo: string,
): SandboxBackend | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "local" || value === "vercel") return value;
  throw new Error(
    `${file}: repos[${repo}].backend must be "local" or "vercel".`,
  );
}

function parseNetworkPolicy(
  value: unknown,
  file: string,
  repo: string,
): "allow-all" | "deny-all" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "allow-all" || value === "deny-all") return value;
  throw new Error(
    `${file}: repos[${repo}].networkPolicy must be "allow-all" or "deny-all".`,
  );
}

function parseSteps(value: unknown, file: string, repo: string): SandboxStepName[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${file}: repos[${repo}].steps must be an array.`);
  }

  const steps: SandboxStepName[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !(SANDBOX_STEPS as readonly string[]).includes(entry)
    ) {
      throw new Error(
        `${file}: repos[${repo}].steps contains "${String(entry)}"; use one of ${SANDBOX_STEPS.join(", ")}.`,
      );
    }
    if (!steps.includes(entry as SandboxStepName)) {
      steps.push(entry as SandboxStepName);
    }
  }

  if (steps.length === 0) {
    throw new Error(`${file}: repos[${repo}].steps must not be empty.`);
  }
  return steps;
}

function parseEntry(
  raw: unknown,
  file: string,
  baseDir: string,
): { config: SubjectRepoConfig; warnings: string[] } {
  if (!isObject(raw)) {
    throw new Error(`${file}: every repository entry must be an object.`);
  }

  const repo = nonEmptyString(raw.repo, "repo", file);
  if (!repo) throw new Error(`${file}: every repository entry needs a repo.`);
  const normalized = parseRepo(repo);

  const warnings: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`${file}: repos[${normalized}] has unknown key "${key}"; ignored.`);
    }
  }

  const projectId = nonEmptyString(raw.projectId, "projectId", file);
  if (!projectId) {
    throw new Error(`${file}: repos[${normalized}] needs a projectId.`);
  }

  const sourceValue =
    nonEmptyString(raw.source, "source", file) ??
    nonEmptyString(raw.localPath, "localPath", file);
  if (
    raw.source !== undefined &&
    raw.localPath !== undefined &&
    raw.source !== null &&
    raw.localPath !== null
  ) {
    throw new Error(
      `${file}: repos[${normalized}] cannot set both source and localPath.`,
    );
  }

  const source = sourceValue
    ? isGitUrl(sourceValue)
      ? sourceValue
      : pathFrom(baseDir, sourceValue)
    : `https://github.com/${normalized}.git`;

  const envFrom = nonEmptyString(raw.envFrom, "envFrom", file);
  const stepTimeoutMs = parsePositiveInteger(
    raw.stepTimeoutMs,
    `repos[${normalized}].stepTimeoutMs`,
    file,
  );
  const vcpus = parsePositiveInteger(
    raw.vcpus,
    `repos[${normalized}].vcpus`,
    file,
  );
  const sandboxTimeoutMs = parsePositiveInteger(
    raw.sandboxTimeoutMs,
    `repos[${normalized}].sandboxTimeoutMs`,
    file,
  );
  const backend = parseBackend(raw.backend, file, normalized) ?? "local";
  const networkPolicy = parseNetworkPolicy(
    raw.networkPolicy,
    file,
    normalized,
  );

  const apiKeyEnv =
    raw.apiKeyEnv === null
      ? null
      : nonEmptyString(raw.apiKeyEnv, "apiKeyEnv", file) ??
        `NEON_API_KEY_${repoEnvSegment(normalized)}`;

  return {
    config: {
      repo: normalized,
      projectId,
      parent: nonEmptyString(raw.parent, "parent", file) ?? "main",
      apiKeyEnv,
      source,
      database: nonEmptyString(raw.database, "database", file) ?? "neondb",
      envFrom: envFrom ? pathFrom(baseDir, envFrom) : undefined,
      stepTimeoutMs,
      steps: parseSteps(raw.steps, file, normalized),
      role: nonEmptyString(raw.role, "role", file) ?? undefined,
      backend,
      vcpus,
      region: nonEmptyString(raw.region, "region", file) ?? undefined,
      image: nonEmptyString(raw.image, "image", file) ?? undefined,
      networkPolicy,
      sandboxTimeoutMs,
    },
    warnings,
  };
}

async function readEntryFile(
  path: string,
  required: boolean,
): Promise<{ config: SubjectRepoConfig; warnings: string[] }[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!required) return [];
    throw new Error(`Could not read repository registry ${path}: ${errorMessage(error)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${path}: invalid JSON: ${errorMessage(error)}`);
  }

  let entries: unknown;
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (isObject(raw)) {
    if (raw.version !== undefined && raw.version !== 1) {
      throw new Error(
        `${path}: unsupported version ${JSON.stringify(raw.version)}; expected 1.`,
      );
    }
    entries = raw.repos;
  }

  if (!Array.isArray(entries)) {
    throw new Error(`${path}: expected a "repos" array (or a top-level array).`);
  }

  const baseDir = dirname(path);
  const results: { config: SubjectRepoConfig; warnings: string[] }[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const parsed = parseEntry(entry, path, baseDir);
    const key = parsed.config.repo.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`${path}: duplicate repository "${parsed.config.repo}".`);
    }
    seen.add(key);
    results.push(parsed);
  }

  return results;
}

/**
 * Load the committed registry and overlay `config/repos.local.json`.
 * Local entries replace committed entries with the same `repo`.
 */
export async function loadRepoRegistry(
  options: LoadRepoRegistryOptions = {},
): Promise<RepoRegistry> {
  const path = options.path ?? DEFAULT_REGISTRY_PATH;
  const localPath = options.localPath ?? DEFAULT_LOCAL_REGISTRY_PATH;
  const warnings: string[] = [];
  const repos = new Map<string, SubjectRepoConfig>();

  const committed = await readEntryFile(path, options.path !== undefined);
  for (const entry of committed) {
    repos.set(entry.config.repo.toLowerCase(), entry.config);
    warnings.push(...entry.warnings);
  }

  const local = await readEntryFile(localPath, false);
  for (const entry of local) {
    repos.set(entry.config.repo.toLowerCase(), entry.config);
    warnings.push(...entry.warnings);
  }

  return { repos, warnings };
}

export function findSubjectRepo(
  registry: RepoRegistry,
  repo: string,
): SubjectRepoConfig | null {
  return registry.repos.get(parseRepo(repo).toLowerCase()) ?? null;
}

export function requireSubjectRepo(
  registry: RepoRegistry,
  repo: string,
): SubjectRepoConfig {
  const config = findSubjectRepo(registry, repo);
  if (config) return config;

  const configured = [...registry.repos.values()]
    .map((entry) => entry.repo)
    .sort()
    .join(", ");
  throw new Error(
    `Repository "${repo}" is not in the preview registry. Add it to config/repos.json` +
      (configured ? ` (configured: ${configured}).` : "."),
  );
}

/**
 * Resolve the key named by the registry entry. Missing key = failure, never a
 * fallback to Aikya's `NEON_API_KEY`.
 */
export function resolveSubjectNeonContext(
  config: SubjectRepoConfig,
  env: NodeJS.ProcessEnv = process.env,
): NeonContext {
  if (config.apiKeyEnv === null) {
    // Explicit lab mode: use the Neon CLI's stored login. `neonChildEnv` still
    // removes any ambient NEON_API_KEY, so this cannot borrow another key.
    return { projectId: config.projectId, database: config.database };
  }

  const apiKey = env[config.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(
      `Repository "${config.repo}" requires ${config.apiKeyEnv} to be set. ` +
        "Add the subject project's Neon API key to .env.local; Aikya will not fall back to its own key.",
    );
  }

  return {
    projectId: config.projectId,
    apiKey,
    database: config.database,
  };
}

/** Parse a small dotenv file for the optional `envFrom` sandbox overlay. */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  const text = await readFile(path, "utf8");
  const env: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match?.[1]) continue;

    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }

  return env;
}
