# db-branch

A Bun + TypeScript lab for **autonomous Postgres database branching** on
[Neon](https://neon.com): copy-on-write branches, branch-local migrations,
seeded data, storage/schema reporting, and a local watcher that turns pull
requests from an external repository into preview branches.

> The full roadmap (PR previews, CI runs, staging, agent sandboxes, retention)
> lives in [docs/database-branching.md](docs/database-branching.md).

## Stack

- [Bun](https://bun.com) HTTP server + scripts
- [Drizzle ORM](https://orm.drizzle.team) + `postgres.js`
- [Neon](https://neon.com) Postgres branches, managed through the Neon CLI

## Quickstart

```bash
bun install
cp .env.example .env.local
# fill DATABASE_URL, DATABASE_URL_UNPOOLED, NEON_PROJECT_ID
```

Then:

```bash
bun run db:migrate   # apply migrations (drizzle/)
bun run db:seed      # 2k customers / 200 products / 20k orders
bun run db:stats     # storage + exact row counts
bun run dev          # http://localhost:3000
```

### Neon setup

The lab project is already created and claimed; its values are in `.env.local`.
To use a different project:

1. Create a project in the Neon console.
2. Put the **pooled** connection string in `DATABASE_URL` and the direct one in
   `DATABASE_URL_UNPOOLED`.
3. Set `NEON_PROJECT_ID`.
4. Run `bun run db:reset`.

Branch commands use the Neon management API. If they report `Not signed in`,
run `neon login` or add `NEON_API_KEY` to `.env.local`; the database connection
can keep working independently.

## Scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Start the server with hot reload |
| `bun run build` | Bundle the server into `dist/` |
| `bun run start` | Run the built server |
| `bun run typecheck` | Type check the project |
| `bun run db:generate` | Generate a Drizzle migration from `src/db/schema.ts` |
| `bun run db:migrate` | Apply migrations |
| `bun run db:seed` | Seed deterministic demo data |
| `bun run db:reset` | Drop public schema → migrate → seed |
| `bun run db:stats` | Database size, rows, writes (`--branch`, `--url`, `--json`) |
| `bun run db:sql <file>` | Run a SQL file on `--branch <name>` or `--url <url>` |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run branch:list` | List branches, logical size, delta vs parent (`--json`) |
| `bun run branch:create --name <branch>` | Create a branch from `main` |
| `bun run branch:report <branch>` | Storage + schema diff vs parent (`--json`, `--neon-diff`) |
| `bun run branch:diff <base> <compare>` | Neon's own schema diff |
| `bun run branch:delete <branch> --yes` | Delete a branch |
| `bun run branch:ensure --all` | Create the persistent `staging` and `qa` branches |
| `bun run branch:reset staging --yes` | Pre-report → reset to parent → migrate → smoke |
| `bun run db:smoke --branch staging` | Verify tables, rows, migrations, and write rollback |
| `bun run branch:verify-cow` | Create a no-write branch, assert 0 B delta, delete it |
| `bun run branch:prune` | List/delete stale branches (dry run by default) |
| `bun run branch:demo` | Create branch → feature SQL → branch data → report |
| `bun run branch:report --base-url U --branch-url U` | Compare any two databases |
| `bun run ci:preview --pr <n> --event <event>` | Local PR preview: create/recreate → migrate → test → report |
| `bun run ci:cleanup --pr <n>` | Delete a preview branch (closed event) |
| `bun run watch --repo <owner/name>` | One pass over an external repo's open PRs → branches |
| `bun run watch:loop --repo <owner/name>` | Poll an external repo continuously (default 120s) |

`branch:demo` also accepts `--parent`, `--reuse`, `--cleanup`, and `--json`.

## How branching is demonstrated

`main` holds the baseline schema and seed. `branch:demo` then:

1. Creates a branch from `main`.
2. Applies `src/db/features/001-coupons.sql` **only on the branch** (new
   `coupons` table, `orders.coupon_code`, `orders.discount_cents`, index).
3. Adds branch-local data from `002-coupons-data.sql`.
4. Compares the branch with its parent:

```
Storage (logical, not physical branch allocation)
Parent data   19.2 MB (neondb, pg_database_size)
Branch data   19.9 MB (neondb: inherited + branch-local)
Branch delta  +736.0 KB (new pages since branch creation)
Neon logical  41.5 MB → 42.3 MB (+784.0 KB) (all databases)
Child storage ~784.0 KB (billed on the branch delta, capped at logical size)
Rows          72,426 → 73,929 (+1,503)
Branch writes +1,503 ins / +1,500 upd / 0 del
Neon writes   0 B (written_data_bytes: lagging/unreliable)

Schema changes
+ table coupons
~ table orders
    + column coupon_code
    + column discount_cents
    + index orders_coupon_code_idx
```

**The 19.9 MB is not a copy.** A branch logically contains everything it
inherited (19.2 MB) plus its own new pages (~0.7 MB). The `Branch delta` and
`Neon logical` delta are the branch-local growth; that is what Neon bills for a
child branch, capped at the logical size. `written_data_bytes` is shown too, but
it can lag or report `0` on some projects; the logical-size delta and
`pg_stat_user_tables` writes are the reliable signals.

Main is never modified. Delete the branch when done:

```bash
bun run branch:delete demo-coupons --yes
```

### Re-running the experiment

`branch:demo` refuses to overwrite an existing branch. For a clean repeat:

```bash
# delete the previous branch, then recreate it
bun run branch:delete demo-coupons --yes
bun run branch:demo --name demo-coupons

# or keep the old branch and use a new name
bun run branch:demo --name demo-coupons-2

# or create, report, and delete in one command
bun run branch:demo --name demo-coupons-tmp --cleanup
```

`--reuse` applies the demo data again (adding another 500 orders), so
delete-and-recreate is the cleanest way to repeat the test.

### Verify COW and clean up

```bash
bun run branch:verify-cow
```

Creates a temporary no-write branch and asserts that it has the same rows,
schema, and size as its parent, with zero branch-local writes and a `0 B` size
delta. It deletes the branch automatically and exits non-zero if a check fails.
Use `--keep`, `--name`, or `--json` if needed.

```bash
bun run branch:prune --older-than 7d              # dry run
bun run branch:prune --older-than 7d --yes        # delete
bun run branch:prune --prefix preview/ --yes      # only preview branches
```

`branch:prune` never selects `main`, the default/primary branch, protected
branches, the configured parent, or the persistent `staging`/`qa` environment
branches. Expired branches are selected regardless of age.

## PR previews (Phase 2)

The preview pipeline can run locally, without GitHub or a second account. It
creates `preview/pr-<number>` from `main`, applies migrations, runs tests, and
writes a branch report plus a sticky-comment body:

```bash
bun run ci:preview --pr 123 --event opened
bun run ci:preview --pr 123 --event synchronize   # delete + recreate
bun run ci:cleanup --pr 123                       # closed: delete
```

Artifacts land in `artifacts/preview/pr-123/` (`report.json`, `comment.md`).
Use `--reset` to drop/migrate/seed instead of inheriting, `--fork` to simulate a
fork PR, `--expires-in 7d` to change retention, and `--json` for automation.

`bun run dev` shows every PR preview on the dashboard: event, run status, branch,
live Neon state and logical size, expiry, row/storage delta, and the recorded
steps, tests, and sticky comment. Preview branches found in Neon without a local
artifact are listed as `branch-only`.

```text
opened/reopened  → create (or replace) → migrate → test → report → comment
synchronize      → delete + recreate  → migrate → test → report → comment
closed           → delete
fork             → skip; never receives secrets
```

`.github/workflows/db-preview.yml` wraps the same command. It needs a
`NEON_API_KEY` secret and a `NEON_PROJECT_ID` variable. The job is skipped for
fork PRs: GitHub does not give them repository secrets, and this pipeline does
not use `pull_request_target`, which would run untrusted code with secrets.
`db-preview-cleanup.yml` prunes `preview/` branches older than 7 days as a
backstop.

## Watching an external repository (local, no bot install)

Aikya is the pipeline; the watched repository is only a source of pull-request
events. The local watcher polls GitHub's public REST API, so nothing needs to be
installed in the other repository and no GitHub App or bot account is required.

```bash
# .env.local
GITHUB_REPO=7TIN/gh-lab
GITHUB_POLL_MS=120000
# GITHUB_TOKEN=...                       # optional: higher limit / private repos
# GITHUB_REPOS=owner/one,owner/two

bun run watch --repo 7TIN/gh-lab          # one reconciliation pass
bun run watch:loop --repo 7TIN/gh-lab     # keep polling
bun run dev                               # auto-starts when GITHUB_REPO is set
```

The dashboard adds a **Watched repository** panel with a **Sync PRs now** button
(`POST /api/watch/sync`) and the tracked PRs. The server polls every
`GITHUB_POLL_MS` and also syncs on startup unless `GITHUB_WATCH_ON_START=false`.

```text
open PR, unseen              → create preview/<owner>-<repo>-pr-<n>
open PR, new head commit     → delete + recreate
open PR, unchanged, ready    → skip (failed runs retry after 5 minutes)
PR closed / merged           → delete the branch
```

Watched branches are namespaced because every watched repository shares one Neon
project in this lab: `preview/7tin-gh-lab-pr-7`. The `preview/pr-<n>` names stay
reserved for Aikya's own GitHub Actions preview. Artifacts land in
`artifacts/preview/7tin-gh-lab-pr-<n>/`; watcher state is kept in
`artifacts/monitor/state.json` (both git-ignored).

Important boundaries:

- The watcher only reads PR metadata. It never checks out or executes the
  watched repository's code; migrations and tests come from this project. A fork
  PR is therefore handled like any other PR here, while the GitHub Actions
  wrapper still skips forks because it runs PR code.
- One Neon project/database is shared by all watched repositories for now. Use
  separate projects when this becomes a multi-tenant product.
- Unauthenticated GitHub API access allows 60 requests/hour per IP, so the
  default poll is 120s. Set a read-only `GITHUB_TOKEN` to poll faster or watch
  private repositories.
- Deletions are skipped when pagination is incomplete, and a failed fetch leaves
  every branch untouched.
- Run one watcher per state file: either the server's watcher or
  `watch:loop`, not both. The overlap lock is in-process, so two processes
  sharing `artifacts/monitor/state.json` could race on the same branches.

API: `GET /api/watch` returns the watcher status and tracked PRs;
`POST /api/watch/sync` runs a reconciliation immediately.

## Staging and QA environments (Phase 3)

Two persistent branches mirror long-lived environments. They have no expiry and
are protected from pruning:

```bash
bun run branch:ensure --all          # create staging + qa if missing
bun run branch:reset staging         # dry run: pre-reset report + plan
bun run branch:reset staging --yes   # reset → migrate → smoke
bun run db:smoke --branch staging    # standalone health check
```

`branch:reset` only accepts `staging` or `qa`. It captures a pre-reset report
(rows, storage delta, writes, schema diff) into
`artifacts/environments/<name>/pre-reset.json` **before** calling Neon's native
`branch reset --parent`. Without `--yes` it stops after the report. With
`--yes` it refreshes the branch, re-applies migrations, and runs the smoke test.

```text
Environment reset
Environment  staging (parent main)
Status       ✔ RESET

Pre-reset snapshot
Storage      +32.0 KB (branch-local since creation)
Rows         72,426 → 72,427 (+1)
Writes       +1 ins / +0 upd / 0 del
Schema       changes detected

✔ pre-reset report
✔ reset to parent (restored from main)
✔ migrate
✔ smoke test (4 checks passed)
```

The smoke test verifies the baseline tables exist and contain rows, migration
history is present, and a transactional create/insert/select rolls back cleanly.
Results are written to `artifacts/environments/<name>/smoke.json`.

Safety rules: the environment allowlist rejects `main` and arbitrary branches;
replacing an existing environment requires `--yes`; default/primary/protected
branches are refused; and `branch:prune` never selects `staging` or `qa`.

The dashboard's top cards and table list use `DATABASE_URL` (main). Branches and
PR previews come from the Neon CLI; **Run report** opens separate connections,
so the branch comparison is always against its parent.

## API

| Route | Description |
| --- | --- |
| `GET /` | Dashboard: health, tables, PR previews, branches, report runner |
| `GET /api/health` | DB connectivity, database name, latency |
| `GET /api/stats` | Size + row counts per table |
| `GET /api/customers?limit=20&offset=0` | Paginated customers |
| `GET /api/branches` | Neon branches + logical size + writes |
| `GET /api/previews` | PR preview artifacts joined with live branches |
| `GET /api/watch` | Watcher config, tracked PRs, last sync/error |
| `POST /api/watch/sync` | Reconcile open PRs with preview branches now |
| `GET /api/branches/report?name=<branch>` | Storage + schema report |
| `POST /api/echo` | Echo request body |

## Project layout

```
src/
  index.ts          Bun server + API routes
  dashboard.ts      Single-file dashboard
  db/
    schema.ts       Drizzle schema (baseline)
    client.ts       Connection + Drizzle client
    migrate.ts      Migration runner
    seed.ts         Deterministic seed
    reset.ts        Drop → migrate → seed
    stats.ts        Size and row collection
    schema-snapshot.ts / diff.ts
    sql-file.ts     SQL script runner
    smoke.ts        Environment health checks + write-rollback probe
    features/       Branch-local feature SQL
  neon/
    cli.ts          Neon CLI wrapper
    branches.ts     Branch operations
    report.ts       Storage + schema report
    verify.ts       No-write COW verification
    prune.ts        Retention candidate selection
    reset.ts        Pre-report → reset → migrate → smoke
  ci/
    events.ts       Event parsing, PR validation, branch naming
    preview.ts      Create/recreate/delete/skip orchestration
    previews.ts     Preview artifacts + live branch join for the dashboard
    comment.ts      Sticky PR comment renderer
    run.ts          Branch-scoped child commands + test parsing
  github/
    client.ts       Read-only GitHub REST polling + pagination
    monitor.ts      PR state machine: create/recreate/delete/skip
    service.ts      Poll timer, manual sync, watcher status
  env/
    environments.ts Persistent staging/qa allowlist
  lib/
    duration.ts     30s/30m/24h/7d parsing for TTLs
  cli/              Operator scripts (includes smoke.ts, watch.ts)
.github/workflows/  PR preview + scheduled cleanup
drizzle/            Baseline migrations
docs/               Phase plan and runbook
```

## Notes

- The lab shares **one Neon project** across all watched repositories. Branch
  names are repository-scoped (`preview/<owner>-<repo>-pr-<n>`), which is enough
  for a single-user test setup. Per-repository projects are the productization
  step for multi-tenant use.
- The watcher polls the GitHub API; there is no webhook server, GitHub App, or
  bot comment. It only reads PR metadata and never runs the watched repo's code.
- Keep `prepare: false` on the client: Neon's pooled endpoint is PgBouncer.
- Use `DATABASE_URL_UNPOOLED` for migrations and bulk loads.
- `pg_database_size()` and Neon `logical_size` include inherited COW pages. The
  branch's own growth is the parent→branch delta, which is what Neon bills for a
  child branch (capped at logical size). Pair that with `pg_stat_user_tables`
  write activity; `written_data_bytes` can lag or report `0`.
- A brand-new branch can show `logical size: n/a` in `branch:list` until Neon
  populates `logical_size`. Run `branch:report`; the live `pg_database_size`
  delta should be `0 B` for a branch with no writes.
- The lab started as a Claimable Neon project and is now claimed. Claiming
  rotates the connection string and drops the CLI's pre-claim credential; run
  `neon login` (or set `NEON_API_KEY`) and `neon env pull` if needed. The
  database connection can work while branch management is unauthenticated.
- `bun run branch:report <branch> --neon-diff` adds Neon's own schema diff, at
  the cost of one extra API/CLI round trip.
