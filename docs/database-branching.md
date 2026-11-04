# Autonomous Database Branching Pipeline

A working lab for **copy-on-write Postgres branching** with Neon, Bun, TypeScript,
Drizzle, and the Neon CLI. The destination is a pipeline where every pull
request, CI run, staging environment, and AI-agent sandbox gets its own isolated
database branch, plus automated reporting and cleanup.

- [Why branches](#why-branches)
- [Mental model](#mental-model)
- [Architecture](#architecture)
- [Phase plan](#phase-plan)
- [Phase 1 — baseline + manual branching (current)](#phase-1--baseline--manual-branching-current)
- [Phase 2 — pull request + CI pipeline](#phase-2--pull-request--ci-pipeline)
- [Phase 3 — staging and testing environments](#phase-3--staging-and-testing-environments)
- [Phase 4 — agent sandboxes](#phase-4--agent-sandboxes)
- [Phase 5 — observability, cost, retention](#phase-5--observability-cost-retention)
- [Runbook](#runbook)
- [Reference](#reference)

---

## Why branches

Git branches isolate code. A database branch isolates **data and schema** with
the same shape:

| Concern | Git branch | Neon branch |
| --- | --- | --- |
| Isolated changes | commits | writes become branch-local deltas |
| Cheap to create | pointers | copy-on-write, no full copy |
| Based on a point in time | commit / tag | branch, timestamp, or LSN |
| Merge | merge / rebase | promote a migration, or reset/discard |
| Cost while idle | disk | storage only; compute can scale to zero |

The important property is **copy-on-write (COW)**. A new branch starts with zero
copied data. Reads come from the parent until the branch writes its own version
of a page. Three different numbers describe a branch, and mixing them up makes
COW look broken:

| Number | What it means |
| --- | --- |
| `pg_database_size()` | logical size of one database **including inherited pages** |
| Neon `logical_size` | logical size of the whole branch (all databases), also including inherited pages |
| `logical_size` delta vs parent | only the pages the branch changed or added — the branch-local growth |
| `written_data_bytes` | data written during the current billing period; useful, but can lag or report `0` |
| `pg_stat_user_tables` | branch-compute write counters (inserts / updates / deletes) |

A 19 MB parent with a 19.9 MB branch does **not** mean 19.9 MB was copied. It
means the branch still logically contains the 19 MB it inherited, plus roughly
0.7 MB of its own pages. Neon bills a child branch on the **minimum of
accumulated changes since creation and its logical data size**, so the inherited
copy is not billed again. The report therefore prints the branch delta and an
approximate child-storage number next to the logical sizes.

Measured on this lab:

```text
main              logical 41.5 MB   pg_database_size 19.2 MB
demo-coupons-new  logical 42.3 MB   pg_database_size 19.9 MB
logical delta     +784.0 KB         pg_database_size delta +736.0 KB
branch rows       72,426 inherited + 1,503 inserted
branch writes     1,503 ins / 1,500 upd / 0 del
```

The branch inherited 72,426 rows instead of re-inserting them, and added under
1 MB of new pages. That is COW working. `written_data_bytes` can still read
`0 B` on this project, so treat it as a bonus signal, not proof.

A brand-new branch can show `logical size: n/a` and `Δ parent: —` until Neon
populates `logical_size` asynchronously. That is normal. `branch:report` still
connects to the branch and prints the live `pg_database_size` delta, which should
be `0 B` for a branch with no writes.

Use cases this repo is building toward:

1. **Pull request previews** — one branch per PR, tests run against real schema
   and realistic data, branch deleted when the PR closes.
2. **CI runs** — an ephemeral branch per workflow run, so parallel jobs cannot
   corrupt each other.
3. **Staging / QA** — long-lived branches refreshed from main, with production-
   shaped seed data.
4. **Agent sandboxes** — one branch per agent task, with a TTL and a cheap
   compute size, so an autonomous agent can experiment safely.
5. **Debugging / time travel** — branch from a timestamp before a bad migration
   or incident and inspect the old state without touching production.

---

## Mental model

```
main (protected, production-shaped)
 │
 ├── preview/pr-142      feature schema + test data, TTL 7d
 ├── ci/run-8871         throwaway, deleted after the job
 ├── staging              persistent, reset from main on deploy
 └── agent/task-9f2      agent sandbox, TTL 24h, max 1 CU
```

Rules that keep this safe:

- **Branches are data, not secrets.** Never put production credentials in a
  branch or in an agent sandbox.
- **Migrations are code.** Branch-local SQL is fine for experiments; anything
  that must survive is promoted into `drizzle/` and merged through git.
- **Every ephemeral branch gets an owner, a TTL, and a cleanup path.**
- **Report before delete.** Storage, row deltas, and schema diff are the audit
  trail.

---

## Architecture

```
┌──────────────────────────────┐
│ Bun + TypeScript             │
│                              │
│  src/index.ts    HTTP API    │
│  src/dashboard.ts UI         │
│  src/cli/*       operators   │
│  src/db/*        schema/SQL  │
│  src/neon/*      branch ops  │
└──────────────┬───────────────┘
               │
      ┌────────┴─────────┐
      │                  │
┌─────▼──────┐   ┌───────▼────────────┐
│ postgres.js│   │ neon CLI           │
│ Drizzle    │   │ branch create/list │
│ SQL        │   │ connection-string  │
└─────┬──────┘   │ schema-diff        │
      │          └───────┬────────────┘
      └────────┬─────────┘
               │
        ┌──────▼───────────────────────────────┐
        │ Neon project                          │
        │  main ──┬── preview/pr-142            │
        │         ├── ci/run-8871               │
        │         └── agent/task-9f2            │
        └───────────────────────────────────────┘
```

Why the CLI instead of only the SDK: the CLI works with a signed-in developer
machine, a `NEON_API_KEY` in CI, and the Claimable project used to bootstrap
this lab (now claimed). The wrapper in `src/neon/cli.ts` is the seam to replace with
`@neon/sdk` when the pipeline needs typed API access.

---

## Phase plan

| Phase | Outcome | Status |
| --- | --- | --- |
| 1 | Baseline DB, seed data, manual branch, storage + schema report | Complete; COW verified, retention command added |
| 2 | PR previews and ephemeral CI branches, automatic cleanup | Local simulator + workflow built; GitHub activation pending |
| 3 | Staging/testing branches, refresh and promotion workflow | Small version complete: `staging`/`qa`, safe reset, smoke test |
| 4 | Per-agent sandboxes with TTL, quotas, and guardrails | Planned |
| 5 | Metrics, cost visibility, retention jobs, dashboards | Planned |

---

## Phase 1 — baseline + manual branching (complete)

### Goal

Prove the mechanics on a real database before automating anything:

1. Create a normal Postgres database with a small commerce schema.
2. Seed deterministic, realistic data.
3. Create a branch from it.
4. Add schema and data **only** on the branch.
5. Compare the branch with its parent: storage, rows, schema changes.

### What is implemented

| Piece | Location |
| --- | --- |
| Schema (customers, products, orders, order_items) | `src/db/schema.ts` |
| Baseline migration | `drizzle/0000_baseline.sql` |
| Deterministic seed (2k customers / 200 products / 20k orders) | `src/db/seed.ts` |
| Connection + Drizzle client | `src/db/client.ts` |
| Exact size + row collection | `src/db/stats.ts` |
| Schema snapshot + structural diff | `src/db/schema-snapshot.ts`, `src/db/diff.ts` |
| Neon CLI wrapper | `src/neon/cli.ts`, `src/neon/branches.ts` |
| Branch report | `src/neon/report.ts` |
| COW verifier | `src/neon/verify.ts` |
| Retention selection | `src/neon/prune.ts` |
| Duration parsing | `src/lib/duration.ts` |
| Operator CLI | `src/cli/branch.ts`, `src/cli/stats.ts`, `src/cli/sql.ts`, `src/cli/demo.ts` |
| Branch-only feature SQL | `src/db/features/001-coupons.sql`, `002-coupons-data.sql` |
| API + dashboard | `src/index.ts`, `src/dashboard.ts` |

### Commands

```bash
bun install

# One-time: create .env.local and fill DATABASE_URL + NEON_PROJECT_ID
# (Bun loads .env.local automatically)
cp .env.example .env.local

bun run db:migrate       # apply drizzle migrations
bun run db:seed          # deterministic demo data
bun run db:reset         # drop public schema → migrate → seed
bun run db:stats         # size + exact row counts
bun run db:sql src/db/features/001-coupons.sql --branch <name>

bun run branch:list
bun run branch:create --name demo-coupons --parent main
bun run branch:report demo-coupons
bun run branch:diff main demo-coupons
bun run branch:delete demo-coupons --yes
bun run branch:verify-cow              # create → assert pure COW → delete
bun run branch:prune --older-than 7d   # dry run by default

bun run branch:demo      # branch → feature migration → branch data → report
bun run dev              # dashboard at http://localhost:3000
```

`branch:demo` flags: `--name <branch>`, `--parent <branch>`, `--reuse`,
`--cleanup`, `--json`. Add `--neon-diff` to `branch:report` for Neon's own
schema diff alongside the local one.

The report can also compare **any two databases** without the Neon CLI:

```bash
bun run branch:report --base-url "$BASE_URL" --branch-url "$BRANCH_URL"
```

### Verify copy-on-write

`branch:verify-cow` creates a temporary no-write branch and asserts that it is a
pure COW clone:

```bash
bun run branch:verify-cow
```

```text
COW verification
────────────────────────────────────────────────────────────────────────
Branch  cow-verify-...  (from main)

✔ branch-local size delta is 0 B  (0 B)
✔ row count matches parent  (72,426 rows (72,426 inherited))
✔ no table row/size changes  (all tables identical)
✔ no branch-local writes  (0 ins / 0 upd / 0 del)
✔ schema matches parent  (no differences)

PASS  the branch inherited its parent's data without copying it.
Deleted the temporary verification branch.
```

The verifier is a useful pre-flight check after changing branch tooling, and can
be wired into CI. Use `--keep` to inspect the branch, `--name` to choose its
name, and `--json` for machine-readable output. It exits non-zero if any check
fails.

### Prune stale branches

`branch:prune` lists branches older than a threshold. It is a **dry run unless
you pass `--yes`**, and it never selects `main`, the default/primary branch, a
protected branch, or the configured parent.

```bash
bun run branch:prune                       # dry run, 7d
bun run branch:prune --older-than 24h
bun run branch:prune --prefix preview/ --older-than 7d
bun run branch:prune --prefix preview/ --older-than 7d --yes
```

Durations accept `s`, `m`, `h`, or `d` (for example `30s`, `24h`, `7d`).
Expired branches are selected even if they are younger than the threshold.
`--json` emits the candidate list and deletion results for automation.

### What the report contains

- Branch metadata: id, state, creation time, `written_data_bytes`, CPU seconds.
- Storage: parent/branch logical size, branch-local delta, Neon `logical_size`
  delta, approximate child-branch storage, total rows. The labels say
  "logical, not physical branch allocation" so the inherited pages are not
  mistaken for a full copy.
- Compute-local write activity: inserts / updates / deletes from
  `pg_stat_user_tables` (works even when `written_data_bytes` reports 0).
- Per-table: rows in parent → branch, size in parent → branch, deltas.
- Schema diff: tables, columns (added/removed, plus type/nullability/default
  when changed), indexes, enums.
- Neon's own `branch schema-diff` output as a second opinion (Neon mode only,
  opt in with `--neon-diff`; it costs an extra CLI/API round trip).

### Current lab database

The lab started as a temporary **Claimable Neon** project in
`aws-ap-southeast-1` and has since been **claimed** (`reconciled: true`). It now
lives in the Neon account used to claim it. Project/branch ids and the rotated
connection strings are in `.env.local` (git-ignored) and `.neon`.

Phase 1 has actually run:

```text
bun run branch:demo --name demo-coupons

✔ Branch demo-coupons is ready
✔ Applied 7 statements to demo-coupons

Storage (logical, not physical branch allocation)
Parent data   19.2 MB (neondb, pg_database_size)
Branch data   19.9 MB (neondb: inherited + branch-local)
Branch delta  +736.0 KB (new pages since branch creation)
Neon logical  41.5 MB → 42.3 MB (+784.0 KB) (all databases)
Child storage ~784.0 KB (billed on the branch delta, capped at logical size)
Rows          72,426 → 73,929 (+1,503)
Branch writes +1,503 ins / +1,500 upd / 0 del
Neon writes   0 B (written_data_bytes: lagging/unreliable)

+ table coupons
~ table orders
    + column coupon_code
    + column discount_cents
    + index orders_coupon_code_idx
```

The branch did not copy 19.9 MB. It logically contains the 19 MB it inherited
plus ~0.7 MB of new pages. `written_data_bytes` reported `0 B` for this project
even after the writes; the logical-size delta and `pg_stat_user_tables` activity
are the reliable evidence. The branch is left in place for inspection.

If a branch command reports `Not signed in`, the database connection can still
work — only management API calls are blocked. Authenticate once:

```bash
neon login                            # browser
# or: add NEON_API_KEY=napi_... to .env.local
```

`.neon` already holds the project and branch ids and every command passes
`--project-id`, so `neon link` is optional. Run `neon env pull` if you need to
refresh a rotated connection string.

### Bootstrapping a Claimable project (reference)

For future throwaway labs:

```bash
neon claim create --region-id aws-ap-southeast-1 --env-pull
neon claim accept                     # opens a browser; needs a Neon account
neon claim status                     # wait for reconciled: true
neon login                            # or set NEON_API_KEY
neon env pull                         # claim rotates DATABASE_URL
```

Branch creation is blocked while the project is unclaimed or mid-claim
("not available before claim", "This project is being claimed"). Both are
expected; wait for `reconciled: true`, then authenticate.

To use your own Neon project instead:

1. Create a project in the Neon console (any region).
2. Copy its **pooled** connection string to `DATABASE_URL`, and the direct one
   to `DATABASE_URL_UNPOOLED`.
3. Set `NEON_PROJECT_ID` to the project id.
4. Run `bun run db:reset` and then `bun run branch:demo`.

### Phase 1 done criteria

- [x] Baseline schema + migration applied to a real Neon database.
- [x] Deterministic seed verified (72,426 rows, ~19.2 MB).
- [x] Size/row/schema reporting verified against a real second database.
- [x] Bun API + dashboard running against Neon.
- [x] `branch:demo` executed against a claimed project.
- [x] Branch report includes storage, rows, schema diff, and write activity.
- [x] COW proof: a no-write branch has 0 B delta, 0 writes, and identical rows/schema.
- [x] `branch:verify-cow` makes that proof repeatable and self-cleaning.
- [x] `branch:prune` provides dry-run-first TTL cleanup.
- [x] A branch was deleted through the CLI and confirmed gone from `branch:list`.

---

## Phase 2 — pull request + CI pipeline

### Goal

Every pull request gets an isolated database branch, tests run against it, the
report is posted to the PR, and the branch is deleted when the PR closes.

### Flow

```
pull_request.opened / reopened
  → name = preview/pr-<number>
  → delete stale branch if present
  → neon branch create --parent main --expires-at <+7d>
  → branch connection string → DATABASE_URL for the job
  → bun run src/db/migrate.ts          (inherit main + apply PR migrations)
  → bun test
  → build branch report vs main
  → write report.json + comment.md
  → post/update one sticky PR comment

pull_request.synchronize
  → delete + recreate the branch, then the same steps

pull_request.closed
  → delete preview/pr-<number>

fork pull request
  → skip entirely; no branch, no secrets
```

The default is **inherit + migrate**. The branch starts with the parent's
realistic 72k rows, then the PR's migrations run against that data. Pass
`--reset` to drop the schema, migrate, and reseed from scratch instead.

### What is implemented

| Piece | Location |
| --- | --- |
| Event parsing, PR-number validation, branch naming | `src/ci/events.ts` |
| Preview orchestration (create/recreate/delete/skip) | `src/ci/preview.ts` |
| Sticky comment renderer | `src/ci/comment.ts` |
| Branch-scoped command runner + test summary parsing | `src/ci/run.ts` |
| CLI wrapper | `src/cli/ci.ts` |
| Local artifacts | `artifacts/preview/pr-<n>/report.json`, `comment.md` |
| GitHub Actions wrapper | `.github/workflows/db-preview.yml` |
| Scheduled cleanup backstop | `.github/workflows/db-preview-cleanup.yml` |

### Local simulator

The full pipeline can be exercised without GitHub or a second account. It uses
the Neon credentials already in `.env.local`:

```bash
bun run ci:preview --pr 123 --event opened
bun run ci:preview --pr 123 --event synchronize
bun run ci:preview --pr 123 --event reopened
bun run ci:cleanup --pr 123          # same as --event closed
```

Flags: `--parent`, `--name` (sanitized override), `--expires-in 7d`, `--reset`,
`--no-tests`, `--fork`, `--artifacts-dir`, `--json`.

The command is idempotent: `opened` replaces a stale branch, `synchronize`
always deletes and recreates, and `closed` treats an already-absent branch as
success. Exit code is non-zero on failure.

Fork PRs are simulated with `--fork`; the command skips branch creation and
still writes a comment explaining why.

Output example:

```text
Database preview
────────────────────────────────────────────────────────────────────────
PR         #123 (synchronize)
Status     ✔ READY
Branch     preview/pr-123 (parent main)
Expires    2026-11-10T05:16:50.308Z
Action     recreate — synchronize replaces the branch so no stale schema or data survives

✔ delete existing branch  (3s)
✔ create branch  (6s)
✔ migrate  (1s)
✔ tests  (1s)
✔ report  (7s)

Branch delta
Storage     0 B (new pages since branch creation)
Rows        72,426 → 72,426 (0)
Writes      +0 ins / +0 upd / 0 del
Schema      no changes
```

### GitHub Actions

`.github/workflows/db-preview.yml` is a thin wrapper around the same CLI. It
checks out the PR commit, installs Bun and the Neon CLI, runs
`src/cli/ci.ts preview`, uploads artifacts, and posts/updates one sticky comment
using the `<!-- db-preview-report -->` marker.

Repository setup:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `NEON_API_KEY` | Create/delete branches and read connection strings |
| Variable | `NEON_PROJECT_ID` | Select the Neon project |

Permissions are `contents: read` and `pull-requests: write`. A concurrency
group per PR cancels superseded `synchronize` runs but never cancels `closed`.

**Fork policy.** The job has:

```yaml
if: github.event.pull_request.head.repo.full_name == github.repository
```

Fork PRs are skipped because `pull_request` runs from forks receive no
repository secrets and a read-only token. Using `pull_request_target` to regain
them would execute untrusted code with secret access, so this pipeline does not
use it. A fork PR never creates a branch, so there is nothing to clean up.

`.github/workflows/db-preview-cleanup.yml` runs daily and on demand:

```bash
bun run branch:prune --prefix preview/ --older-than 7d --yes
```

### Activating on GitHub

The local flow is complete; real Actions runs only need repository configuration.
No personal password or token needs to be shared with anyone:

1. Push the repo (or a copy) to a repository you control.
2. In the Neon console, create an API key scoped to the project.
3. In GitHub: **Settings → Secrets and variables → Actions**.
   - Secret `NEON_API_KEY` = the Neon API key.
   - Variable `NEON_PROJECT_ID` = the Neon project id.
4. Open a pull request from a branch **in the same repository**. The workflow
   creates `preview/pr-<n>`, runs migrations/tests, and posts the sticky report.
5. Push another commit to see `synchronize` replace the branch, then close the
   PR to see it deleted.
6. To test the fork policy, fork the repo with a second account and open a PR.
   The job is skipped, because fork runs get no secrets.

A separate bot account or organization-owned repo is preferable to maintaining
a second personal account. The pipeline never needs the account credentials
themselves — only the two repository settings above.

### Local dashboard

`bun run dev` (http://localhost:3000) reads the preview artifacts and joins them
with the live Neon branch list. The **Pull request previews** table shows, per
PR: the event, run status, branch name, live branch state and logical size,
expiry, row/storage delta, and last run time. **Show run** prints the recorded
steps, tests, report summary, and sticky comment; **Report** compares the branch
with its parent on demand.

Preview branches that exist in Neon but have no local artifact still appear,
marked `branch-only`, so an orphaned branch is never hidden. The data comes from
`GET /api/previews`, which reads `artifacts/preview/*/report.json` and tolerates
a missing artifact directory or an unreachable Neon CLI.

### Phase 2 done criteria

- [x] Deterministic name `preview/pr-<number>` with sanitization and validation.
- [x] `opened` / `reopened` create or replace the branch with a 7-day expiry.
- [x] `synchronize` deletes and recreates the branch.
- [x] `closed` deletes the branch; a second close is a no-op.
- [x] Fork PRs skip without using secrets.
- [x] Migrations, tests, and the report run against the branch connection.
- [x] Migrations run with `DATABASE_URL`/`DATABASE_URL_UNPOOLED` scoped to the branch.
- [x] Report + comment artifacts are written for every outcome.
- [x] Connection strings are redacted from captured command output.
- [x] Local lifecycle verified on Neon: opened → synchronize → fork skip → closed.
- [x] 7-day `expires_at` confirmed through the Neon API.
- [x] `--reset` path verified (72,426 inserts, report shows the branch delta).
- [x] A real new migration applied only on the preview branch; the report showed
  `+ table preview_smoke` and a `16.0 KB` branch delta. The temporary migration
  was reverted after the test.
- [ ] Activate the workflow on a repo with `NEON_API_KEY` and `NEON_PROJECT_ID`.
- [ ] Prove two PRs run in parallel without interference.
- [ ] Decide whether to add a maintainer `workflow_dispatch` for fork PRs.

### Guardrails

- Never print a connection string; `src/ci/run.ts` redacts it from child output.
- Do not run PR code against `main` or staging branches; the branch is the target.
- Always set `--expires-at` as a backstop even if PR cleanup fails.
- Never use `pull_request_target` to run PR code.
- Branch creation uses `--no-secrets`; the connection string is fetched per run.
- Free-plan projects allow 10 branches. The cleanup job and 7-day expiry keep
  previews from crowding out demo branches.

---

## Phase 3 — staging and testing environments (small version complete)

### Goal

Give long-lived environments their own branches and make refresh boring and safe:

| Environment | Branch | Data | Lifetime |
| --- | --- | --- | --- |
| Production | `main` | real | permanent |
| Staging | `staging` | inherited deterministic seed | permanent, reset on demand |
| QA / testing | `qa` | inherited deterministic seed | permanent, reset on demand |
| PR preview | `preview/pr-<n>` | seeded | 7 days |
| CI run | `ci/<run-id>` | schema-only + seed | job duration |

The implemented version covers the operational core: persistent `staging` and
`qa` branches, a guarded reset, a pre-reset report, and a post-reset smoke test.
Anonymized staging data and point-in-time incident branches stay deferred until
there is a real production dataset.

### What is implemented

| Piece | Location |
| --- | --- |
| Environment allowlist (`staging`, `qa`) | `src/env/environments.ts` |
| Ensure/reset orchestration | `src/neon/reset.ts` |
| Native reset to parent | `src/neon/branches.ts` (`resetBranchToParent`) |
| Smoke test (tables, rows, migrations, write rollback) | `src/db/smoke.ts` |
| Standalone smoke CLI | `src/cli/smoke.ts` |
| Pre-reset + smoke artifacts | `artifacts/environments/<name>/` |

### Commands

```bash
bun run branch:ensure --all          # create staging and qa if missing
bun run branch:ensure staging        # idempotent single environment
bun run branch:reset staging         # dry run: pre-reset report + plan
bun run branch:reset staging --yes   # refresh: reset → migrate → smoke
bun run db:smoke --branch staging    # standalone health check
```

### Reset flow

```text
branch:reset <staging|qa>
  → verify the name is in the environment allowlist
  → capture a pre-reset report (rows, storage delta, writes, schema diff)
  → write artifacts/environments/<name>/pre-reset.json
  → without --yes: stop here (dry run)
  → with --yes: neon branch reset <name> --parent
  → apply migrations
  → smoke test: baseline tables exist, have rows, migrations recorded,
    transactional write/read/rollback succeeds
  → write smoke.json
```

The native `neon branch reset --parent` restores the branch's logical contents
without changing its id or connection string. That keeps environment URLs
stable across refreshes.

Example pre-reset snapshot after a test table was added:

```text
Status       → PLANNED

Pre-reset snapshot
Storage      +32.0 KB (branch-local since creation)
Rows         72,426 → 72,427 (+1)
Writes       +1 ins / +0 upd / 0 del
Schema       changes detected
```

After `--yes`, the same branch reported `sizeDeltaBytes: 0`, `rowDelta: 0`, and
`hasChanges: false`; the smoke test passed all four checks with 72,426 baseline
rows. `qa` was refreshed the same way.

### Safety

- Reset only accepts `staging` or `qa`. `main`, `preview/pr-*`, and ad-hoc
  branches are rejected by the allowlist.
- Replacing an existing environment requires `--yes`; otherwise the command is
  a dry run that still writes the pre-reset snapshot.
- Default, primary, and Neon-protected branches are refused even if renamed.
- Environment branches have no expiry and are excluded from `branch:prune`.
- The pre-reset report is written **before** the destructive call, so the last
  state is inspectable even if the refresh fails.
- `branch:reset` restores logical contents; Neon may retain billing/history
  pages, so the logical-size delta is not guaranteed to drop to zero.

### Phase 3 done criteria

- [x] Persistent `staging` and `qa` branches created from `main`.
- [x] Environment allowlist; `main` and arbitrary branches cannot be reset.
- [x] `--yes` gate with a safe dry-run default for existing environments.
- [x] Pre-reset report with rows, storage, writes, and schema diff.
- [x] Pre-reset artifact written before the destructive step.
- [x] Reset uses native `branch reset --parent` and preserves branch id/URL.
- [x] Migrations re-applied after reset.
- [x] Smoke test validates tables, rows, migration history, and write rollback.
- [x] Smoke artifacts written; standalone `db:smoke` command added.
- [x] `branch:prune` excludes `staging` and `qa`.
- [x] Locally verified: modify staging → dry run captures changes → `--yes`
  removes them → report is clean → smoke passes; `qa` and safety paths tested.
- [ ] Anonymized staging seed (deferred until real data exists).
- [ ] Scheduled daily `qa` reset.
- [ ] Point-in-time incident branches.
- [ ] Promotion automation from merge → reset.

### Future Phase 3 work

- **Anonymized staging data:** add `bun run db:seed:staging` once there is a
  production dataset, and stop inheriting production-shaped rows.
- **Scheduled QA reset:** run `branch:reset qa --yes` from a nightly workflow.
- **Incident branches:**

  ```bash
  neon branch create --name incident/2026-11-02 \
    --parent "main@2026-11-02T08:00:00Z"
  ```

- **Promotion automation:** after a merge to `main`, reset `staging`, run the
  smoke test, and only then allow deployment.

---

## Phase 4 — agent sandboxes

### Goal

Let autonomous agents create isolated databases for tasks without giving them
production data or unlimited spend.

### Sandbox contract

| Property | Value |
| --- | --- |
| Branch name | `agent/<task-id>` |
| Parent | `main` (or a schema-only template) |
| Data | seed only; no production PII |
| TTL | 24 hours (hard `--expires-at`) |
| Compute | fixed small size, e.g. `--cu 0.25-1` |
| Suspend | 300 seconds idle |
| Credentials | branch-scoped role, never the owner role |
| Cleanup | automatic expiry + sweep job |

### Flow

```
agent task starts
  → POST /sandboxes { taskId }
  → create branch agent/<taskId> with TTL + compute caps
  → return DATABASE_URL + branch id (scoped, short-lived)
  → agent migrates / experiments / runs tests
  → agent requests report
  → sandbox expires or is deleted
```

### Phase 4 tasks

- [ ] Add a `POST /api/sandboxes` endpoint that enforces the contract.
- [ ] Add per-agent quotas (max branches, max CU-hours, max storage delta).
- [ ] Add `DELETE /api/sandboxes/:id` and a daily reaper for expired branches.
- [ ] Add a read-only role for inspection-only agents.
- [ ] Log every sandbox creation/deletion with task id and reason.
- [ ] Add a budget alarm when `written_data_bytes` crosses a threshold.

### Safety notes

- An agent must never receive `DATABASE_URL` for `main` or staging.
- Prefer a schema-only branch plus seed for speed; use a full branch only when
  the task needs realistic inherited data.
- Treat agent-generated SQL as untrusted: run it on the sandbox branch, never on
  a shared branch.
- Reap on both expiry and explicit task completion; TTL alone is not enough.

---

## Phase 5 — observability, cost, retention

### Metrics to track

| Metric | Source | Why |
| --- | --- | --- |
| `logical_size` delta vs parent | Neon API / `branch list` | branch-local logical growth (the COW delta) |
| `written_data_bytes` | Neon API / `branch list` | data written this billing period (can lag / be 0) |
| `pg_stat_user_tables` writes | SQL | inserts / updates / deletes on the branch compute |
| `pg_database_size()` | SQL | total logical size (includes inherited pages) |
| table/index size | SQL | which tables changed |
| exact rows | SQL | data divergence |
| schema diff | information_schema + `neon schema-diff` | migration review |
| CPU seconds | Neon API | compute cost per branch |
| branch age | Neon API | retention / stale branch detection |

`pg_database_size` alone is misleading for a COW branch: a fresh branch can look
as large as its parent while costing almost nothing. Pair it with the parent
delta and `pg_stat_user_tables` write activity. Treat `written_data_bytes` as a
bonus signal: some projects report `0` until metrics flush, or do not report it
at all.

### Retention policy (proposal)

| Branch type | TTL | Sweep |
| --- | --- | --- |
| `ci/*` | job duration | delete in `finally` |
| `preview/pr-*` | 7 days | PR close + nightly sweep |
| `agent/*` | 24 hours | expiry + nightly sweep |
| `staging`, `qa` | permanent | manual refresh only |
| `incident/*` | 14 days | nightly sweep |

### Phase 5 tasks

- [ ] Persist branch reports to a `branch_reports` table or object storage.
- [ ] Add a `/api/branches` view with age, TTL, writes, and last report.
- [ ] Add a nightly reaper with a dry-run mode and a report of what it deleted.
- [ ] Add alerts for branches without an owner or past TTL.
- [ ] Add a cost dashboard (branch × CU-hours × storage).
- [ ] Add a "stale branch" report to the weekly ops review.

---

## Runbook

### First setup

```bash
bun install
cp .env.example .env.local
# fill DATABASE_URL, DATABASE_URL_UNPOOLED, NEON_PROJECT_ID
bun run db:reset
bun run dev
```

### Check the current database

```bash
bun run db:stats
bun run db:stats --branch demo-coupons
bun run db:stats --url "$SOME_CONNECTION_STRING" --json
```

### Create a branch and inspect it

```bash
bun run branch:create --name demo-coupons --parent main
bun run branch:report demo-coupons
bun run branch:delete demo-coupons --yes
```

### Run the full feature experiment

```bash
bun run branch:demo --name demo-coupons
# then, when finished:
bun run branch:delete demo-coupons --yes
```

To repeat cleanly, delete first or use a new name:

```bash
bun run branch:delete demo-coupons --yes
bun run branch:demo --name demo-coupons

# or one-shot (create → report → delete)
bun run branch:demo --name demo-coupons-tmp --cleanup
```

`--reuse` is not a clean reset: it applies the demo data SQL again, adding
another 500 orders to the existing branch.

### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `DATABASE_URL is not set` | `.env.local` missing | copy `.env.example`, fill values |
| `NEON_PROJECT_ID is not set` | branch command without a project | add it to `.env.local` |
| `not available before claim` | Claimable project not claimed | `neon claim accept`, or use a claimed project |
| `This project is being claimed` | claim transfer started but not finished | `neon claim status`; if `reconciled: true`, authenticate the CLI and run `neon env pull` |
| `Not signed in` / `no stored credential` | CLI has no account credential | `neon login` or add `NEON_API_KEY` to `.env.local` |
| `password authentication failed` | stale URL after claim/reset | `neon env pull` |
| `prepared statement already exists` | pooled endpoint | keep `prepare: false` (already set) |
| migrations hang | using pooled URL for DDL | use `DATABASE_URL_UNPOOLED` |
| report shows 19.9 MB branch, parent 19.2 MB | branch logical size includes inherited COW pages | read `Branch delta` / `Neon logical` delta, not the absolute size |
| `branch:list` shows `logical size: n/a` for a new branch | Neon has not populated `logical_size` yet | run `branch:report`; `pg_database_size` and its delta are live |
| `0 B` Neon writes / `written_data_bytes` | lagging or unreported metric | use the logical-size delta and `pg_stat_user_tables` writes |

### Delete the lab project

The project is claimed now, so it is a normal Neon project. Delete it in the
Neon console (Project settings → Delete project). That removes `main`, the
`demo-coupons` branch, and every other branch in the project.

Only do this when you no longer need the baseline data.

---

## Reference

### Schema

```
customers ──< orders ──< order_items >── products
```

- `customers`: email (unique), full name, plan enum (`free|pro|enterprise`).
- `products`: sku (unique), name, price in cents, active flag.
- `orders`: customer, status enum, total cents, created_at.
- `order_items`: order, product, quantity, unit price in cents.

### Branch-local feature (demo)

`src/db/features/001-coupons.sql` adds:
- `coupons` table (code, description, percent_off, max_redemptions, expires_at)
- `orders.coupon_code`
- `orders.discount_cents`
- `orders_coupon_code_idx`

`002-coupons-data.sql` adds coupons, discounts on 1,500 inherited orders, and
500 branch-local orders with items. Main never sees any of it.

### Useful Neon CLI commands

```bash
neon branch list --project-id <id>
neon branch create --name <branch> --parent <parent> --project-id <id>
neon connection-string <branch> --project-id <id> --pooled
neon branch schema-diff <base> <compare> --project-id <id>
neon branch delete <branch> --project-id <id>
neon branch reset <branch> --project-id <id>
neon claim list
neon claim accept
neon claim delete --yes
```

### Environment variables

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | server, scripts | pooled connection |
| `DATABASE_URL_UNPOOLED` | migrations, reset, seed | direct connection |
| `NEON_PROJECT_ID` | branch commands | required |
| `NEON_DATABASE_NAME` | connection strings | default `neondb` |
| `NEON_PARENT_BRANCH` | branch create/report | default `main` |
| `NEON_BRANCH` | report | branch `DATABASE_URL` points at; avoids an extra CLI call |
| `NEON_API_KEY` | CI | only when the CLI is not signed in |
| `DB_POOL_SIZE` | server | default 5 |
| `PORT` / `HOST` | server | default 3000 / 0.0.0.0 |

### Design decisions

- **CLI over SDK for now.** Works with a local login, CI API keys, and the
  Claimable lab. Swap `src/neon/cli.ts` for `@neon/sdk` when typed automation is
  needed.
- **Baseline schema in Drizzle, experiments in SQL.** `drizzle/` is the source
  of truth for main; `src/db/features/` is branch-local and disposable.
- **Exact row counts.** Fine at demo scale; switch to estimates at 10M+ rows.
- **Reports are JSON-first.** `--json` makes the same report usable in a PR
  comment, a dashboard, or a stored audit record.
