import { customers } from "./db/schema.ts";
import { getDatabase } from "./db/client.ts";
import { collectDatabaseStats } from "./db/stats.ts";
import { dashboardHtml } from "./dashboard.ts";
import { listBranches } from "./neon/branches.ts";
import { buildBranchReport } from "./neon/report.ts";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";

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
  // 10s default. Keep the socket open while the report is assembled.
  idleTimeout: 120,

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

    "/api/branches": async () => {
      try {
        const branches = await listBranches();
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
