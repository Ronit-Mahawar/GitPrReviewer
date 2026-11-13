import { PrismaClient } from "@prisma/client";
import { writeFile } from "node:fs/promises";
import { MODEL_PRICING } from "./config";

const databaseUrl = process.env.BENCH_DATABASE_URL;
const appDatabaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || databaseUrl !== appDatabaseUrl) throw new Error("BENCH_DATABASE_URL and DATABASE_URL must point to the same isolated benchmark database.");
if (!/[\/\-_](bench|benchmark|test)[\/_-]?/i.test(new URL(databaseUrl).pathname)) throw new Error("Refusing to report from a database whose name does not clearly identify it as test/benchmark data.");

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const csvCell = (value: unknown) => {
  const text = value instanceof Date ? value.toISOString() : value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};
const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1]!;
};
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

async function main() {
  const rows = await prisma.review.findMany({
    include: { repository: { select: { fullName: true } } },
    orderBy: { receivedAt: "asc" },
  });
  const durations = rows.flatMap((r) => r.completedAt ? [r.completedAt.getTime() - r.receivedAt.getTime()] : []);
  const webhookTimes = rows.flatMap((r) => r.webhookMs === null ? [] : [r.webhookMs]);
  const validated = rows.filter((r) => r.zodValid !== null);
  const zodFailures = validated.filter((r) => r.zodValid === false).length;
  const costs = rows.flatMap((r) => {
    if (MODEL_PRICING.inputUsdPerMillionTokens === null || MODEL_PRICING.outputUsdPerMillionTokens === null || r.promptTokens === null || r.completionTokens === null) return [];
    return [(r.promptTokens * MODEL_PRICING.inputUsdPerMillionTokens + r.completionTokens * MODEL_PRICING.outputUsdPerMillionTokens) / 1_000_000];
  });
  const deliveries = await prisma.webhookDelivery.groupBy({ by: ["event", "action"], _count: { _all: true }, orderBy: [{ event: "asc" }, { action: "asc" }] });
  const distinctPrs = new Set(rows.map((r) => `${r.repositoryId}:${r.prNumber}`));
  console.log(`Total PRs: ${distinctPrs.size}`);
  console.log(`Distinct repositories: ${new Set(rows.map((r) => r.repository.fullName)).size}`);
  console.log(`Completed review latency (ms): median=${median(durations) ?? "n/a"}, p95=${percentile(durations, 0.95) ?? "n/a"}`);
  console.log(`Webhook handler time (ms): median=${median(webhookTimes) ?? "n/a"}, max=${webhookTimes.length ? Math.max(...webhookTimes) : "n/a"}`);
  console.log(`Zod failure rate: ${validated.length ? `${zodFailures}/${validated.length} (${(zodFailures / validated.length * 100).toFixed(2)}%)` : "n/a (no recorded validation outcomes)"}`);
  console.log(`Average model cost per review (USD): ${costs.length ? (costs.reduce((sum, cost) => sum + cost, 0) / costs.length).toFixed(8) : "n/a (fill scripts/bench/config.ts pricing and collect token usage)"}`);
  console.log("Webhook event/action counts:");
  for (const delivery of deliveries) console.log(`  ${delivery.event}.${delivery.action ?? "(no action)"}: ${delivery._count._all}`);

  const headers = ["reviewId", "repository", "prNumber", "status", "receivedAt", "completedAt", "latencyMs", "promptTokens", "completionTokens", "zodValid", "webhookMs", "createdAt", "error"];
  const lines = [headers.join(","), ...rows.map((row) => [row.id, row.repository.fullName, row.prNumber, row.status, row.receivedAt, row.completedAt, row.completedAt ? row.completedAt.getTime() - row.receivedAt.getTime() : null, row.promptTokens, row.completionTokens, row.zodValid, row.webhookMs, row.createdAt, row.error].map(csvCell).join(","))];
  await writeFile("results.csv", `${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${rows.length} raw review rows to results.csv`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
