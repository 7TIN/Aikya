import { describe, expect, test } from "bun:test";
import { dashboardHtml } from "./dashboard.ts";

/**
 * The dashboard is one template string, so an escape that is valid TypeScript
 * can still emit invalid browser JavaScript (`\/` and `\d` collapse unless
 * doubled). Compiling the inline script catches that class of bug.
 */
function inlineScript(): string {
  const start = dashboardHtml.indexOf("<script>");
  const end = dashboardHtml.indexOf("</script>", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return dashboardHtml.slice(start + "<script>".length, end);
}

describe("dashboard HTML", () => {
  test("inline script is valid JavaScript", () => {
    expect(() => new Function(inlineScript())).not.toThrow();
  });

  test("keeps the preview branch-name pattern escaped", () => {
    const script = inlineScript();
    expect(script).toContain("/^preview\\/([a-z0-9-]+)-pr-(\\d+)$/");

    const pattern = /^preview\/([a-z0-9-]+)-pr-(\d+)$/;
    expect(pattern.exec("preview/7tin-gh-lab-pr-3")?.[1]).toBe("7tin-gh-lab");
  });

  test("renders the observability and guardrail sections", () => {
    expect(dashboardHtml).toContain("Event log");
    expect(dashboardHtml).toContain("Cost view");
    expect(dashboardHtml).toContain("Quotas");
    expect(dashboardHtml).toContain('id="quotas"');
    expect(dashboardHtml).toContain("Retention");
    expect(dashboardHtml).toContain('id="prune-preview"');
  });
});
