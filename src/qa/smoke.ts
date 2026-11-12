import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxEnv } from "../preview/sandbox.ts";
import type { QaCheckResult, QaSandbox } from "./types.ts";

/**
 * HTTP smoke check: boot the real server from the QA checkout on an ephemeral
 * port and probe the dashboard plus the JSON APIs that do not need Neon.
 *
 * Only the local backend runs this. The remote backend would need detached
 * commands and a public port, which is more moving parts than the check is
 * worth; the deterministic typecheck/test/build checks still run there.
 */

const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;

const PROBES = [
  { path: "/", kind: "dashboard" },
  { path: "/api/watch", kind: "json" },
  { path: "/api/events", kind: "json" },
  { path: "/api/health", kind: "json" },
] as const;

interface ProbeOutcome {
  path: string;
  ok: boolean;
  detail: string;
}

function tail(text: string, maxChars = 4_000): string {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

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
    // Already exited.
  }
}

/** Reserve an ephemeral port by binding and immediately releasing it. */
function freePort(): number {
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(""),
  });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error("could not reserve an ephemeral port");
  return port;
}

async function waitForServer(
  base: string,
  proc: { exitCode: number | null },
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false;
    try {
      const response = await fetch(`${base}/api/watch`, {
        signal: AbortSignal.timeout(1_500),
      });
      await response.text();
      return true;
    } catch {
      await Bun.sleep(150);
    }
  }
  return false;
}

async function probeDashboard(base: string, path: string): Promise<ProbeOutcome> {
  try {
    const response = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const type = response.headers.get("content-type") ?? "";
    const body = await response.text();

    if (response.status !== 200) {
      return { path, ok: false, detail: `status ${response.status}` };
    }
    if (!type.includes("text/html")) {
      return { path, ok: false, detail: `content-type ${type || "(none)"}` };
    }
    if (!body.includes("Event log")) {
      return {
        path,
        ok: false,
        detail: "dashboard body is missing the Event log section",
      };
    }
    return { path, ok: true, detail: `200 html (${body.length} bytes)` };
  } catch (error) {
    return {
      path,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeJson(base: string, path: string): Promise<ProbeOutcome> {
  try {
    const response = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return {
        path,
        ok: false,
        detail: `status ${response.status}, body is not JSON: ${body.slice(0, 120)}`,
      };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { path, ok: false, detail: "response is not a JSON object" };
    }
    return { path, ok: true, detail: `status ${response.status}, JSON object` };
  } catch (error) {
    return {
      path,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeEcho(base: string): Promise<ProbeOutcome> {
  try {
    const response = await fetch(`${base}/api/echo`, {
      method: "POST",
      body: "aikya-qa-smoke",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const value = (await response.json()) as { received?: unknown };
    if (value.received !== "aikya-qa-smoke") {
      return { path: "/api/echo", ok: false, detail: "POST body was not echoed" };
    }
    return { path: "/api/echo", ok: true, detail: "200 echo" };
  } catch (error) {
    return {
      path: "/api/echo",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface RunQaSmokeOptions {
  log?: (line: string) => void;
}

export async function runQaSmoke(
  sandbox: QaSandbox,
  options: RunQaSmokeOptions = {},
): Promise<QaCheckResult> {
  const log = options.log ?? (() => {});
  const startedAt = Date.now();
  const name = "smoke";
  const command = "bun src/index.ts (http probe)";

  if (sandbox.kind !== "local") {
    return {
      name,
      command,
      status: "skipped",
      exitCode: null,
      durationMs: 0,
      output: `HTTP smoke runs only on the local backend (sandbox: ${sandbox.kind}).`,
    };
  }

  const port = freePort();
  const env = sandboxEnv({
    PORT: String(port),
    HOST: "127.0.0.1",
    AIKYA_EVENT_LOG: join(
      tmpdir(),
      `aikya-qa-smoke-${process.pid}-${Date.now()}.jsonl`,
    ),
  });

  log(`[qa] ${name}: booting the server on ${port}`);
  const proc = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: sandbox.root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdoutText = "";
  let stderrText = "";
  const stdoutDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as unknown as ReadableStream<Uint8Array>) {
      stdoutText = tail(stdoutText + decoder.decode(chunk, { stream: true }));
    }
  })();
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as unknown as ReadableStream<Uint8Array>) {
      stderrText = tail(stderrText + decoder.decode(chunk, { stream: true }));
    }
  })();

  const base = `http://127.0.0.1:${port}`;

  try {
    const ready = await waitForServer(base, proc, READY_TIMEOUT_MS);
    if (!ready) {
      return {
        name,
        command,
        status: "failed",
        exitCode: proc.exitCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        output:
          `server did not become ready within ${READY_TIMEOUT_MS}ms` +
          `\n${tail([stdoutText, stderrText].filter(Boolean).join("\n"))}`,
      };
    }

    const outcomes: ProbeOutcome[] = [];
    for (const probe of PROBES) {
      outcomes.push(
        probe.kind === "dashboard"
          ? await probeDashboard(base, probe.path)
          : await probeJson(base, probe.path),
      );
    }
    outcomes.push(await probeEcho(base));

    const failed = outcomes.filter((outcome) => !outcome.ok);
    const output = [
      `listening on ${base}`,
      ...outcomes.map(
        (outcome) =>
          `${outcome.ok ? "ok" : "fail"} ${outcome.path} — ${outcome.detail}`,
      ),
    ].join("\n");

    return {
      name,
      command,
      status: failed.length === 0 ? "ok" : "failed",
      exitCode: failed.length === 0 ? 0 : 1,
      durationMs: Math.max(0, Date.now() - startedAt),
      output,
    };
  } finally {
    killTree(proc.pid);
    await Promise.allSettled([stdoutDone, stderrDone]);
  }
}
