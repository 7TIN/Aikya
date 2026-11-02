-- Branch-only data for the coupon feature demo.
-- Applied after 001-coupons.sql on a feature branch.

insert into "coupons" ("code", "description", "percent_off", "max_redemptions", "expires_at")
values
  ('WELCOME10', '10% off the first order', 10, 1000, now() + interval '30 days'),
  ('AGENT20', '20% off for agent sandbox runs', 20, 500, now() + interval '14 days'),
  ('BF50', 'Black Friday 50% off', 50, 100, now() + interval '7 days')
on conflict ("code") do nothing;

-- Backfill a discount on a slice of the inherited orders.
update "orders"
   set "coupon_code" = 'WELCOME10',
       "discount_cents" = floor("total_cents" * 0.10)::int
 where "id" in (
   select "id" from "orders" order by random() limit 1500
 );

-- Insert branch-local orders and their items, then fix up the totals.
with new_orders as (
  insert into "orders" ("customer_id", "status", "total_cents", "coupon_code", "discount_cents", "created_at")
  select c."id", 'pending', 0, 'WELCOME10', 500, now() - (random() * interval '10 days')
    from "customers" c
   order by random()
   limit 500
  returning "id"
),
new_items as (
  insert into "order_items" ("order_id", "product_id", "quantity", "unit_price_cents")
  select n."id", p."id", 1 + floor(random() * 2)::int, p."price_cents"
    from new_orders n
    join lateral (
      select "id", "price_cents" from "products" order by random() limit 2
    ) p on true
  returning "order_id", "quantity", "unit_price_cents"
)
update "orders" o
   set "total_cents" = totals.total,
       "discount_cents" = floor(totals.total * 0.10)::int
  from (
    select "order_id", sum("quantity" * "unit_price_cents")::int as total
      from new_items
     group by "order_id"
  ) totals
 where o."id" = totals."order_id";
