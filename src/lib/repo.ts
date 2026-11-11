/**
 * Repository-name helpers shared by the watcher, the quota guard, and the
 * dashboard. Kept dependency-free so `preview/quota.ts` can use it without
 * importing the watcher (which imports the preview runner).
 */

/** `7TIN/gh-lab` → `7tin-gh-lab`, used to namespace branches and artifacts. */
export function repoSegment(repo: string): string {
  const segment = repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return segment || "repo";
}

/** Branch-name prefix owned by one watched repository. */
export function previewBranchPrefix(repo: string): string {
  return `preview/${repoSegment(repo)}-pr-`;
}

/** True when `branch` is a preview branch this repository owns. */
export function isPreviewBranchFor(repo: string, branch: string): boolean {
  return branch.startsWith(previewBranchPrefix(repo));
}
