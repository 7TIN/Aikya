import { loadPreviewArtifacts, mergePreviews } from "./ci/previews.ts";
import { customers } from "./db/schema.ts";
import { getDatabase } from "./db/client.ts";
import { collectDatabaseStats } from "./db/stats.ts";
import { dashboardHtml } from "./dashboard.ts";
import { createEventLog } from "./events/log.ts";
import { buildCostView, costRatesFromEnv } from "./cost/view.ts";
import { collectQuotaStatuses } from "./preview/quota-status.ts";
import {
  resolveWatchConfig,
  unconfiguredWatchStatus,
  WatchService,
} from "./github/service.ts";
import { deleteBranch, listBranches, type NeonBranch } from "./neon/branches.ts";
import { branchDeleteBlockedReason } from "./neon/delete.ts";
import { buildBranchReport } from "./neon/report.ts";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";

let watchConfig: ReturnType<typeof resolveWatchConfig> = null;
try {
  watchConfig = resolveWatchConfig();
} catch (error) {
  console.error(
    `[watch] configuration error: ${error instanceof Error ? error.message : String(error)}`,
  );
}
const watcher = watchConfig ? new WatchService(watchConfig) : null;

/**
 * `/api/branches` and `/api/previews` both need the Neon branch list. A short
 * cache keeps a dashboard refresh from shelling out to the Neon CLI twice.
 */
let branchCache: { at: number; value: NeonBranch[] } | null = null;
const BRANCH_CACHE_MS = 3_000;

async function cachedBranches(): Promise<NeonBranch[]> {
  if (branchCache && Date.now() - branchCache.at < BRANCH_CACHE_MS) {
    return branchCache.value;
  }
  const value = await listBranches();
  branchCache = { at: Date.now(), value };
  return value;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const server = Bun.serve({
  port,
  hostname,
  development: process.env.NODE_ENV !== "production",
  // Branch reports shell out to the Neon CLI and can take longer than Bun's
  // 10s default. A manual PR sync can create several branches, so allow the
  // maximum idle window while the request is being served.
  idleTimeout: 255,

  routes: {
    "/": () =>
      new Response(dashboardHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),

    "/api/health": async () => {
      const startedAt = performance.now();
      try {
        const { client } = getDatabase();
        const rows = (await client.unsafe(
          `select current_database() as database, version() as version`,
        )) as unknown as Array<{ database: string; version: string }>;

        const info = rows[0];
        return json({
          status: "ok",
          database: info?.database ?? "unknown",
          server: info?.version.split(",")[0] ?? "unknown",
          branch: process.env.NEON_BRANCH ?? null,
          latencyMs: Math.round(performance.now() - startedAt),
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        return json(
          {
            status: "error",
            error: errorMessage(error),
            latencyMs: Math.round(performance.now() - startedAt),
          },
          503,
        );
      }
    },

    "/api/stats": async () => {
      try {
        const { client } = getDatabase();
        return json(await collectDatabaseStats(client));
      } catch (error) {
        return json({ error: errorMessage(error) }, 500);
      }
    },

    "/api/customers": async (request) => {
      try {
        const url = new URL(request.url);
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit") ?? 20), 1),
          100,
        );
        const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
        const { db } = getDatabase();
        const rows = await db
          .select()
          .from(customers)
          .limit(limit)
          .offset(offset);
        return json({ limit, offset, count: rows.length, data: rows });
      } catch (error) {
        return json({ error: errorMessage(error) }, 500);
      }
    },

    "/api/branches": {
      GET: async () => {
        try {
          const events = await createEventLog().load({ limit: 200 });
          const lastReportByBranch = new Map<string, string>();
          for (const event of events) {
            if (event.type === "branch.report" && event.branch && event.at) {
              lastReportByBranch.set(event.branch, event.at);
            }
          }

          const branches = (await cachedBranches()).map((branch) => {
            const blocked = branchDeleteBlockedReason(branch);
            return {
              ...branch,
              deletable: blocked === null,
              deleteBlockedReason: blocked,
              lastReportAt: lastReportByBranch.get(branch.name) ?? null,
            };
          });
          return json({ branches });
        } catch (error) {
          return json(
            {
              branches: [],
              error: errorMessage(error),
              hint: "Set NEON_PROJECT_ID and make sure the Neon CLI is authenticated (or NEON_API_KEY is set).",
            },
            503,
          );
        }
      },

      DELETE: async (request) => {
        const name = new URL(request.url).searchParams.get("name")?.trim();
        if (!name) {
          return json({ error: "Missing ?name=<branch>" }, 400);
        }

        try {
          // Read the branch fresh: the cached list may predate a protection
          // change, and this guard is the last line of defense before deletion.
          const branch = (await listBranches()).find((entry) => entry.name === name);
          if (!branch) {
            return json({ error: `Branch "${name}" was not found.` }, 404);
          }

          const blocked = branchDeleteBlockedReason(branch);
          if (blocked) {
            return json(
              {
                error: `Refusing to delete "${name}": it is ${blocked}. Use the CLI with an explicit --yes if this is intentional.`,
              },
              409,
            );
          }

          await deleteBranch(name);
          branchCache = null;

          // If the branch belongs to an open watched PR, mark it deleted so the
          // watcher recreates it on the next poll instead of skipping a stale
          // "ready" record. A state-write failure must not turn a successful
          // deletion into an error response.
          let watched = false;
          let warning;
          if (watcher) {
            try {
              watched = await watcher.markBranchDeleted(name);
            } catch (error) {
              warning = `Branch deleted, but watcher state could not be updated: ${errorMessage(error)}`;
              console.warn(`[watch] ${warning}`);
            }
          }

          return json({
            deleted: true,
            branch: name,
            watched,
            ...(warning ? { warning } : {}),
          });
        } catch (error) {
          return json({ error: errorMessage(error) }, 500);
        }
      },
    },

    "/api/previews": async () => {
      // Artifacts are read first: they still explain the last run when Neon is
      // unreachable. The live branch list is best-effort.
      const records = await loadPreviewArtifacts();
      let branches: NeonBranch[] | null = null;
      let branchesError: string | undefined;

      try {
        branches = await cachedBranches();
      } catch (error) {
        branchesError = errorMessage(error);
      }

      const previews = mergePreviews(records, branches);
      return json({
        liveAvailable: branches !== null,
        total: previews.length,
        active: previews.filter((preview) => preview.live.exists).length,
        previews,
        ...(branchesError ? { branchesError } : {}),
      });
    },

    "/api/events": async (request) => {
      try {
        const url = new URL(request.url);
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit") ?? 50), 1),
          500,
        );
        const repo = url.searchParams.get("repo")?.trim() || undefined;
        const branch = url.searchParams.get("branch")?.trim() || undefined;
        const since = url.searchParams.get("since")?.trim() || undefined;
        const events = await createEventLog().load({ limit, repo, branch, since });
        return json({ events });
      } catch (error) {
        return json({ events: [], error: errorMessage(error) }, 500);
      }
    },

    "/api/cost": async () => {
      try {
        const [branches, events] = await Promise.all([
          cachedBranches(),
          createEventLog().load({ limit: 500 }),
        ]);
        const { rates, fromEnv } = costRatesFromEnv();
        const view = buildCostView({ branches, events, rates, ratesFromEnv: fromEnv });
        return json(view);
      } catch (error) {
        return json({ error: errorMessage(error) }, 500);
      }
    },

    "/api/quotas": async () => {
      try {
        const report = await collectQuotaStatuses();
        return json(report);
      } catch (error) {
        return json({ repos: [], warnings: [], error: errorMessage(error) }, 500);
      }
    },

    "/api/watch": () => json(watcher ? watcher.status() : unconfiguredWatchStatus()),

    "/api/watch/sync": {
      POST: async () => {
        if (!watcher) {
          return json(
            {
              error:
                "No watched repository. Set GITHUB_REPO=owner/name in .env.local and restart the server.",
            },
            400,
          );
        }

        const result = await watcher.syncNow("manual");
        return json(result, result.error ? 500 : 200);
      },
    },

    "/api/branches/report": async (request) => {
      try {
        const name = new URL(request.url).searchParams.get("name");
        if (!name) {
          return json({ error: "Missing ?name=<branch>" }, 400);
        }
        return json(
          await buildBranchReport({ branch: name, neonDiff: false }),
        );
      } catch (error) {
        return json({ error: errorMessage(error) }, 500);
      }
    },

    "/api/echo": {
      POST: async (request) => {
        const body = await request.text();
        return json({ received: body });
      },
    },
  },

  error(error) {
    console.error(error);
    return json({ error: "Internal Server Error" }, 500);
  },

  fetch() {
    return json({ error: "Not Found" }, 404);
  },
});

console.log(`Server listening on http://localhost:${server.port}`);

if (watcher) {
  void watcher.start().catch((error) => {
    console.error(
      `[watch] failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
} else {
  console.log(
    "[watch] no GITHUB_REPO configured; set it in .env.local to auto-create preview branches.",
  );
}
