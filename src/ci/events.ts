/**
 * GitHub pull_request events, reduced to the subset this pipeline handles.
 * Kept free of GitHub API types so the flow can be simulated locally.
 */
export const PREVIEW_EVENTS = [
  "opened",
  "synchronize",
  "reopened",
  "closed",
] as const;

export type PreviewEvent = (typeof PREVIEW_EVENTS)[number];

export type PreviewAction = "create" | "recreate" | "delete" | "skip";

export interface PreviewPlan {
  event: PreviewEvent;
  action: PreviewAction;
  reason: string;
}

const PREVIEW_PREFIX = "preview/";

export function parsePreviewEvent(value: string): PreviewEvent {
  const event = value.trim().toLowerCase();
  if ((PREVIEW_EVENTS as readonly string[]).includes(event)) {
    return event as PreviewEvent;
  }
  throw new Error(
    `Unsupported event "${value}". Use one of: ${PREVIEW_EVENTS.join(", ")}.`,
  );
}

export function parsePullRequestNumber(value: string | number): number {
  const text = String(value).trim().replace(/^#/, "");
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `Invalid pull request number "${value}". Pass a positive integer, for example --pr 123.`,
    );
  }

  const number = Number(text);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(
      `Pull request number "${value}" must be a positive integer.`,
    );
  }

  return number;
}

/**
 * Turn an arbitrary label into a valid Neon branch name segment.
 * Lowercase letters, digits, `/`, `_`, and `-` only; no leading/trailing
 * separators; at most 63 characters.
 */
export function sanitizeBranchName(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^[-/]+/, "")
    .replace(/[-/]+$/, "")
    .slice(0, 63)
    .replace(/[-/]+$/, "");

  if (!cleaned) {
    throw new Error(
      `Branch name "${value}" is empty after sanitization. Use letters, digits, or -/_//.`,
    );
  }

  return cleaned;
}

export function previewBranchPrefix(): string {
  return PREVIEW_PREFIX;
}

/**
 * Preview branches are derived from the PR number, never from the contributor's
 * branch name. That keeps names predictable and avoids collisions/injection.
 * A custom `name` is still sanitized.
 */
export function previewBranchName(pr: number, name?: string): string {
  if (name) return sanitizeBranchName(name);
  return `${PREVIEW_PREFIX}pr-${parsePullRequestNumber(pr)}`;
}

/**
 * Decide what the pipeline should do for an event.
 *
 * Fork PRs never reach the create path: GitHub does not expose repository
 * secrets to `pull_request` runs from forks, and using `pull_request_target`
 * to regain them would run untrusted code with secrets. `closed` is safe
 * because it only deletes a branch.
 */
export function planPreview(
  event: PreviewEvent,
  options: { fork?: boolean } = {},
): PreviewPlan {
  if (event === "closed") {
    return {
      event,
      action: "delete",
      reason: "pull request closed; remove its preview branch",
    };
  }

  if (options.fork) {
    return {
      event,
      action: "skip",
      reason:
        "fork pull requests do not receive repository secrets, so no preview branch is created",
    };
  }

  if (event === "opened" || event === "reopened") {
    return {
      event,
      action: "create",
      reason: "create a fresh preview branch for the pull request",
    };
  }

  return {
    event,
    action: "recreate",
    reason: "synchronize replaces the branch so no stale schema or data survives",
  };
}
