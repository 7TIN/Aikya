import {
  formatBytes,
  formatBytesDelta,
  formatNumber,
  formatSigned,
} from "../lib/format.ts";
import type { PreviewResult } from "./preview.ts";

/** Sticky marker so a later run updates the same PR comment. */
export const PREVIEW_COMMENT_MARKER = "<!-- db-preview-report -->";

const STATUS_LABEL: Record<PreviewResult["status"], string> = {
  ready: "✅ preview ready",
  skipped: "⏭️ preview skipped",
  deleted: "🧹 preview deleted",
  absent: "🧹 preview already absent",
  failed: "❌ preview failed",
};

function schemaLines(result: PreviewResult): string[] {
  const diff = result.report?.schemaDiff;
  if (!diff) return [];
  if (!diff.hasChanges) return ["- Schema: no changes vs parent."];

  const lines = ["- Schema changes:"];
  for (const table of diff.tablesAdded) lines.push(`  - \`+ table ${table}\``);
  for (const table of diff.tablesRemoved) lines.push(`  - \`- table ${table}\``);
  for (const change of diff.tablesChanged) {
    lines.push(`  - \`~ table ${change.table}\``);
    for (const column of change.columnsAdded) {
      lines.push(`    - \`+ column ${column}\``);
    }
    for (const column of change.columnsRemoved) {
      lines.push(`    - \`- column ${column}\``);
    }
    for (const column of change.columnsChanged) {
      lines.push(`    - \`~ column ${column.name} (${column.field})\``);
    }
    for (const index of change.indexesAdded) {
      lines.push(`    - \`+ index ${index}\``);
    }
    for (const index of change.indexesRemoved) {
      lines.push(`    - \`- index ${index}\``);
    }
  }
  for (const name of diff.enumsAdded) lines.push(`  - \`+ enum ${name}\``);
  for (const name of diff.enumsRemoved) lines.push(`  - \`- enum ${name}\``);
  for (const change of diff.enumsChanged) {
    lines.push(`  - \`~ enum ${change.name}\``);
    for (const value of change.added) lines.push(`    - \`+ value ${value}\``);
    for (const value of change.removed) lines.push(`    - \`- value ${value}\``);
  }
  return lines;
}

/** Escape characters that would break a GitHub markdown table cell. */
function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function statusDetails(result: PreviewResult): string[] {
  const lines: string[] = [];

  if (result.status === "skipped") {
    lines.push(
      "",
      "No database branch was created. Fork pull requests do not receive repository",
      "secrets, and this pipeline deliberately does not use `pull_request_target`",
      "because that would run untrusted code with access to secrets.",
      "",
      "A maintainer can run the preview manually from the base repository if needed.",
    );
    return lines;
  }

  lines.push(
    "",
    `| | |`,
    `| --- | --- |`,
    `| Database branch | \`${result.branch}\` |`,
    `| Parent | \`${result.parent}\` |`,
    `| Event | \`${result.event}\` |`,
  );

  if (result.source?.repo) {
    lines.push(`| Repository | \`${mdCell(result.source.repo)}\` |`);
  }
  if (result.source?.title) {
    const title = mdCell(result.source.title);
    const link = result.source.url
      ? `[#${result.pr} ${title}](${result.source.url})`
      : `#${result.pr} ${title}`;
    lines.push(`| Pull request | ${link} |`);
    if (result.source.author) {
      lines.push(`| Author | @${mdCell(result.source.author)} |`);
    }
  }

  if (result.expiresAt) {
    lines.push(`| Expires | \`${result.expiresAt}\` |`);
  }

  if (result.report) {
    const report = result.report;
    lines.push(
      `| Branch storage delta | ${formatBytesDelta(report.sizeDeltaBytes)} (new pages) |`,
      `| Rows | ${formatNumber(report.base.totalRows)} → ${formatNumber(report.compare.totalRows)} (${formatSigned(report.rowDelta)}) |`,
      `| Branch writes | +${formatNumber(report.branchWrites.inserts)} ins / +${formatNumber(report.branchWrites.updates)} upd / ${formatNumber(report.branchWrites.deletes)} del |`,
    );

    if (
      typeof report.logicalSizeDeltaBytes === "number" &&
      typeof report.estimatedBranchStorageBytes === "number"
    ) {
      lines.push(
        `| Estimated billed storage | ~${formatBytes(report.estimatedBranchStorageBytes)} |`,
      );
    }
  }

  if (result.tests?.ran) {
    const passed = result.tests.passed ?? 0;
    const failed = result.tests.failed ?? 0;
    const mark = result.tests.exitCode === 0 ? "✅" : "❌";
    lines.push(
      `| Tests | ${mark} ${formatNumber(passed)} passed, ${formatNumber(failed)} failed |`,
    );
  }

  lines.push("");

  if (result.report) {
    lines.push(...schemaLines(result));
  }

  if (result.error) {
    lines.push("", "```text", result.error, "```");
  }

  const failedStep = result.steps.find((step) => step.status === "failed");
  if (failedStep?.detail) {
    lines.push(
      "",
      "<details><summary>Failure output</summary>",
      "",
      "```text",
      failedStep.detail,
      "```",
      "",
      "</details>",
    );
  }

  lines.push(
    "",
    `<sub>Artifacts: \`artifacts/preview/pr-${result.pr}/report.json\` and \`comment.md\`.</sub>`,
  );

  return lines;
}

/**
 * Render the sticky PR comment. The marker is always first so a later job can
 * find and update the existing comment instead of creating a new one.
 */
export function renderPreviewComment(result: PreviewResult): string {
  const header = `### ${STATUS_LABEL[result.status]}`;
  const reason = result.reason ? `\n_${result.reason}_` : "";
  return [
    PREVIEW_COMMENT_MARKER,
    header + reason,
    ...statusDetails(result),
    "",
  ].join("\n");
}
