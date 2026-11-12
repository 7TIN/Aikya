/**
 * W5: the Aikya QA agent.
 *
 * The agent is deliberately small. It runs a bounded tool loop on the host and
 * executes every tool against a disposable checkout — either a local temp
 * workspace or a dedicated Vercel Sandbox. The preview sandbox is never reused
 * for QA, and the model never receives Neon, GitHub, or Vercel credentials.
 */

export type QaSandboxKind = "local" | "vercel";

export type QaRunStatus = "ok" | "fixed" | "failed" | "error";

export interface QaCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface QaRunOptions {
  timeoutMs?: number;
  /** Maximum characters retained from each stream. */
  maxOutputChars?: number;
  signal?: AbortSignal;
}

export interface QaReadOptions {
  /** Maximum characters retained from the start of the file. */
  maxChars?: number;
}

/**
 * The execution surface the tools see. Implementations are
 * `LocalQaSandbox` (temp checkout) and `VercelQaSandbox` (remote MicroVM).
 */
export interface QaSandbox {
  readonly kind: QaSandboxKind;
  readonly name: string;
  /** Repository root inside the sandbox (for display only). */
  readonly root: string;
  run(command: string, options?: QaRunOptions): Promise<QaCommandResult>;
  read(path: string, options?: QaReadOptions): Promise<string>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(path?: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  /** Unified patch of everything the agent changed, relative to the baseline. */
  diff(): Promise<string>;
  close(): Promise<void>;
}

export interface QaCheckResult {
  name: string;
  command: string;
  status: "ok" | "failed" | "skipped";
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface QaStep {
  index: number;
  at: string;
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  summary: string;
  durationMs: number;
  output: string;
}

export interface QaUsage {
  steps: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface QaReport {
  id: string;
  mode: "checks" | "agent";
  sandbox: QaSandboxKind;
  model: string | null;
  startedAt: string;
  finishedAt: string;
  status: QaRunStatus;
  reason: string | null;
  checks: QaCheckResult[];
  steps: QaStep[];
  filesChanged: string[];
  patchPath: string | null;
  patch: string;
  summary: string | null;
  usage: QaUsage;
}
