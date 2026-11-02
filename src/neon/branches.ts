import {
  defaultDatabaseName,
  neonProjectId,
  runNeon,
  runNeonJson,
} from "./cli.ts";

export interface NeonBranch {
  id: string;
  name: string;
  projectId: string;
  default: boolean;
  primary: boolean;
  protected: boolean;
  currentState: string;
  stateChangedAt: string;
  createdAt: string;
  updatedAt: string;
  /** Neon's logical size for the whole branch (all databases, inherited + local). */
  logicalSize: number;
  writtenDataBytes: number;
  cpuUsedSec: number;
  computeTimeSeconds: number;
  parentId?: string;
  parentName?: string;
}

interface RawBranch {
  id: string;
  name: string;
  project_id: string;
  default: boolean;
  primary: boolean;
  protected?: boolean;
  current_state: string;
  state_changed_at?: string;
  created_at: string;
  updated_at: string;
  logical_size?: number;
  written_data_bytes?: number;
  cpu_used_sec?: number;
  compute_time_seconds?: number;
  parent_id?: string;
  parent_name?: string;
}

function toBranch(raw: RawBranch): NeonBranch {
  return {
    id: raw.id,
    name: raw.name,
    projectId: raw.project_id,
    default: Boolean(raw.default),
    primary: Boolean(raw.primary),
    protected: Boolean(raw.protected),
    currentState: raw.current_state,
    stateChangedAt: raw.state_changed_at ?? "",
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    logicalSize: Number(raw.logical_size ?? 0),
    writtenDataBytes: Number(raw.written_data_bytes ?? 0),
    cpuUsedSec: Number(raw.cpu_used_sec ?? 0),
    computeTimeSeconds: Number(raw.compute_time_seconds ?? 0),
    parentId: raw.parent_id,
    parentName: raw.parent_name,
  };
}

export async function listBranches(): Promise<NeonBranch[]> {
  const raw = await runNeonJson<RawBranch[]>([
    "branch",
    "list",
    "--project-id",
    neonProjectId(),
  ]);

  return raw
    .map(toBranch)
    .sort((a, b) => {
      if (a.default !== b.default) return a.default ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export async function getBranch(name: string): Promise<NeonBranch> {
  const raw = await runNeonJson<RawBranch | RawBranch[]>([
    "branch",
    "get",
    name,
    "--project-id",
    neonProjectId(),
  ]);

  const branch = Array.isArray(raw) ? raw[0] : raw;
  if (!branch) throw new Error(`Branch "${name}" was not found`);
  return toBranch(branch);
}

export async function waitForBranchReady(
  name: string,
  timeoutMs = 120_000,
): Promise<NeonBranch> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const branch = await getBranch(name);
    if (branch.currentState === "ready") return branch;
    if (["failed", "deleted"].includes(branch.currentState)) {
      throw new Error(`Branch "${name}" entered state "${branch.currentState}"`);
    }
    await Bun.sleep(2_000);
  }

  throw new Error(`Timed out waiting for branch "${name}" to become ready`);
}

export interface CreateBranchOptions {
  name: string;
  parent?: string;
  expiresAt?: string;
}

export async function createBranch(
  options: CreateBranchOptions,
): Promise<NeonBranch> {
  const args = [
    "branch",
    "create",
    "--project-id",
    neonProjectId(),
    "--name",
    options.name,
    "--parent",
    options.parent ?? "main",
    "--no-secrets",
  ];

  if (options.expiresAt) {
    args.push("--expires-at", options.expiresAt);
  }

  await runNeon([...args, "-o", "json"]);
  return waitForBranchReady(options.name);
}

export async function deleteBranch(name: string): Promise<void> {
  await runNeon([
    "branch",
    "delete",
    name,
    "--project-id",
    neonProjectId(),
  ]);
}

/** Connection string for a branch, using the CLI (works with claimed projects). */
export async function branchConnectionString(
  branch: string,
  options: { pooled?: boolean } = {},
): Promise<string> {
  const args = [
    "connection-string",
    branch,
    "--project-id",
    neonProjectId(),
    "--database-name",
    defaultDatabaseName(),
  ];

  if (options.pooled) args.push("--pooled");

  const output = await runNeon(args);
  const line = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith("postgres"));

  if (!line) {
    throw new Error(
      `Neon CLI did not return a connection string for branch "${branch}":\n${output}`,
    );
  }

  return line;
}

/**
 * Neon's own schema diff between two branches. Useful as a second opinion
 * next to the local information_schema diff in the report.
 */
export async function neonSchemaDiff(
  baseBranch: string,
  compareBranch: string,
): Promise<string | null> {
  try {
    const output = await runNeon([
      "branch",
      "schema-diff",
      baseBranch,
      compareBranch,
      "--project-id",
      neonProjectId(),
    ]);
    return output.trim() || null;
  } catch {
    // Not fatal: the local diff is the source of truth for the report.
    return null;
  }
}
