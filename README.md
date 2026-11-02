# db-branch

A Bun + TypeScript lab for **autonomous Postgres database branching** on
[Neon](https://neon.com): copy-on-write branches, branch-local migrations,
seeded data, and storage/schema reporting.

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
| `bun run branch:list` | List branches with COW writes (`--json`) |
| `bun run branch:create --name <branch>` | Create a branch from `main` |
| `bun run branch:report <branch>` | Storage + schema diff vs parent (`--json`, `--neon-diff`) |
| `bun run branch:diff <base> <compare>` | Neon's own schema diff |
| `bun run branch:delete <branch> --yes` | Delete a branch |
| `bun run branch:demo` | Create branch → feature SQL → branch data → report |
| `bun run branch:report --base-url U --branch-url U` | Compare any two databases |

`branch:demo` also accepts `--parent`, `--reuse`, `--cleanup`, and `--json`.

## How branching is demonstrated

`main` holds the baseline schema and seed. `branch:demo` then:

1. Creates a branch from `main`.
2. Applies `src/db/features/001-coupons.sql` **only on the branch** (new
   `coupons` table, `orders.coupon_code`, `orders.discount_cents`, index).
3. Adds branch-local data from `002-coupons-data.sql`.
4. Compares the branch with its parent:

```
Storage        19.2 MB → 19.9 MB  (+760.0 KB)
Rows           72,426 → 73,929  (+1,503)
Branch writes  +1,503 ins / +1,500 upd / 0 del

Schema changes
+ table coupons
~ table orders
    + column coupon_code
    + column discount_cents
    + index orders_coupon_code_idx
```

`written_data_bytes` is shown too, but it can lag or report `0` on some
projects; the size delta and `pg_stat_user_tables` writes are the reliable
signals.

Main is never modified. Delete the branch when done:

```bash
bun run branch:delete demo-coupons --yes
```

## API

| Route | Description |
| --- | --- |
| `GET /` | Dashboard: health, tables, branches, report runner |
| `GET /api/health` | DB connectivity, database name, latency |
| `GET /api/stats` | Size + row counts per table |
| `GET /api/customers?limit=20&offset=0` | Paginated customers |
| `GET /api/branches` | Neon branches + COW writes |
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
    features/       Branch-local feature SQL
  neon/
    cli.ts          Neon CLI wrapper
    branches.ts     Branch operations
    report.ts       Storage + schema report
  cli/              Operator scripts
drizzle/            Baseline migrations
docs/               Phase plan and runbook
```

## Notes

- Keep `prepare: false` on the client: Neon's pooled endpoint is PgBouncer.
- Use `DATABASE_URL_UNPOOLED` for migrations and bulk loads.
- `pg_database_size()` includes inherited COW pages; pair it with the parent
  delta, `written_data_bytes`, and `pg_stat_user_tables` write activity.
- The lab started as a Claimable Neon project and is now claimed. Claiming
  rotates the connection string and drops the CLI's pre-claim credential; run
  `neon login` (or set `NEON_API_KEY`) and `neon env pull` if needed. The
  database connection can work while branch management is unauthenticated.
- `bun run branch:report <branch> --neon-diff` adds Neon's own schema diff, at
  the cost of one extra API/CLI round trip.
