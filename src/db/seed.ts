import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SqlClient } from "./client.ts";
import { createDatabase } from "./client.ts";
import * as schema from "./schema.ts";

type Database = PostgresJsDatabase<typeof schema>;
type CustomerPlan = (typeof schema.customerPlan.enumValues)[number];
type Status = (typeof schema.orderStatus.enumValues)[number];

export interface SeedOptions {
  customers?: number;
  products?: number;
  orders?: number;
  seed?: number;
  /** Truncate baseline tables before inserting. Defaults to true. */
  reset?: boolean;
}

const FIRST_NAMES = [
  "Aarav", "Maya", "Leo", "Nora", "Iris", "Kai", "Zoe", "Omar", "Lina", "Theo",
  "Ada", "Milo", "Sana", "Ezra", "Mira", "Finn", "Rhea", "Noah", "Anya", "Luca",
  "Priya", "Arjun", "Sofia", "Mateo", "Yuki", "Hana", "Elena", "Ravi", "Clara", "Jonas",
];

const LAST_NAMES = [
  "Sharma", "Patel", "Nguyen", "Garcia", "Kim", "Silva", "Ivanov", "Okafor", "Chen", "Rossi",
  "Khan", "Dubois", "Muller", "Tanaka", "Novak", "Haddad", "Costa", "Anders", "Rao", "Vega",
];

const ADJECTIVES = [
  "Compact", "Aurora", "Nimbus", "Atlas", "Orbit", "Quartz", "Ember", "Lumen", "Onyx", "Harbor",
  "Willow", "Cobalt", "Sable", "Terra", "Vela", "Pulse", "Prism", "Drift", "Glide", "Halo",
];

const NOUNS = [
  "Keyboard", "Lamp", "Backpack", "Mug", "Headphones", "Chair", "Notebook", "Charger", "Sneaker", "Watch",
  "Bottle", "Desk Mat", "Speaker", "Camera", "Jacket", "Tripod", "Stand", "Cable", "Mouse", "Monitor",
];

const STATUS_WEIGHTS: Status[] = [
  "paid", "paid", "paid", "paid", "pending", "pending", "shipped", "shipped", "cancelled",
];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  const value = values[Math.floor(rng() * values.length)];
  if (value === undefined) throw new Error("Cannot pick from an empty array");
  return value;
}

function daysAgo(now: number, rng: () => number, maxDays: number): Date {
  const offset = Math.floor(rng() * maxDays * 86_400_000);
  return new Date(now - offset);
}

export interface SeedResult {
  customers: number;
  products: number;
  orders: number;
  orderItems: number;
  durationMs: number;
}

export async function seedDatabase(
  db: Database,
  client: SqlClient,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const {
    customers: customerCount = 2_000,
    products: productCount = 200,
    orders: orderCount = 20_000,
    seed = 42,
    reset = true,
  } = options;

  const startedAt = performance.now();
  const rng = mulberry32(seed);
  const now = Date.now();

  if (reset) {
    console.log("Truncating baseline tables...");
    await client.unsafe(
      'truncate table "order_items", "orders", "products", "customers" restart identity cascade',
    );
  }

  console.log(`Seeding ${customerCount} customers, ${productCount} products, ${orderCount} orders...`);

  const customerRows: Array<typeof schema.customers.$inferInsert> = [];
  for (let index = 0; index < customerCount; index += 1) {
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    const plan: CustomerPlan = rng() < 0.7 ? "free" : rng() < 0.85 ? "pro" : "enterprise";
    customerRows.push({
      email: `${first.toLowerCase()}.${last.toLowerCase()}.${index}@example.com`,
      fullName: `${first} ${last}`,
      plan,
      createdAt: daysAgo(now, rng, 540),
    });
  }

  for (const batch of chunk(customerRows, 1_000)) {
    await db.insert(schema.customers).values(batch);
  }

  const productRows: Array<typeof schema.products.$inferInsert> = [];
  for (let index = 0; index < productCount; index += 1) {
    const adjective = ADJECTIVES[index % ADJECTIVES.length] ?? "Studio";
    const noun = NOUNS[Math.floor(index / ADJECTIVES.length) % NOUNS.length] ?? "Item";
    productRows.push({
      sku: `SKU-${String(index + 1).padStart(4, "0")}`,
      name: `${adjective} ${noun}`,
      priceCents: 499 + Math.floor(rng() * 49_501),
      active: rng() > 0.08,
      createdAt: daysAgo(now, rng, 365),
    });
  }

  for (const batch of chunk(productRows, 1_000)) {
    await db.insert(schema.products).values(batch);
  }

  const customerIds = await client.unsafe<{ id: string }[]>(
    'select "id" from "customers" order by "email"',
  );
  const productRowsFromDb = await client.unsafe<{ id: string; price_cents: number }[]>(
    'select "id", "price_cents" from "products" order by "sku"',
  );

  if (customerIds.length === 0 || productRowsFromDb.length === 0) {
    throw new Error("Seed failed: customers or products were not inserted");
  }

  const orderRows: Array<typeof schema.orders.$inferInsert> = [];
  const itemRows: Array<typeof schema.orderItems.$inferInsert> = [];

  for (let index = 0; index < orderCount; index += 1) {
    const orderId = crypto.randomUUID();
    const customer = pick(rng, customerIds);
    const status = pick(rng, STATUS_WEIGHTS);
    const itemCount = 1 + Math.floor(rng() * 4);
    let totalCents = 0;

    for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
      const product = pick(rng, productRowsFromDb);
      const quantity = 1 + Math.floor(rng() * 3);
      totalCents += product.price_cents * quantity;
      itemRows.push({
        orderId,
        productId: product.id,
        quantity,
        unitPriceCents: product.price_cents,
      });
    }

    orderRows.push({
      id: orderId,
      customerId: customer.id,
      status,
      totalCents,
      createdAt: daysAgo(now, rng, 180),
    });
  }

  for (const batch of chunk(orderRows, 1_000)) {
    await db.insert(schema.orders).values(batch);
  }

  for (const batch of chunk(itemRows, 2_000)) {
    await db.insert(schema.orderItems).values(batch);
  }

  return {
    customers: customerRows.length,
    products: productRows.length,
    orders: orderRows.length,
    orderItems: itemRows.length,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

function chunk<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

if (import.meta.main) {
  const { client, db } = createDatabase(
    process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
  );
  try {
    const result = await seedDatabase(db, client, {
      customers: numberFromEnv("SEED_CUSTOMERS", 2_000),
      products: numberFromEnv("SEED_PRODUCTS", 200),
      orders: numberFromEnv("SEED_ORDERS", 20_000),
      seed: numberFromEnv("SEED_RANDOM", 42),
    });
    console.log(
      `✔ Seeded ${result.customers} customers, ${result.products} products, ` +
        `${result.orders} orders, ${result.orderItems} order items in ${result.durationMs}ms.`,
    );
  } finally {
    await client.end();
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
