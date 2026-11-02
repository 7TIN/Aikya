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
  .error { color: var(--bad); }
  .empty { padding: 18px; color: var(--muted); font-size: 13px; }
  button {
    background: #1b2230; color: var(--text); border: 1px solid var(--border);
    padding: 5px 10px; border-radius: 8px; cursor: pointer; font-size: 12px;
  }
  button:hover { border-color: #3a465e; background: #202938; }
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
    <div class="pill"><span id="status-dot" class="dot"></span><span id="status-text">connecting…</span></div>
  </header>

  <section class="cards" id="cards"></section>

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
      <thead><tr><th>branch</th><th>state</th><th>COW writes</th><th>CPU s</th><th>created</th><th></th></tr></thead>
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
function formatDate(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 19).replace("T", " ");
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
async function getJson(path) {
  const response = await fetch(path);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || (response.status + " " + response.statusText));
  return body;
}

async function load() {
  const [health, stats, branches] = await Promise.allSettled([
    getJson("/api/health"),
    getJson("/api/stats"),
    getJson("/api/branches"),
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
      tr.firstChild.colSpan = 6;
      table.appendChild(tr);
    }
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

      const state = document.createElement("td");
      const tag = document.createElement("span");
      tag.className = "tag " + (branch.currentState === "ready" ? "ready" : "");
      tag.textContent = branch.currentState;
      state.appendChild(tag);

      const action = document.createElement("td");
      const button = document.createElement("button");
      button.textContent = "Run report";
      button.addEventListener("click", () => runReport(branch.name, info, button));
      action.appendChild(button);

      table.appendChild(row(
        name,
        state,
        cell(formatBytes(branch.writtenDataBytes), "num"),
        cell(String(branch.cpuUsedSec), "num"),
        cell(formatDate(branch.createdAt)),
        action,
      ));
    }
  } else {
    const tr = row(cell(branches.reason.message, "empty error"));
    tr.firstChild.colSpan = 6;
    table.appendChild(tr);
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
    lines.push("");
    lines.push("storage");
    lines.push("  parent: " + formatBytes(report.base.sizeBytes));
    lines.push("  branch: " + formatBytes(report.compare.sizeBytes));
    lines.push("  delta:  " + (report.sizeDeltaBytes >= 0 ? "+" : "") + formatBytes(report.sizeDeltaBytes));
    if (typeof report.branch.writtenDataBytes === "number") {
      lines.push("  cow writes: " + formatBytes(report.branch.writtenDataBytes));
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

load();
</script>
</body>
</html>`;
