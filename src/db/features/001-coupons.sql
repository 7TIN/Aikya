-- Branch-local feature migration: coupons + order discounts.
-- Applied only to a feature branch by `bun run db:sql` or `bun run branch:demo`.
-- Never add this file to the baseline drizzle migrations unless the feature
-- is promoted to main.

create table if not exists "coupons" (
  "code" text primary key,
  "description" text not null,
  "percent_off" integer not null,
  "max_redemptions" integer,
  "expires_at" timestamptz,
  "created_at" timestamptz not null default now()
);

alter table "orders" add column if not exists "coupon_code" text;
alter table "orders" add column if not exists "discount_cents" integer not null default 0;

create index if not exists "orders_coupon_code_idx" on "orders" ("coupon_code");
