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
| `bun run branch:reap [--older-than 7d] [--repo <owner/name>] [--yes]` | TTL reaper: delete expired/stale `preview/` branches (dry run by default) and log the run |
| `bun run branch:demo` | Create branch → feature SQL → branch data → report |
| `bun run branch:report --base-url U --branch-url U` | Compare any two databases |
| `bun run ci:preview --pr <n> --event <event>` | Local PR preview: create/recreate → migrate → test → report |
| `bun run ci:preview --repo <owner/name> --pr <n> [--ref <sha>] [--backend local\|vercel] [--review]` | Subject-owned preview: branch in the repo's Neon project and run its own contract |
| `bun run ci:cleanup --pr <n>` | Delete a preview branch (closed event) |
| `bun run ci:cleanup --repo <owner/name> --pr <n>` | Delete a watched repo's preview branch |
| `bun run watch --repo <owner/name>` | One pass over an external repo's open PRs → branches |
| `bun run watch:loop --repo <owner/name>` | Poll an external repo continuously (default 120s) |
| `bun run preview:contract --path <repo>` | Resolve a repo's preview contract without executing it (`--json`) |
| `bun run preview:sandbox --repo <repo>` | Check out a ref and run the contract in a throwaway sandbox (`--backend local\|vercel`, `--steps`, `--ref`, `--keep`, `--json`) |
| `bun run quota [--repo <owner/name>]` | Read-only guardrail usage vs limits (`--json`) |
| `bun run qa` | Deterministic QA preflight in a disposable checkout (`--json`, `--no-install`) |
| `bun run qa:agent` | Preflight + bounded test-and-fix agent (`--sandbox local\|vercel`, `--apply`, `--keep`, `--max-steps`, `--model`) |

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

The **Branches** table has a **Delete** button for ad-hoc and preview branches.
The **Pull request previews** table also offers **Delete** for any live preview
branch. Both ask for confirmation, delete the branch on Neon, and refresh the
page. The server refuses the default, primary, or Neon-protected branch, the
configured parent, `main`, `staging`, and `qa`; protected buttons are disabled.
Deleting a branch that belongs to an open watched PR marks the watcher state so
the next sync recreates it.

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

- Fork PRs are never executed by the watcher (same-repository heads only; an
  unknown head repo is also skipped). Fork execution remains opt-in and blocked
  until the Vercel Sandbox path is explicitly approved and verified for a
  repository. Same-repository PRs can use either `local` (default) or the
  opt-in Vercel backend; they inherit no Aikya credentials.
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

## Preview contract (W0)

A preview needs to know how the watched repository installs, migrates, seeds,
builds, tests, and runs itself. Aikya resolves that as a **contract** before it
executes anything:

```bash
bun run preview:contract --path ../gh-lab
bun run preview:contract --path ../gh-lab --json
```

Resolution has three tiers, in order:

1. **Manifest** — `.aikya/preview.yml` (or `.yaml` / `.json`) committed by the
   repository. This is the reproducible path.
2. **Detection** — infer from `package.json`, lockfiles, `drizzle.config.*`,
   `drizzle/` or `migrations/`, and `.env.example`. Detection is best-effort and
   always prints a warning that a manifest is recommended.
3. **Fail closed** — no manifest and no `package.json` means no preview. The
   command exits non-zero; it never guesses a command.

A minimal manifest:

```yaml
# .aikya/preview.yml
version: 1
commands:
  install: bun install --frozen-lockfile
  migrate: bun run db:migrate
  seed: bun run db:seed
  test: bun run test
app:
  command: bun run dev
  port: 3000
env:
  required: [DATABASE_URL]
database:
  required: true
  provider: neon
migrations:
  dir: drizzle
```

Omitted commands fall back to detection, then are reported as skipped. Unknown
manifest keys are warnings; wrong types are errors that name the file and field.
`.env.example` lists **names only**; values stay in the control plane and are
never read by this command.

The contract is data, not execution. It is the input to W1 (sandbox runner) and
W2 (subject-owned database branches); see the workstream plan in
`docs/database-branching.md`.

Current finding for the external test repo:

```text
bun run preview:contract --path ../gh-lab
source      detected
database    not required
test        skipped   (no test script)
```

W0 exposes the gap deliberately: `gh-lab` has no preview contract yet, so there
is nothing meaningful to migrate or test until the repo declares one.

## Local sandbox (W1)

`preview:sandbox` checks out a repository at a ref, resolves its contract from
that checkout, and runs the configured steps in a throwaway directory.

```bash
bun run preview:sandbox --repo ../gh-lab --steps test
bun run preview:sandbox --repo ../gh-lab --ref <sha> --steps test
bun run preview:sandbox --repo <git-url> --ref refs/pull/123/merge --steps install,test
bun run preview:sandbox --repo ../gh-lab --steps test --env DATABASE_URL=... --keep
```

What it does:

- clones a local git repository or git URL; copies a plain directory
- checks out `--ref` (SHA, branch, or `refs/pull/<n>/merge`)
- resolves the contract **inside the checkout**, so the PR's own manifest wins
- runs `install → migrate → seed → build → test`, or the steps you pass
- enforces a per-step timeout (`--timeout 10m`), output cap (`--max-output`),
  and process-tree kill
- scrubs the environment: only `PATH`, home, and temp variables pass through,
  plus explicit `--env KEY=VALUE`; `DATABASE_URL`, `NEON_API_KEY`, and
  `GITHUB_TOKEN` are **not** inherited
- deletes the checkout in `finally`; `--keep` preserves it for inspection
- supports `--json` for machine-readable results

Example output:

```text
Sandbox run
────────────────────────────────────────
source      C:\...\aikya-demo-repo
contract    manifest (.aikya/preview.yml)
result      ok in 1s

✔ test     1s · exit 0
```

Important: this is the **local lab backend**, not a security boundary. It
reduces accidents, but fork PRs stay skipped until the container/Vercel Sandbox
backend exists. The runner keeps a stable `SandboxResult` so that backend can
replace only checkout preparation and step execution.

## Vercel Sandbox backend (optional)

The repository runner supports an isolated Vercel Sandbox backend in addition
to the local lab backend:

```bash
# Authenticate the Vercel CLI and pull a development OIDC token first.
vercel link
vercel env pull

bun run preview:sandbox --backend vercel \
  --repo https://github.com/owner/repo.git \
  --ref <sha> --steps test

bun run ci:preview --repo owner/repo --pr 123 --backend vercel
```

A registry entry can opt in without touching the command line:

```json
{
  "repo": "owner/repo",
  "backend": "vercel",
  "vcpus": 2,
  "region": "iad1",
  "networkPolicy": "allow-all"
}
```

Current rules and limitations:

- This is **opt-in**; `local` remains the default until the remote path is
  verified for your Vercel project.
- The source must be a **public HTTPS git URL** (or a local git repository
  with a public HTTPS `origin`). Plain local directories fail closed because
  Vercel cannot copy them.
- SSH remotes and credentials embedded in the URL are refused.
- The sandbox uses `vercel/sandbox/universal` by default (Node.js and Bun are
  present); override with `image` in the registry.
- `networkPolicy` defaults to `allow-all` so package registries work. Use
  `deny-all` only for contracts with no network dependency.
- The sandbox is created with `persistent: false` and deleted after the run;
  orphan snapshots are requested for cleanup.
- No Neon or GitHub credentials are copied into the sandbox. Each command
  receives only `CI=1`, `AIKYA_SANDBOX=1`, and explicitly injected values such
  as the branch-scoped `DATABASE_URL`.
- Per-command output is capped (`--max-output`), and command timeouts kill the
  process inside the microVM.
- The remote path still needs a one-off verification with `vercel link` before
  fork PRs or private repositories can be trusted. Same-repository PRs remain
  the only supported execution target for now.
- For private repositories, use a public fork exclusively for testing, or add a
  credential-brokered network policy after the baseline path is verified.

If Vercel authentication or project linking is missing, the run fails before a
preview branch is created/verified; it never falls back to running the code on
the host.

## Subject-owned previews (W2)

A watched repository is **not** a consumer of Aikya's database. Its preview
branch belongs to the Neon project registered for that repository, and the PR's
own migration commands run against it. Aikya's own `preview/pr-<n>` workflow
remains unchanged.

### Registry

`config/repos.json` is committed and carries no secrets. It names the project,
its parent branch, the database, and the environment variable holding the Neon
key:

```json
{
  "repo": "7TIN/gh-lab",
  "projectId": "flat-resonance-58366530",
  "parent": "main",
  "apiKeyEnv": "NEON_API_KEY_7TIN_GH_LAB",
  "source": "https://github.com/7TIN/gh-lab.git",
  "database": "neondb",
  "stepTimeoutMs": 600000,
  "backend": "vercel"
}
```

`backend` is optional and defaults to `local`; use `vercel` only after linking
Vercel and verifying the run for that repository.

`config/repos.local.json` is gitignored and **replaces** the committed entry for
the same repo. Use it for local checkouts, a lab project id, or a different
machine-specific key variable.

Rules:

- A watched repo without a registry entry fails closed; Aikya's migrations are
  never applied to it.
- If `apiKeyEnv` is a variable name and that variable is missing, the repo
  sync reports a configuration error and no branch is created. It never falls
  back to `NEON_PROJECT_ID` / `NEON_API_KEY`.
- `"apiKeyEnv": null` explicitly selects the local Neon CLI login (useful in
  the lab). The child process still has ambient `NEON_API_KEY` removed.
- `source` may be a local path or a git URL; omitted means the GitHub repo.
- `steps`, `envFrom`, `database`, `stepTimeoutMs`, `quota`, `review`, and the
  Vercel settings (`vcpus`, `region`, `image`, `networkPolicy`,
  `sandboxTimeoutMs`) are optional and are ignored by the local backend.
- `backend` is `local` unless explicitly set to `vercel`. Vercel still refuses
  plain local directories, private/SSH sources, and credentials embedded in
  URLs.
- Relative `source` / `envFrom` paths are resolved from the registry file.
- `role` is reserved for branch-scoped role minting; it is not applied yet.

`main` is the usual parent for the shared lab project. A separate subject
project works too: change `projectId` and the key variable without any code
changes.

### Running a subject preview

```bash
bun run ci:preview --repo 7TIN/gh-lab --pr 123 --ref <sha>
bun run ci:preview --repo 7TIN/gh-lab --pr 123 --backend vercel
bun run ci:preview --repo 7TIN/gh-lab --pr 123 --event closed
```

For the watcher, open/synchronize passes the PR head SHA as `--ref`; deleting
the PR (or its branch) uses the same subject context. The preview report and
all step logs (`report.json` → `steps[].output`) appear in
`artifacts/preview/<repo>-pr-<n>/`.

What happens inside a run:

1. Create/replace `preview/<owner>-<repo>-pr-<n>` in the **subject** project.
2. Fetch the PR head into the selected sandbox backend (`local` by default,
   or `vercel` when the registry/CLI opts in).
3. Resolve the contract inside that checkout.
4. Run the repo's `install`, `migrate`, `seed`, `build`, and `test` against the
   branch's `DATABASE_URL`; every other credential is scrubbed.
5. Compare the subject parent vs the preview branch.
6. A failing migration marks the run failed; a `closed` event deletes the branch.

### Verified in the lab

Because the lab's `gh-lab` initially had no preview contract, W2 was first
verified with a gitignored local fixture in the shared lab project:

- the migration added `customers.preview_note` in the preview branch only;
- the report showed `+ column preview_note` and `+1` row;
- `main` had zero `preview_note` columns afterwards;
- a deliberately failing migration exited non-zero and was cleaned up;
- `--event closed` deleted the created branches; only `main`, `qa`, and
  `staging` remain.

`gh-lab` now declares `.aikya/preview.yml` (install/migrate/test) on the
`feature/aikya-preview-manifest` branch. A live Vercel Sandbox run on that
branch completed all deterministic steps and its report showed
`customers.preview_note` added only on the preview branch.

The runner also has a Vercel Sandbox backend, selected with
`--backend vercel` or `"backend": "vercel"` in the registry. Local remains the
fallback for repos that do not opt in; the backend refuses local directories,
private/SSH sources, and credentials embedded in URLs.

The committed registry names `NEON_API_KEY` for `7TIN/gh-lab` so fresh clones
fail closed until the subject key exists. The lab uses a gitignored
`config/repos.local.json` with `"apiKeyEnv": null` (explicit CLI login), the
shared project id, and the same Vercel + reviewer settings.

## Advisory reviewer explorer (W3)

The reviewer is a **deterministic, bounded explorer** inside the Vercel
sandbox — not an LLM call. It runs only when a repo opts in:

```json
{
  "review": {
    "enabled": true,
    "paths": ["/", "/health"],
    "timeoutMs": 90000
  }
}
```

After the deterministic steps pass, it:

1. Starts `app.command` in the sandbox and waits for it to answer on its port.
2. Probes each configured HTTP path and records a capped body snippet.
3. Runs one read-only `information_schema` table query using the branch-scoped
   `DATABASE_URL`.
4. Captures a capped tail of the app logs.

Findings are written to `report.json` → `review` and rendered as an
**advisory** section in `comment.md`. A failed probe never changes the
deterministic READY/FAILED outcome and never gains branch-management or
control-plane credentials.

Local previews skip the reviewer with `reviewer requires the Vercel backend`,
because starting the app on the host would break the sandbox boundary.

## Guardrails (W4)

Every watched repository runs behind per-repo caps. A run that would exceed a
cap is refused **before** the branch is touched, so the preview that is already
live stays live.

```json
{
  "quota": {
    "maxBranches": 5,
    "maxStorageDeltaBytes": 268435456,
    "maxSandboxMinutesPerDay": 20,
    "maxCreatesPerHour": 10
  }
}
```

| Limit | Counts | Source |
| --- | --- | --- |
| `maxBranches` | current `preview/<owner>-<repo>-pr-<n>` branches | Neon branch list |
| `maxStorageDeltaBytes` | newest positive `branch.report` delta per live branch | event log |
| `maxSandboxMinutesPerDay` | completed preview-run time, rolling 24h | event log (`sync.finished`) |
| `maxCreatesPerHour` | `branch.created`, rolling 1h | event log |

Precedence is registry `quota` → `AIKYA_QUOTA_*` environment → built-in
defaults (10 branches, 512 MiB, 30 min, 20/hour). A refusal:

- returns a failed preview whose error contains the limit and current usage;
- appends a `quota.exceeded` event with the full usage snapshot;
- does **not** delete or recreate the existing preview branch.

```text
Quota exceeded for 7TIN/gh-lab: 3 preview branches for 7TIN/gh-lab
(limit 2 branches; used 3)
```

```bash
bun run quota                      # usage vs limits for every registered repo
bun run quota --repo 7TIN/gh-lab --json
```

The dashboard **Quotas** panel shows the same numbers. The watcher additionally
refuses to delete a branch whose name is not exactly the one it created for that
PR, so a corrupted state file cannot target `main` or an environment branch.

## Retention and the TTL reaper (W4)

```bash
bun run branch:reap                                  # dry run, preview/ branches older than 7d + expired
bun run branch:reap --older-than 3d --json
bun run branch:reap --repo 7TIN/gh-lab --yes         # delete in the subject project
```

The reaper uses the same guards as `branch:prune`: never `main`, the configured
parent, a default/primary/Neon-protected branch, or `staging`/`qa`. It defaults
to the `preview/` prefix, so ad-hoc branches are out of scope. Every run
appends `reap.completed` to the event log; each deletion appends
`branch.deleted` with `reason: reaper:<expired|age>`.

The dashboard **Retention** panel has a **Dry-run prune** button. It calls
`GET /api/branches/prune`, which lists exactly what would be deleted and always
returns `deleted: []` — deletion is CLI-only, behind `--yes`.

The **Branches** table adds retention warnings per branch:

| Warning | Meaning |
| --- | --- |
| `expired` | `expiresAt` has passed |
| `stale` | older than 7 days with no elapsed TTL |
| `missing-owner` | repo-scoped preview with no tracked PR in the watcher state (only computed when the watcher is configured) |

Warnings are informational; the reaper decides eligibility independently.

## QA agent (W5)

`bun run qa` proves the build the way a human does it, but in a disposable copy:
copy the working tree → `bun install` → `bun run typecheck` → `bun test` →
`bun run build` → boot the server on an ephemeral port and probe `/`,
`/api/watch`, `/api/events`, `/api/health`, and `POST /api/echo`. It writes a
JSON report and appends `qa.completed` to the event log. `--no-smoke` skips the
HTTP probe; `--no-checks` skips everything so only the agent runs.

`bun run qa:agent` adds a **small** fix loop on top:

```bash
bun run qa:agent                                  # local temp checkout
bun run qa:agent --sandbox vercel                 # dedicated Vercel MicroVM
bun run qa:agent --max-steps 6 --apply            # apply the patch, never commit
bun run qa:agent --model gpt-4.1-mini --json
```

The model gets eight tools: `list_files`, `read_file`, `search`, `write_file`,
`delete_file`, `run_command`, `git_diff`, and `done`. Everything runs through a
guard: no paths outside the checkout, no dotenv files, no git mutations, no
dependency changes, no network commands, no cloud/GitHub CLIs, and a 200 KB
write budget. The loop stops after 12 steps or 8 minutes, whichever comes first.

The agent never runs inside the PR preview sandbox. QA uses its own checkout
(local temp copy or a separate Vercel Sandbox) with a scrubbed environment; the
model API key stays on the host. The result is a patch under `artifacts/qa/` —
`--apply` applies it to the working tree after `git apply --check`, but QA never
commits, pushes, or deploys.

```text
Aikya QA
Run         qa-20261112T155000Z-edvy
Sandbox     local
Preflight
  ✔ typecheck    7.4s
  ✔ test         16.4s
  ✔ build        0.6s
  ✔ smoke        0.4s
✔ OK
```

If no model key is configured, `qa:agent` fails with a clear message; plain
`bun run qa` needs no key.

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
| `GET /api/branches` | Neon branches + logical size + writes + retention warnings |
| `GET /api/branches/prune?older-than=7d&prefix=preview/` | Read-only prune preview: lists candidates, deletes nothing |
| `DELETE /api/branches?name=<branch>` | Delete a non-protected branch (dashboard button) |
| `GET /api/previews` | PR preview artifacts joined with live branches |
| `GET /api/watch` | Watcher config, tracked PRs, last sync/error |
| `POST /api/watch/sync` | Reconcile open PRs with preview branches now |
| `GET /api/events?limit=&repo=&branch=&since=` | Recent branch/sandbox/review events |
| `GET /api/cost` | Estimated storage, compute, and sandbox cost by branch |
| `GET /api/quotas` | Per-repo guardrail usage against limits |
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
    retention.ts    Expired/stale/missing-owner warnings
    reaper.ts       TTL reaper (dry-run default) + run logging
    reset.ts        Pre-report → reset → migrate → smoke
    delete.ts       Protected-branch guard for dashboard deletion
  ci/
    events.ts       Event parsing, PR validation, branch naming
    preview.ts      Create/recreate/delete/skip orchestration
    previews.ts     Preview artifacts + live branch join for the dashboard
    comment.ts      Sticky PR comment renderer
    run.ts          Branch-scoped child commands + test parsing
  events/
    log.ts          Append-only JSONL event log + filters
  cost/
    view.ts         Estimated storage/compute/sandbox cost view
  preview/
    contract.ts     W0 contract resolution (manifest → detection → fail closed)
    sandbox.ts      W1 local sandbox + shared sandbox types
    vercel.ts       Vercel Sandbox backend + advisory reviewer
    registry.ts     W2 per-repo registry and credential resolution
    quota.ts        W4 per-repo quotas (limits, usage, refusal)
  qa/
    agent.ts        W5 bounded test-and-fix loop
    checks.ts       Deterministic preflight (typecheck/test/build)
    smoke.ts        Boots the server and probes the HTTP surface
    tools.ts        Agent tool schemas + guarded dispatch
    sandbox.ts      Disposable local checkout
    vercel.ts       Dedicated Vercel QA Sandbox
    guard.ts        Path/command allowlists
    report.ts       JSON + patch artifacts, qa.completed event
  github/
    client.ts       Read-only GitHub REST polling + pagination
    monitor.ts      PR state machine: create/recreate/delete/skip
    service.ts      Poll timer, manual sync, watcher status
  env/
    environments.ts Persistent staging/qa allowlist
  lib/
    duration.ts     30s/30m/24h/7d parsing for TTLs
    repo.ts         Repository → branch-segment naming
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
