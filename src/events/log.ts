import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * W4: append-only event log for branch, sync, sandbox, and reviewer activity.
 *
 * Events are JSONL so they can be tailed, filtered, and joined later without a
 * database. Nothing here mutates branch state; it only records what happened.
 */

export const EVENT_TYPES = [
  "branch.created",
  "branch.deleted",
  "branch.reset",
  "branch.report",
  "sync.started",
  "sync.finished",
  "sandbox.created",
  "sandbox.deleted",
  "review.completed",
  "quota.exceeded",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface AikyaEvent {
  id: string;
  type: EventType;
  at: string;
  repo?: string;
  pr?: number;
  branch?: string;
  headSha?: string;
  status?: string;
  durationMs?: number;
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface AppendEventOptions {
  type: EventType;
  repo?: string;
  pr?: number;
  branch?: string;
  headSha?: string;
  status?: string;
  durationMs?: number;
  reason?: string;
  detail?: Record<string, unknown>;
  now?: number;
}

export interface LoadEventLogOptions {
  /** Only return events at or after this ISO timestamp. */
  since?: string;
  /** Filter by repository (`owner/name`). */
  repo?: string;
  /** Filter by branch name. */
  branch?: string;
  /** Maximum number of events, newest first. */
  limit?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eventId(type: string, at: string, branch?: string, pr?: number): string {
  const seed = `${type}|${at}|${branch ?? ""}|${pr ?? ""}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

/** Coerce an unknown JSON value into an event, or null when it is not one. */
export function normalizeEvent(raw: unknown): AikyaEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.type !== "string" || !EVENT_TYPES.includes(value.type as EventType)) {
    return null;
  }
  if (typeof value.at !== "string") return null;

  return {
    id: typeof value.id === "string" ? value.id : eventId(value.type, value.at),
    type: value.type as EventType,
    at: value.at,
    repo: typeof value.repo === "string" ? value.repo : undefined,
    pr: typeof value.pr === "number" ? value.pr : undefined,
    branch: typeof value.branch === "string" ? value.branch : undefined,
    headSha: typeof value.headSha === "string" ? value.headSha : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    detail:
      typeof value.detail === "object" && value.detail !== null
        ? (value.detail as Record<string, unknown>)
        : undefined,
  };
}

export class EventLog {
  constructor(readonly path: string) {}

  async append(options: AppendEventOptions): Promise<AikyaEvent> {
    const at = new Date(options.now ?? Date.now()).toISOString();
    const event: AikyaEvent = {
      id: eventId(options.type, at, options.branch, options.pr),
      type: options.type,
      at,
      repo: options.repo,
      pr: options.pr,
      branch: options.branch,
      headSha: options.headSha,
      status: options.status,
      durationMs: options.durationMs,
      reason: options.reason,
      detail: options.detail,
    };

    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  async load(options: LoadEventLogOptions = {}): Promise<AikyaEvent[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }

    const events: AikyaEvent[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = normalizeEvent(JSON.parse(line) as unknown);
        if (!event) continue;
        if (options.since && event.at < options.since) continue;
        if (options.repo && event.repo !== options.repo) continue;
        if (options.branch && event.branch !== options.branch) continue;
        events.push(event);
      } catch {
        // Skip malformed lines; the log is append-only and best-effort.
      }
    }

    events.sort((left, right) => (left.at < right.at ? 1 : -1));
    return options.limit ? events.slice(0, options.limit) : events;
  }

  async recentForBranch(branch: string, limit = 20): Promise<AikyaEvent[]> {
    return this.load({ branch, limit });
  }

  async recent(limit = 50): Promise<AikyaEvent[]> {
    return this.load({ limit });
  }
}

export function defaultEventLogPath(): string {
  const override = process.env.AIKYA_EVENT_LOG?.trim();
  if (override) return override;
  return `${process.cwd().replace(/\\/g, "/").replace(/\/+$/, "")}/artifacts/events.jsonl`;
}

export function createEventLog(path: string = defaultEventLogPath()): EventLog {
  return new EventLog(path);
}
