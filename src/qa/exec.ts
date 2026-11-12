import type { QaCommandResult } from "./types.ts";

/**
 * Minimal shell runner shared by the local sandbox and the deterministic
 * checks. Output is capped from the tail because build/test failures are most
 * useful at the end.
 */

export interface RunShellOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputChars?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

function killTree(pid: number | undefined): void {
  if (!pid) return;

  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process already exited.
  }
}

async function readTail(
  stream: ReadableStream<Uint8Array> | undefined,
  maxChars: number,
): Promise<string> {
  if (!stream) return "";

  const decoder = new TextDecoder();
  let text = "";

  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > maxChars) text = text.slice(-maxChars);
  }

  text += decoder.decode();
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function shellCommand(command: string): string[] {
  if (process.platform === "win32") {
    return [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command];
  }
  return ["/bin/sh", "-c", command];
}

export async function runShell(
  command: string,
  options: RunShellOptions,
): Promise<QaCommandResult> {
  const startedAt = Date.now();
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const timeoutMs = options.timeoutMs ?? 180_000;

  if (options.signal?.aborted) {
    return {
      command,
      exitCode: 130,
      stdout: "",
      stderr: "cancelled before start",
      timedOut: false,
      cancelled: true,
      durationMs: 0,
    };
  }

  const proc = Bun.spawn(shellCommand(command), {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let cancelled = false;

  const onAbort = () => {
    cancelled = true;
    killTree(proc.pid);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree(proc.pid);
        }, timeoutMs)
      : undefined;

  const stdoutPromise = readTail(
    proc.stdout as unknown as ReadableStream<Uint8Array>,
    maxOutputChars,
  );
  const stderrPromise = readTail(
    proc.stderr as unknown as ReadableStream<Uint8Array>,
    maxOutputChars,
  );

  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  return {
    command,
    exitCode: timedOut ? 124 : cancelled ? 130 : exitCode,
    stdout,
    stderr,
    timedOut,
    cancelled,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}
