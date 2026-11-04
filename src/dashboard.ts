export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>db-branch · Neon branching lab</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d12;
    --panel: #12151d;
    --panel-2: #171b25;
    --border: #252b38;
    --text: #eef1f7;
    --muted: #8b93a7;
    --accent: #6ee7b7;
    --accent-2: #60a5fa;
    --warn: #fbbf24;
    --bad: #f87171;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: radial-gradient(1200px 600px at 10% -10%, #16243a 0%, var(--bg) 55%);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.5;
  }
  main { max-width: 1080px; margin: 0 auto; padding: 40px 20px 80px; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -0.02em; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); margin: 32px 0 12px; }
  .sub { color: var(--muted); margin: 0; }
  .pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 7px 12px; border: 1px solid var(--border); border-radius: 999px;
    background: var(--panel); font-size: 13px; color: var(--muted);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); }
  .dot.ok { background: var(--accent); box-shadow: 0 0 12px var(--accent); }
  .dot.bad { background: var(--bad); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 24px; }
  .card {
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--border); border-radius: 14px; padding: 16px;
  }
  .card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
  .card .value { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; margin-top: 6px; }
  .card .hint { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
  tr:last-child td { border-bottom: 0; }
  td.num { font-variant-numeric: tabular-nums; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--border); color: var(--muted); }
  .tag.default { color: var(--accent); border-color: #1f6f57; background: #0d2a22; }
  .tag.ready { color: var(--accent); border-color: #1f6f57; background: #0d2a22; }
  .tag.skipped, .tag.absent, .tag.branch-only { color: var(--warn); border-color: #6b5518; background: #2a230d; }
  .tag.failed { color: var(--bad); border-color: #7f2a2a; background: #2a1111; }
  .tag.deleted, .tag.unknown { color: var(--muted); }
  .count { color: var(--muted); font-size: 12px; font-weight: 400; letter-spacing: 0; text-transform: none; margin-left: 6px; }
  .error { color: var(--bad); }
  .empty { padding: 18px; color: var(--muted); font-size: 13px; }
  button {
    background: #1b2230; color: var(--text); border: 1px solid var(--border);
    padding: 5px 10px; border-radius: 8px; cursor: pointer; font-size: 12px;
  }
  button:hover { border-color: #3a465e; background: #202938; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  button.danger { border-color: #7f2a2a; color: #fca5a5; }
  button.danger:hover:not(:disabled) { background: #2a1111; border-color: #b91c1c; }
  .actions { display: inline-flex; gap: 6px; }
  pre {
    margin: 0; padding: 16px; background: #0a0c11; border-top: 1px solid var(--border);
    overflow: auto; font-size: 12px; line-height: 1.55; color: #cbd5e1; max-height: 520px;
  }
  a { color: var(--accent-2); }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>db-branch</h1>
      <p class="sub">Neon copy-on-write branching lab · Bun + TypeScript + Drizzle</p>
    </div>
    <div class="pill"><span id="status-dot" class="dot"></span><span id="status-text">connecting…</span><button id="refresh">Refresh</button></div>
  </header>

  <section class="cards" id="cards"></section>

  <h2>Watched repository <span id="watch-count" class="count"></span></h2>
  <div class="panel" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px; flex-wrap: wrap">
    <div id="watch-summary" class="sub">Checking watcher…</div>
    <button id="watch-sync">Sync PRs now</button>
  </div>
  <div class="panel" style="margin-top: 12px">
    <table>
      <thead><tr><th>repo</th><th>PR</th><th>title</th><th>head</th><th>branch</th><th>preview</th><th>synced</th></tr></thead>
      <tbody id="watch-prs"></tbody>
    </table>
  </div>

  <h2>Pull request previews <span id="previews-count" class="count"></span></h2>
  <div class="panel">
    <table>
      <thead><tr><th>PR</th><th>repo</th><th>event</th><th>status</th><th>branch</th><th>live</th><th>expires</th><th>Δ rows</th><th>Δ size</th><th>updated</th><th></th></tr></thead>
      <tbody id="previews"></tbody>
    </table>
  </div>
  <div class="panel" style="margin-top: 12px"><pre id="preview-detail">Run bun run ci:preview --pr &lt;n&gt; --event opened, then refresh to see the run, its branch, and its sticky comment.</pre></div>

  <h2>Tables on this branch</h2>
  <div class="panel">
    <table>
      <thead><tr><th>table</th><th>rows</th><th>table size</th><th>index size</th><th>total</th></tr></thead>
      <tbody id="tables"></tbody>
    </table>
  </div>

  <h2>Branches</h2>
  <div class="panel">
    <table>
      <thead><tr><th>branch</th><th>state</th><th>logical size</th><th>Δ parent</th><th>Neon writes</th><th>created</th><th></th></tr></thead>
      <tbody id="branches"></tbody>
    </table>
  </div>

  <h2>Branch report</h2>
  <div class="panel"><pre id="report">Select a branch and run a report to compare storage and schema against its parent.</pre></div>
</main>

<script>
const $ = (id) => document.getElementById(id);

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "n/a";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return value.toFixed(unit === 0 ? 0 : 1) + " " + units[unit];
}
function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}
function formatBytesDelta(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "n/a";
  if (bytes === 0) return "0 B";
  return (bytes > 0 ? "+" : "-") + formatBytes(Math.abs(bytes));
}
function formatDate(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 19).replace("T", " ");
}
function formatSigned(value) {
  const number = Number(value || 0);
  return (number > 0 ? "+" : "") + formatNumber(number);
}
function statusTag(status) {
  const span = document.createElement("span");
  span.className = "tag " + status;
  span.textContent = status;
  return span;
}
function liveCell(preview, liveAvailable) {
  const td = document.createElement("td");
  if (!liveAvailable) {
    td.textContent = "n/a";
    return td;
  }
  if (!preview.live || !preview.live.exists) {
    td.appendChild(statusTag("absent"));
    return td;
  }
  td.appendChild(statusTag(preview.live.state === "ready" ? "ready" : "provisioning"));
  if (preview.live.logicalSize) {
    td.append(" " + formatBytes(preview.live.logicalSize));
  }
  return td;
}
function renderPreviews(payload) {
  const table = $("previews");
  table.replaceChildren();

  const previews = payload.previews || [];
  $("previews-count").textContent = previews.length === 0
    ? ""
    : previews.length + " recorded · " + (payload.active || 0) + " live";

  if (previews.length === 0) {
    const message = payload.branchesError
      ? "No preview records. Neon branches are unavailable: " + payload.branchesError
      : "No preview runs yet. Run bun run ci:preview --pr <n> --event opened.";
    const tr = row(cell(message, "empty"));
    tr.firstChild.colSpan = 11;
    table.appendChild(tr);
    return;
  }

  for (const preview of previews) {
    const pr = document.createElement("td");
    const strong = document.createElement("strong");
    strong.textContent = preview.pr ? "#" + preview.pr : "—";
    pr.appendChild(strong);

    const repoCell = document.createElement("td");
    repoCell.textContent = preview.repo || "local";

    const branch = document.createElement("td");
    const branchName = document.createElement("strong");
    branchName.textContent = preview.branch;
    branch.appendChild(branchName);

    const report = preview.report;

    const statusCell = document.createElement("td");
    statusCell.appendChild(statusTag(preview.status));

    const action = document.createElement("td");
    const show = document.createElement("button");
    show.textContent = "Show run";
    show.addEventListener("click", () => showPreview(preview));
    action.appendChild(show);

    if (preview.live && preview.live.exists) {
      const reportButton = document.createElement("button");
      reportButton.textContent = "Report";
      reportButton.style.marginLeft = "6px";
      reportButton.addEventListener("click", () => runReport(preview.branch, $("report"), reportButton));
      action.appendChild(reportButton);

      const deleteButton = document.createElement("button");
      deleteButton.textContent = "Delete";
      deleteButton.className = "danger";
      deleteButton.style.marginLeft = "6px";
      deleteButton.addEventListener("click", () => deleteBranch(preview.branch, deleteButton, $("preview-detail")));
      action.appendChild(deleteButton);
    }

    table.appendChild(row(
      pr,
      repoCell,
      cell(preview.event || "—"),
      statusCell,
      branch,
      liveCell(preview, payload.liveAvailable !== false),
      cell(formatDate(preview.expiresAt || (preview.live && preview.live.expiresAt))),
      cell(report ? formatSigned(report.rowDelta) : "n/a", "num"),
      cell(report ? formatBytesDelta(report.sizeDeltaBytes) : "n/a", "num"),
      cell(formatDate(preview.updatedAt)),
      action,
    ));
  }
}
function showPreview(preview) {
  const lines = [];
  lines.push("PR #" + (preview.pr || "?") + (preview.event ? " · " + preview.event : ""));
  if (preview.repo) lines.push("repo:    " + preview.repo);
  if (preview.title) lines.push("title:   " + preview.title);
  if (preview.url) lines.push("url:     " + preview.url);
  lines.push("status:  " + preview.status + (preview.action ? " (" + preview.action + ")" : ""));
  lines.push("branch:  " + preview.branch + (preview.parent ? "  (parent " + preview.parent + ")" : ""));
  if (preview.live && preview.live.exists) {
    lines.push("live:    " + preview.live.state +
      (preview.live.logicalSize ? " · " + formatBytes(preview.live.logicalSize) : ""));
  } else {
    lines.push("live:    absent");
  }
  lines.push("expires: " + formatDate(preview.expiresAt || (preview.live && preview.live.expiresAt)));
  if (preview.updatedAt) lines.push("updated: " + formatDate(preview.updatedAt));
  if (preview.reason) lines.push("reason:  " + preview.reason);

  if (preview.steps && preview.steps.length > 0) {
    lines.push("", "steps");
    for (const step of preview.steps) {
      const mark = step.status === "ok" ? "✔" : step.status === "failed" ? "✖" : "·";
      lines.push("  " + mark + " " + step.name + (step.detail ? " — " + step.detail : ""));
    }
  }

  if (preview.tests && preview.tests.ran) {
    lines.push("", "tests: " + (preview.tests.passed ?? 0) + " passed / " +
      (preview.tests.failed ?? 0) + " failed (exit " + (preview.tests.exitCode ?? "?") + ")");
  }

  if (preview.report) {
    const report = preview.report;
    lines.push("", "branch delta");
    lines.push("  rows:   " + formatNumber(report.rowsBase) + " → " + formatNumber(report.rowsBranch) +
      " (" + formatSigned(report.rowDelta) + ")");
    lines.push("  size:   " + formatBytesDelta(report.sizeDeltaBytes) + " (new pages)");
    lines.push("  schema: " + (report.schemaChanged ? "changes detected" : "no changes"));
  }

  if (preview.error) lines.push("", "error: " + preview.error);
  if (preview.comment) lines.push("", "sticky comment", preview.comment.trim());

  const detail = $("preview-detail");
  detail.textContent = lines.join("\\n");
  detail.scrollIntoView({ block: "nearest" });
}
function renderWatch(payload) {
  const summary = $("watch-summary");
  const table = $("watch-prs");
  const button = $("watch-sync");
  table.replaceChildren();

  if (!payload.configured) {
    $("watch-count").textContent = "";
    summary.textContent = payload.error
      ? "Watcher unavailable: " + payload.error
      : "Not configured. Add GITHUB_REPO=owner/name to .env.local and restart the server.";
    button.disabled = true;
    const tr = row(cell(payload.error ? payload.error : "Set GITHUB_REPO to watch a repository.", "empty"));
    tr.firstChild.colSpan = 7;
    table.appendChild(tr);
    return;
  }

  button.disabled = Boolean(payload.syncing);
  const interval = payload.pollMs ? Math.round(payload.pollMs / 1000) + "s" : "off";
  const tracked = payload.pullRequests || [];
  const active = tracked.filter((pr) => pr.status !== "deleted" && pr.status !== "absent").length;
  $("watch-count").textContent = tracked.length === 0 ? "" : active + " active · " + tracked.length + " tracked";
  summary.textContent = payload.repos.join(", ") +
    " · auto-poll " + interval +
    (payload.lastRunAt ? " · last sync " + formatDate(payload.lastRunAt) : " · not synced yet") +
    (payload.syncing ? " · syncing…" : "");

  if (payload.lastError) {
    summary.append(" · ");
    const error = document.createElement("span");
    error.className = "error";
    error.textContent = payload.lastError;
    summary.appendChild(error);
  }

  if (tracked.length === 0) {
    const tr = row(cell("No pull requests tracked yet. Open one on " + payload.repos.join(", ") + ", then sync.", "empty"));
    tr.firstChild.colSpan = 7;
    table.appendChild(tr);
    return;
  }

  for (const pr of tracked) {
    const number = document.createElement("td");
    const strong = document.createElement("strong");
    strong.textContent = "#" + pr.number;
    number.appendChild(strong);
    if (pr.draft) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "draft";
      number.append(" ", tag);
    }

    const title = document.createElement("td");
    if (pr.url) {
      const link = document.createElement("a");
      link.href = pr.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = pr.title || "(no title)";
      title.appendChild(link);
    } else {
      title.textContent = pr.title || "(no title)";
    }

    const statusCell = document.createElement("td");
    statusCell.appendChild(statusTag(pr.status));

    table.appendChild(row(
      cell(pr.repo),
      number,
      title,
      cell(pr.headSha ? pr.headSha.slice(0, 7) : "—"),
      cell(pr.branch),
      statusCell,
      cell(formatDate(pr.syncedAt)),
    ));
  }
}
function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}
function row(...cells) {
  const tr = document.createElement("tr");
  for (const value of cells) tr.appendChild(value);
  return tr;
}
function setStatus(ok, text) {
  $("status-dot").className = "dot " + (ok ? "ok" : "bad");
  $("status-text").textContent = text;
}
function card(label, value, hint) {
  const div = document.createElement("div");
  div.className = "card";
  const l = document.createElement("div"); l.className = "label"; l.textContent = label;
  const v = document.createElement("div"); v.className = "value"; v.textContent = value;
  div.append(l, v);
  if (hint) {
    const h = document.createElement("div"); h.className = "hint"; h.textContent = hint;
    div.appendChild(h);
  }
  return div;
}
async function deleteBranch(name, button, output) {
  const confirmed = window.confirm(
    'Delete branch "' + name + '"?\\n\\nThis removes it from Neon and cannot be undone.'
  );
  if (!confirmed) return;

  button.disabled = true;
  output.textContent = "Deleting branch " + name + "…";
  try {
    const response = await fetch("/api/branches?name=" + encodeURIComponent(name), { method: "DELETE" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || (response.status + " " + response.statusText));

    output.textContent = "Deleted branch " + name + "." +
      (body.warning ? "\\n" + body.warning : "") +
      (body.watched
        ? "\\nThis branch belongs to an open watched PR, so the watcher will recreate it on the next sync."
        : "");
    await load();
  } catch (error) {
    output.textContent = "Delete failed: " + error.message;
  } finally {
    button.disabled = false;
  }
}

async function getJson(path) {
  const response = await fetch(path);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || (response.status + " " + response.statusText));
  return body;
}

async function load() {
  const [health, stats, branches, previews, watch] = await Promise.allSettled([
    getJson("/api/health"),
    getJson("/api/stats"),
    getJson("/api/branches"),
    getJson("/api/previews"),
    getJson("/api/watch"),
  ]);

  if (health.status === "fulfilled") {
    setStatus(true, health.value.database + " · " + health.value.latencyMs + "ms");
  } else {
    setStatus(false, health.reason.message);
  }

  const cards = $("cards");
  cards.replaceChildren();
  if (stats.status === "fulfilled") {
    const s = stats.value;
    cards.append(
      card("Database size", formatBytes(s.sizeBytes), s.database),
      card("Rows", formatNumber(s.totalRows), s.tables.length + " tables"),
      card("Branches", branches.status === "fulfilled" ? String(branches.value.branches.length) : "n/a", "Neon project"),
      card(
        "Previews",
        previews.status === "fulfilled" ? String(previews.value.active || 0) : "n/a",
        previews.status === "fulfilled" ? (previews.value.total || 0) + " recorded" : "artifacts unavailable",
      ),
      card("Server", "Bun", s.serverVersion.split(" ").slice(0, 2).join(" ")),
    );

    const tables = $("tables");
    tables.replaceChildren();
    for (const table of s.tables) {
      tables.appendChild(row(
        cell(table.table),
        cell(formatNumber(table.rows), "num"),
        cell(formatBytes(table.tableBytes), "num"),
        cell(formatBytes(table.indexBytes), "num"),
        cell(formatBytes(table.totalBytes), "num"),
      ));
    }
  } else {
    cards.append(card("Database", "unreachable", stats.reason.message));
  }

  const table = $("branches");
  table.replaceChildren();
  const info = $("report");

  if (branches.status === "fulfilled") {
    if (branches.value.branches.length === 0) {
      const tr = row(cell("No branches visible.", "empty"));
      tr.firstChild.colSpan = 7;
      table.appendChild(tr);
    }
    const byId = new Map(branches.value.branches.map((branch) => [branch.id, branch]));
    for (const branch of branches.value.branches) {
      const name = document.createElement("td");
      const strong = document.createElement("strong");
      strong.textContent = branch.name;
      name.appendChild(strong);
      if (branch.default) {
        const tag = document.createElement("span");
        tag.className = "tag default";
        tag.textContent = "default";
        name.append(" ", tag);
      }
      if (branch.name.indexOf("preview/") === 0) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "preview";
        name.append(" ", tag);
      }

      const state = document.createElement("td");
      const tag = document.createElement("span");
      tag.className = "tag " + (branch.currentState === "ready" ? "ready" : "");
      tag.textContent = branch.currentState;
      state.appendChild(tag);

      const action = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "actions";

      const reportButton = document.createElement("button");
      reportButton.textContent = "Run report";
      reportButton.addEventListener("click", () => runReport(branch.name, info, reportButton));

      const deleteButton = document.createElement("button");
      deleteButton.textContent = "Delete";
      deleteButton.className = "danger";
      if (branch.deletable === false) {
        deleteButton.disabled = true;
        deleteButton.title = "Protected: " + (branch.deleteBlockedReason || "not deletable from the dashboard");
      } else {
        deleteButton.addEventListener("click", () => deleteBranch(branch.name, deleteButton, info));
      }

      actions.append(reportButton, deleteButton);
      action.appendChild(actions);

      const parent = branch.parentId ? byId.get(branch.parentId) : undefined;
      const delta =
        parent &&
        parent.logicalSize > 0 &&
        branch.logicalSize > 0
          ? branch.logicalSize - parent.logicalSize
          : undefined;

      table.appendChild(row(
        name,
        state,
        cell(branch.logicalSize > 0 ? formatBytes(branch.logicalSize) : "n/a", "num"),
        cell(formatBytesDelta(delta), "num"),
        cell(formatBytes(branch.writtenDataBytes), "num"),
        cell(formatDate(branch.createdAt)),
        action,
      ));
    }
  } else {
    const tr = row(cell(branches.reason.message, "empty error"));
    tr.firstChild.colSpan = 7;
    table.appendChild(tr);
  }

  if (previews.status === "fulfilled") {
    renderPreviews(previews.value);
  } else {
    renderPreviews({
      previews: [],
      total: 0,
      active: 0,
      branchesError: previews.reason.message,
    });
  }

  if (watch.status === "fulfilled") {
    renderWatch(watch.value);
  } else {
    renderWatch({ configured: false, error: watch.reason.message });
  }
}

async function runReport(name, output, button) {
  button.disabled = true;
  output.textContent = "Building report for " + name + "…";
  try {
    const report = await getJson("/api/branches/report?name=" + encodeURIComponent(name));
    const lines = [];
    lines.push("branch:  " + report.branch.name + (report.branch.state ? " (" + report.branch.state + ")" : ""));
    lines.push("parent:  " + report.parent.name);
    lines.push("mode:    " + report.mode);
    lines.push("created: " + formatDate(report.branch.createdAt));
    if (report.branch.name === report.parent.name) {
      lines.push("note:    branch and parent are the same; writes are the baseline, not a branch delta");
    }
    lines.push("");
    lines.push("storage (logical, not physical branch allocation)");
    lines.push("  parent data:   " + formatBytes(report.base.sizeBytes) + "  (neondb, pg_database_size)");
    lines.push("  branch data:   " + formatBytes(report.compare.sizeBytes) + "  (neondb: inherited + branch-local)");
    lines.push("  branch delta:  " + formatBytesDelta(report.sizeDeltaBytes) + "  (new pages since branch creation)");
    if (typeof report.parent.logicalSizeBytes === "number" &&
        typeof report.branch.logicalSizeBytes === "number" &&
        typeof report.logicalSizeDeltaBytes === "number") {
      lines.push("  neon logical:  " + formatBytes(report.parent.logicalSizeBytes) + " -> " +
        formatBytes(report.branch.logicalSizeBytes) + " (" + formatBytesDelta(report.logicalSizeDeltaBytes) +
        ")  (all databases)");
      if (typeof report.estimatedBranchStorageBytes === "number") {
        lines.push("  child storage: ~" + formatBytes(report.estimatedBranchStorageBytes) +
          "  (billed on branch delta, capped at logical size)");
      }
    } else if (report.mode === "neon") {
      lines.push("  neon logical:  n/a  (Neon has not reported logical_size for this branch yet)");
    }
    if (typeof report.branch.writtenDataBytes === "number") {
      lines.push("  neon writes:   " + formatBytes(report.branch.writtenDataBytes) +
        (report.branch.writtenDataBytes === 0 ? "  (written_data_bytes; lagging/unreliable)" : ""));
    }
    lines.push("  branch writes: " + report.branchWrites.inserts + " ins / " +
      report.branchWrites.updates + " upd / " + report.branchWrites.deletes + " del");
    lines.push("");
    lines.push("rows: " + formatNumber(report.base.totalRows) + " -> " + formatNumber(report.compare.totalRows));
    lines.push("");
    lines.push("tables");
    for (const table of report.tables) {
      lines.push("  " + table.table.padEnd(16) + formatNumber(table.baseRows).padStart(8) + " -> " +
        formatNumber(table.branchRows).padStart(8) + "  " +
        formatBytes(table.baseBytes).padStart(9) + " -> " + formatBytes(table.branchBytes).padStart(9));
    }
    lines.push("");
    lines.push("schema changes");
    const diff = report.schemaDiff;
    if (!diff.hasChanges) {
      lines.push("  none");
    } else {
      for (const t of diff.tablesAdded) lines.push("  + table " + t);
      for (const t of diff.tablesRemoved) lines.push("  - table " + t);
      for (const change of diff.tablesChanged) {
        lines.push("  ~ table " + change.table);
        for (const c of change.columnsAdded) lines.push("      + column " + c);
        for (const c of change.columnsRemoved) lines.push("      - column " + c);
        for (const c of change.columnsChanged) lines.push("      ~ column " + c.name + " (" + c.field + "): " + c.before + " -> " + c.after);
        for (const i of change.indexesAdded) lines.push("      + index " + i);
        for (const i of change.indexesRemoved) lines.push("      - index " + i);
      }
      for (const e of diff.enumsAdded) lines.push("  + enum " + e);
      for (const e of diff.enumsRemoved) lines.push("  - enum " + e);
      for (const e of diff.enumsChanged) {
        lines.push("  ~ enum " + e.name);
        for (const v of e.added) lines.push("      + value " + v);
        for (const v of e.removed) lines.push("      - value " + v);
      }
    }
    output.textContent = lines.join("\\n");
  } catch (error) {
    output.textContent = "Report failed: " + error.message;
  } finally {
    button.disabled = false;
  }
}

$("refresh").addEventListener("click", () => load());

$("watch-sync").addEventListener("click", async () => {
  const button = $("watch-sync");
  button.disabled = true;
  button.textContent = "Syncing…";
  try {
    const response = await fetch("/api/watch/sync", { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || (response.status + " " + response.statusText));
    await load();
  } catch (error) {
    $("watch-summary").textContent = "Sync failed: " + error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Sync PRs now";
  }
});

load();
</script>
</body>
</html>`;
