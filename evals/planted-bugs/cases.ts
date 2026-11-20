/**
 * Planted-bug PR cases for the shop-api test bed.
 *
 * Each case is applied on top of fixtures/base as its own branch + PR.
 * Lines ending in `// @bug` mark the planted defect; the marker is stripped
 * before committing and the resulting line numbers become ground truth.
 */

export type BugKind = "off-by-one" | "sql-injection" | "null-check" | "race-condition" | "leaked-secret" | "clean";

export type FileEdit =
  | { path: string; content: string } // create or fully replace
  | { path: string; append: string } // append to the base file
  | { path: string; replace: [string, string] }; // single exact replacement in the base file

export interface Case {
  id: string;
  kind: BugKind;
  title: string;
  body: string;
  edits: FileEdit[];
  /** What a correct reviewer comment should say (for humans reading the report). */
  expected: string;
}

export const BUG_MARKER = /\s*\/\/ @bug\s*$/;

export const cases: Case[] = [
  // ───────────────────────────── off-by-one ─────────────────────────────
  {
    id: "ob-01-pagination",
    kind: "off-by-one",
    title: "Add pagination helper for order history",
    body: "Adds `paginate()` so the order-history endpoint can return pages. Pages are 1-indexed to match the public API.",
    expected: "page is 1-indexed, so start must be (page - 1) * pageSize; page 1 currently skips the first pageSize orders.",
    edits: [
      {
        path: "src/orders.ts",
        append: `
export interface Page<T> {
  data: T[];
  page: number;
  totalPages: number;
}

/** Returns one page of results. \`page\` is 1-indexed (page=1 is the first page). */
export function paginate<T>(items: T[], page: number, pageSize = 20): Page<T> {
  const start = page * pageSize; // @bug
  return {
    data: items.slice(start, start + pageSize),
    page,
    totalPages: Math.ceil(items.length / pageSize),
  };
}
`,
      },
    ],
  },
  {
    id: "ob-02-chunk",
    kind: "off-by-one",
    title: "Batch notification sends in groups of 100",
    body: "The email provider caps batch size at 100 recipients, so split user IDs into chunks before sending.",
    expected: "Loop condition `i <= items.length` produces an extra empty chunk when length is a multiple of size (and for empty input), so an empty batch is sent to the provider.",
    edits: [
      {
        path: "src/utils.ts",
        append: `
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i <= items.length; i += size) { // @bug
    out.push(items.slice(i, i + size));
  }
  return out;
}
`,
      },
      {
        path: "src/notifications.ts",
        content: `import { chunk } from "./utils";
import { logger } from "./logger";

const BATCH_SIZE = 100;

async function sendBatch(userIds: string[], template: string): Promise<void> {
  const res = await fetch("https://mail.internal/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipients: userIds, template }),
  });
  if (!res.ok) throw new Error(\`mail batch failed: \${res.status}\`);
}

export async function notifyAll(userIds: string[], template: string): Promise<void> {
  for (const batch of chunk(userIds, BATCH_SIZE)) {
    await sendBatch(batch, template);
  }
  logger.info(\`queued \${userIds.length} notifications\`);
}
`,
      },
    ],
  },
  {
    id: "ob-03-recent-orders",
    kind: "off-by-one",
    title: "Show the N most recent orders on the dashboard",
    body: "Adds `mostRecent(orders, n)` for the dashboard widget.",
    expected: "`slice(sorted.length - n - 1)` returns n + 1 orders; should be `slice(-n)` / `slice(sorted.length - n)`.",
    edits: [
      {
        path: "src/orders.ts",
        append: `
/** Returns the \`n\` most recent orders, oldest first. */
export function mostRecent(orders: Order[], n: number): Order[] {
  if (n <= 0) return [];
  const sorted = [...orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return sorted.slice(Math.max(0, sorted.length - n - 1)); // @bug
}
`,
      },
    ],
  },
  {
    id: "ob-04-retry",
    kind: "off-by-one",
    title: "Add retry-with-backoff helper for flaky upstream calls",
    body: "Generic `retry(fn, attempts)` with exponential backoff. Wraps the payment-provider client.",
    expected: "Loop runs attempts - 1 times (`attempt < attempts` starting at 1); with attempts=1 fn is never called and `undefined` is thrown.",
    edits: [
      {
        path: "src/utils.ts",
        append: `
/** Calls \`fn\` up to \`attempts\` times with exponential backoff between failures. */
export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt < attempts; attempt++) { // @bug
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await sleep(2 ** attempt * 100);
    }
  }
  throw lastError;
}
`,
      },
    ],
  },

  // ───────────────────────────── SQL injection ─────────────────────────────
  {
    id: "sqli-01-user-search",
    kind: "sql-injection",
    title: "Admin: search users by email",
    body: "Adds a `GET /admin/users?q=` endpoint for support staff to look up accounts.",
    expected: "`term` (from req.query.q) is interpolated into the SQL string; use `ILIKE $1` with `%${term}%` as a parameter.",
    edits: [
      {
        path: "src/users.ts",
        append: `
export async function searchUsers(term: string, limit = 25): Promise<User[]> {
  return query<User>(\`SELECT * FROM users WHERE email ILIKE '%\${term}%' ORDER BY email LIMIT \${limit}\`); // @bug
}
`,
      },
      {
        path: "src/routes/admin.ts",
        content: `import type { Req, Res } from "../http";
import { searchUsers } from "../users";

export async function searchUsersHandler(req: Req, res: Res) {
  const q = (req.query.q ?? "").trim();
  if (q.length < 2) return res.status(400).json({ error: "query too short" });
  const users = await searchUsers(q);
  res.json({ users });
}
`,
      },
    ],
  },
  {
    id: "sqli-02-order-sort",
    kind: "sql-injection",
    title: "Allow sorting order history",
    body: "Order history can now be sorted via `?sort=total&dir=asc`. Defaults unchanged.",
    expected: "`sortBy`/`dir` come from the query string and are interpolated into ORDER BY; must be validated against an allow-list.",
    edits: [
      {
        path: "src/orders.ts",
        replace: [
          `export async function listOrdersForUser(userId: string): Promise<Order[]> {
  return query<Order>("SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
}`,
          `export async function listOrdersForUser(userId: string, sortBy = "created_at", dir = "DESC"): Promise<Order[]> {
  return query<Order>(\`SELECT * FROM orders WHERE user_id = $1 ORDER BY \${sortBy} \${dir}\`, [userId]); // @bug
}`,
        ],
      },
      {
        path: "src/routes/orders.ts",
        content: `import type { Req, Res } from "../http";
import { listOrdersForUser } from "../orders";

export async function orderHistoryHandler(req: Req, res: Res) {
  if (!req.userId) return res.status(401).json({ error: "unauthorized" });
  const orders = await listOrdersForUser(req.userId, req.query.sort, req.query.dir?.toUpperCase());
  res.json({ orders });
}
`,
      },
    ],
  },
  {
    id: "sqli-03-cancel-reason",
    kind: "sql-injection",
    title: "Record a reason when an order is cancelled",
    body: "Customers can now give a free-text reason when cancelling. Stored on the order row for the support team.",
    expected: "orderId is parameterized but `reason` (free text from the customer) is interpolated into the UPDATE; pass it as $2.",
    edits: [
      {
        path: "src/orders.ts",
        append: `
export async function cancelOrder(orderId: string, reason: string): Promise<void> {
  await query(
    \`UPDATE orders SET status = 'cancelled', cancel_reason = '\${reason}' WHERE id = $1 AND status = 'pending'\`, // @bug
    [orderId],
  );
}
`,
      },
      {
        path: "src/routes/orders.ts",
        content: `import type { Req, Res } from "../http";
import { cancelOrder } from "../orders";

export async function cancelOrderHandler(req: Req, res: Res) {
  if (!req.userId) return res.status(401).json({ error: "unauthorized" });
  const reason = String(req.body?.reason ?? "").slice(0, 500);
  await cancelOrder(req.params.id, reason);
  res.status(204).json(null);
}
`,
      },
    ],
  },
  {
    id: "sqli-04-sales-report",
    kind: "sql-injection",
    title: "Sales report by SKU for a date range",
    body: "Finance asked for units sold per SKU between two dates. Exposed at `GET /reports/sales?from=&to=`.",
    expected: "`from`/`to` are concatenated into the SQL string; use BETWEEN $1 AND $2.",
    edits: [
      {
        path: "src/reports.ts",
        content: `import { query } from "./db";

export interface SalesRow {
  sku: string;
  units: number;
  revenue: number;
}

export async function salesReport(from: string, to: string): Promise<SalesRow[]> {
  const sql =
    "SELECT sku, SUM(quantity) AS units, SUM(quantity * unit_price) AS revenue " +
    "FROM order_items WHERE created_at BETWEEN '" + from + "' AND '" + to + "' " + // @bug
    "GROUP BY sku ORDER BY units DESC";
  return query<SalesRow>(sql);
}
`,
      },
      {
        path: "src/routes/reports.ts",
        content: `import type { Req, Res } from "../http";
import { salesReport } from "../reports";

export async function salesReportHandler(req: Req, res: Res) {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to are required" });
  res.json({ rows: await salesReport(from, to) });
}
`,
      },
    ],
  },

  // ───────────────────────────── missing null check ─────────────────────────────
  {
    id: "null-01-display-name",
    kind: "null-check",
    title: "Add getDisplayName for comment author labels",
    body: "Comments now show the author's display name instead of their email.",
    expected: "`user.profile` is null until onboarding completes; `user.profile!.name` throws for those users. Fall back to email.",
    edits: [
      {
        path: "src/users.ts",
        replace: [`import { query } from "./db";`, `import { query } from "./db";\nimport { NotFoundError } from "./errors";`],
      },
      {
        path: "src/users.ts",
        append: `
export async function getDisplayName(userId: string): Promise<string> {
  const user = await findUserById(userId);
  if (!user) throw new NotFoundError("user");
  return user.profile!.name.trim(); // @bug
}
`,
      },
    ],
  },
  {
    id: "null-02-shipping-label",
    kind: "null-check",
    title: "Generate shipping labels for paid orders",
    body: "Warehouse job prints a label for every order in `paid` status.",
    expected: "`shippingAddress` is undefined for digital-only orders; the cast hides it and `addr.line1` throws. Skip/guard those orders.",
    edits: [
      {
        path: "src/orders.ts",
        append: `
export function shippingLabel(order: Order): string {
  const addr = order.shippingAddress as Address; // @bug
  return [\`ORDER \${order.id}\`, addr.line1, \`\${addr.city.toUpperCase()} \${addr.postalCode}\`].join("\\n"); // @bug
}

export async function printLabelsForPaidOrders(orders: Order[]): Promise<string[]> {
  return orders.filter((o) => o.status === "paid").map(shippingLabel);
}
`,
      },
    ],
  },
  {
    id: "null-03-price-lookup",
    kind: "null-check",
    title: "Compute cart totals from the catalog",
    body: "Cart total is now computed server-side from catalog prices instead of trusting the client.",
    expected: "`catalog.find(...)!` is undefined for an unknown/discontinued SKU sent by the client, causing a TypeError (500). Validate and return 400.",
    edits: [
      {
        path: "src/cart.ts",
        content: `export interface CatalogItem {
  sku: string;
  price: number;
  active: boolean;
}

export interface CartLine {
  sku: string;
  quantity: number;
}

export function priceFor(sku: string, catalog: CatalogItem[]): number {
  return catalog.find((item) => item.sku === sku && item.active)!.price; // @bug
}

/** Total in cents for the client-submitted cart lines. */
export function cartTotal(lines: CartLine[], catalog: CatalogItem[]): number {
  return lines.reduce((sum, line) => sum + priceFor(line.sku, catalog) * line.quantity, 0);
}
`,
      },
    ],
  },
  {
    id: "null-04-auth-header",
    kind: "null-check",
    title: "Add requireAuth middleware",
    body: "Middleware that validates the bearer token and sets `req.userId`.",
    expected: "`req.headers.authorization!` is undefined for unauthenticated requests, so `.replace` throws (500) instead of returning 401.",
    edits: [
      {
        path: "src/middleware/auth.ts",
        content: `import type { Next, Req, Res } from "../http";
import { verifySession } from "../auth";

export function requireAuth(req: Req, res: Res, next: Next) {
  const token = req.headers.authorization!.replace(/^Bearer /, ""); // @bug
  const userId = verifySession(token);
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  req.userId = userId;
  next();
}
`,
      },
    ],
  },

  // ───────────────────────────── race condition ─────────────────────────────
  {
    id: "race-01-reserve-stock",
    kind: "race-condition",
    title: "Reserve inventory at checkout",
    body: "Decrements stock when an order is placed so we stop overselling.",
    expected: "Read-then-write across an await (TOCTOU): two concurrent checkouts both read the same quantity and both succeed, overselling. Use `UPDATE ... SET quantity = quantity - $1 WHERE sku = $2 AND quantity >= $1` or SELECT FOR UPDATE in a transaction.",
    edits: [
      {
        path: "src/inventory.ts",
        append: `
/** Reserves \`qty\` units of \`sku\`. Returns false if there isn't enough stock. */
export async function reserveStock(sku: string, qty: number): Promise<boolean> {
  const available = await getStock(sku); // @bug
  if (available < qty) return false;
  await query("UPDATE inventory SET quantity = $1 WHERE sku = $2", [available - qty, sku]); // @bug
  return true;
}
`,
      },
    ],
  },
  {
    id: "race-02-rate-limit",
    kind: "race-condition",
    title: "Per-user rate limiting on the login endpoint",
    body: "Limits login attempts to 10/minute per account using Redis.",
    expected: "GET then SET is not atomic: concurrent requests read the same count and all pass, so the limit can be bypassed by parallel requests. Use INCR + EXPIRE (or a Lua script).",
    edits: [
      {
        path: "src/rate-limit.ts",
        content: `import { redis } from "./redis";

const WINDOW_SECONDS = 60;

export async function allowRequest(key: string, limit = 10): Promise<boolean> {
  const current = Number((await redis.get(\`rl:\${key}\`)) ?? 0); // @bug
  if (current >= limit) return false;
  await redis.set(\`rl:\${key}\`, String(current + 1), { EX: WINDOW_SECONDS }); // @bug
  return true;
}
`,
      },
      {
        path: "src/routes/login.ts",
        content: `import type { Req, Res } from "../http";
import { allowRequest } from "../rate-limit";
import { findUserByEmail } from "../users";
import { signSession } from "../auth";
import { verifyPassword } from "../passwords";

export async function loginHandler(req: Req, res: Res) {
  const email = String(req.body?.email ?? "").toLowerCase();
  if (!(await allowRequest(\`login:\${email}\`))) return res.status(429).json({ error: "too many attempts" });
  const user = await findUserByEmail(email);
  if (!user || !(await verifyPassword(user.id, String(req.body?.password ?? "")))) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  res.json({ token: signSession(user.id) });
}
`,
      },
    ],
  },
  {
    id: "race-03-webhook-idempotency",
    kind: "race-condition",
    title: "Make payment webhooks idempotent",
    body: "The payment provider retries webhooks, so skip events we've already processed.",
    expected: "Check-then-insert is not atomic: two concurrent deliveries of the same event both see no row and both credit the account. Use INSERT ... ON CONFLICT DO NOTHING (unique key) inside the same transaction as the credit.",
    edits: [
      {
        path: "src/webhooks.ts",
        content: `import { query } from "./db";
import { logger } from "./logger";

export interface PaymentEvent {
  id: string;
  type: "payment.succeeded" | "payment.refunded";
  orderId: string;
  amountCents: number;
}

export async function handlePaymentEvent(event: PaymentEvent): Promise<void> {
  const seen = await query("SELECT 1 FROM processed_events WHERE id = $1", [event.id]); // @bug
  if (seen.length > 0) {
    logger.info(\`skipping duplicate event \${event.id}\`);
    return;
  }

  if (event.type === "payment.succeeded") {
    await query("UPDATE orders SET status = 'paid' WHERE id = $1", [event.orderId]);
    await query("UPDATE accounts SET credit_cents = credit_cents + $1 WHERE order_id = $2", [event.amountCents, event.orderId]);
  }

  await query("INSERT INTO processed_events (id) VALUES ($1)", [event.id]); // @bug
}
`,
      },
    ],
  },
  {
    id: "race-04-wallet-debit",
    kind: "race-condition",
    title: "Pay for orders with wallet balance",
    body: "Users can now pay with store credit. Debits the wallet and writes a ledger entry.",
    expected: "Balance is read, checked, and written back as an absolute value: concurrent debits cause lost updates / overdraft. Use a single conditional UPDATE (balance = balance - $1 WHERE balance >= $1) or SELECT ... FOR UPDATE in withTransaction.",
    edits: [
      {
        path: "src/wallet.ts",
        content: `import { query } from "./db";

export class InsufficientFundsError extends Error {}

export async function debitWallet(userId: string, amountCents: number, orderId: string): Promise<number> {
  const rows = await query<{ balance_cents: number }>("SELECT balance_cents FROM wallets WHERE user_id = $1", [userId]); // @bug
  const balance = rows[0]?.balance_cents ?? 0;
  if (balance < amountCents) throw new InsufficientFundsError();

  const newBalance = balance - amountCents;
  await query("UPDATE wallets SET balance_cents = $1 WHERE user_id = $2", [newBalance, userId]); // @bug
  await query("INSERT INTO wallet_ledger (user_id, order_id, delta_cents) VALUES ($1, $2, $3)", [userId, orderId, -amountCents]);
  return newBalance;
}
`,
      },
    ],
  },

  // ───────────────────────────── leaked secret ─────────────────────────────
  {
    id: "secret-01-payments-key",
    kind: "leaked-secret",
    title: "Integrate payment provider client",
    body: "Adds a thin client for creating payment intents.",
    expected: "Production API key is hard-coded in source; move it to an env var (config) and rotate the key.",
    edits: [
      {
        path: "src/payments.ts",
        content: `import { retryableFetch } from "./payments-http";

const PAYMENTS_BASE_URL = "https://api.payments-provider.example/v2";
const PAYMENTS_API_KEY = "pp_prod_9f8c2e7a41b64d0b8e3f5a1c7d2e9b40c6a1f3e2"; // @bug

export interface PaymentIntent {
  id: string;
  clientSecret: string;
  amountCents: number;
}

export async function createPaymentIntent(orderId: string, amountCents: number): Promise<PaymentIntent> {
  const res = await retryableFetch(\`\${PAYMENTS_BASE_URL}/intents\`, {
    method: "POST",
    headers: { authorization: \`Bearer \${PAYMENTS_API_KEY}\`, "content-type": "application/json" },
    body: JSON.stringify({ orderId, amountCents, currency: "usd" }),
  });
  return res.json() as Promise<PaymentIntent>;
}
`,
      },
      {
        path: "src/payments-http.ts",
        content: `export async function retryableFetch(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status >= 500) return fetch(url, init);
  return res;
}
`,
      },
    ],
  },
  {
    id: "secret-02-jwt-fallback",
    kind: "leaked-secret",
    title: "Make local dev work without a .env file",
    body: "New contributors kept hitting `Missing required env var` on first run. Provide sensible defaults.",
    expected: "A real-looking JWT signing secret is committed as a fallback; if JWT_SECRET is unset in prod, sessions are signed with a public key anyone can forge. Fail fast in production.",
    edits: [
      {
        path: "src/config.ts",
        replace: [
          `export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  jwtSecret: required("JWT_SECRET"),
};`,
          `export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/shop",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  jwtSecret: process.env.JWT_SECRET ?? "x9Kf2qLz7Wm4Rt8vB1nY6pQ3sD5hJ0cE", // @bug
};

// keep the helper around for values that truly have no default
export { required };`,
        ],
      },
    ],
  },
  {
    id: "secret-03-aws-backup",
    kind: "leaked-secret",
    title: "Nightly database backup script",
    body: "Dumps the database and uploads it to S3. Run from cron on the ops box.",
    expected: "AWS access key ID and secret access key are hard-coded in the script; use the default credential chain / env vars and rotate the keys.",
    edits: [
      {
        path: "scripts/backup.ts",
        content: `import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "us-east-1",
  credentials: {
    accessKeyId: "AKIA4Q7XJ2LMN5RT8WZC", // @bug
    secretAccessKey: "q8Zt4Lr1Vx9Nw2Kp7Hs5Jd3Fg6Bm0Yc8Ae1Ui4Ro", // @bug
  },
});

async function main() {
  const file = \`/tmp/shop-\${new Date().toISOString().slice(0, 10)}.sql.gz\`;
  execSync(\`pg_dump "$DATABASE_URL" | gzip > \${file}\`);
  await s3.send(new PutObjectCommand({ Bucket: "shop-db-backups", Key: file.split("/").pop(), Body: readFileSync(file) }));
  console.log(\`uploaded \${file}\`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`,
      },
    ],
  },
  {
    id: "secret-04-request-logging",
    kind: "leaked-secret",
    title: "Add request logging middleware",
    body: "Logs every request so we can debug production issues.",
    expected: "Logs the raw Authorization header (bearer session tokens) and full request body (login passwords) to the log pipeline; redact them.",
    edits: [
      {
        path: "src/middleware/logging.ts",
        content: `import type { Next, Req, Res } from "../http";
import { logger } from "../logger";

export function requestLogger(req: Req, _res: Res, next: Next) {
  const started = Date.now();
  logger.info(
    \`\${req.method} \${req.path} auth=\${req.headers.authorization ?? "-"} body=\${JSON.stringify(req.body ?? {})}\`, // @bug
  );
  next();
  logger.info(\`\${req.method} \${req.path} done in \${Date.now() - started}ms\`);
}
`,
      },
    ],
  },

  // ───────────────────────────── clean controls (no bug) ─────────────────────────────
  {
    id: "clean-01-find-users-by-ids",
    kind: "clean",
    title: "Batch-load users by id",
    body: "Avoids N+1 queries on the comments page.",
    expected: "No bug. Correctly parameterized `= ANY($1)`, handles empty input.",
    edits: [
      {
        path: "src/users.ts",
        append: `
export async function findUsersByIds(ids: string[]): Promise<Map<string, User>> {
  if (ids.length === 0) return new Map();
  const rows = await query<User>("SELECT * FROM users WHERE id = ANY($1::uuid[])", [ids]);
  return new Map(rows.map((u) => [u.id, u]));
}
`,
      },
    ],
  },
  {
    id: "clean-02-format-cents",
    kind: "clean",
    title: "Add money formatting helper",
    body: "Formats integer cents for receipts.",
    expected: "No bug. Integer cents, Intl formatting, negative handled.",
    edits: [
      {
        path: "src/money.ts",
        content: `const formatters = new Map<string, Intl.NumberFormat>();

/** Formats an integer number of cents, e.g. formatCents(123456) === "$1,234.56". */
export function formatCents(cents: number, currency = "USD", locale = "en-US"): string {
  if (!Number.isInteger(cents)) throw new TypeError("cents must be an integer");
  const key = \`\${locale}:\${currency}\`;
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, { style: "currency", currency });
    formatters.set(key, fmt);
  }
  return fmt.format(cents / 100);
}
`,
      },
      {
        path: "src/money.test.ts",
        content: `import { describe, expect, it } from "vitest";
import { formatCents } from "./money";

describe("formatCents", () => {
  it("formats whole and fractional amounts", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(5)).toBe("$0.05");
  });
  it("formats negatives", () => {
    expect(formatCents(-250)).toBe("-$2.50");
  });
  it("rejects non-integers", () => {
    expect(() => formatCents(1.5)).toThrow(TypeError);
  });
});
`,
      },
    ],
  },
  {
    id: "clean-03-atomic-reserve",
    kind: "clean",
    title: "Reserve inventory atomically at checkout",
    body: "Decrements stock in a single conditional UPDATE so concurrent checkouts can't oversell.",
    expected: "No bug. Single atomic conditional UPDATE with parameters; rowCount check.",
    edits: [
      {
        path: "src/inventory.ts",
        append: `
/** Atomically reserves \`qty\` units of \`sku\`. Returns false if there isn't enough stock. */
export async function reserveStock(sku: string, qty: number): Promise<boolean> {
  if (!Number.isInteger(qty) || qty <= 0) throw new RangeError("qty must be a positive integer");
  const rows = await query<{ quantity: number }>(
    "UPDATE inventory SET quantity = quantity - $1 WHERE sku = $2 AND quantity >= $1 RETURNING quantity",
    [qty, sku],
  );
  return rows.length === 1;
}
`,
      },
    ],
  },
];
