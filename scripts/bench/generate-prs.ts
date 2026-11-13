import { PrismaClient } from "@prisma/client";

const repo = process.env.TESTBED_REPO;
const token = process.env.GITHUB_TOKEN;
const benchDb = process.env.BENCH_DATABASE_URL;
const appDb = process.env.DATABASE_URL;
const confirm = process.env.BENCH_CONFIRM_ISOLATED_DB;
const timeoutMs = Number(process.env.BENCH_REVIEW_TIMEOUT_MS ?? 10 * 60_000);
const gapMs = Math.max(1_000, Number(process.env.BENCH_REQUEST_GAP_MS ?? 1_500));

if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error("Set TESTBED_REPO=owner/repository for a dedicated test repository.");
if (!token) throw new Error("Set GITHUB_TOKEN with contents and pull-request write permissions.");
if (!benchDb || !appDb || benchDb !== appDb) throw new Error("BENCH_DATABASE_URL and DATABASE_URL must be the same isolated benchmark database.");
if (!/[\/\-_](bench|benchmark|test)[\/_-]?/i.test(new URL(benchDb).pathname)) throw new Error("Refusing to use a database whose name does not clearly contain 'bench', 'benchmark', or 'test'.");
if (confirm !== "I_ACKNOWLEDGE_THIS_IS_AN_ISOLATED_TEST_DATABASE") throw new Error("Set BENCH_CONFIRM_ISOLATED_DB=I_ACKNOWLEDGE_THIS_IS_AN_ISOLATED_TEST_DATABASE only after verifying the target database is isolated.");

const prisma = new PrismaClient({ datasources: { db: { url: benchDb } } });
const apiRoot = `https://api.github.com/repos/${repo}`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};
let lastGitHubRequest = 0;

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const waitMs = Math.max(0, lastGitHubRequest + gapMs - Date.now());
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  let response = await fetch(`${apiRoot}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  lastGitHubRequest = Date.now();
  if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
    const resetAt = Number(response.headers.get("x-ratelimit-reset")) * 1_000;
    const retryAfter = Number(response.headers.get("retry-after")) * 1_000;
    const backoffMs = Math.max(retryAfter || 0, resetAt ? resetAt - Date.now() + 1_000 : gapMs);
    console.warn(`GitHub rate limit reached; pausing ${Math.ceil(backoffMs / 1_000)} seconds.`);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    response = await fetch(`${apiRoot}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    lastGitHubRequest = Date.now();
  }
  if (!response.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed (${response.status}): ${await response.text()}`);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
const pause = (ms = gapMs) => new Promise((resolve) => setTimeout(resolve, ms));
type Ref = { object: { sha: string } };
type Commit = { sha: string; commit: { tree: { sha: string } } };
type Pull = { number: number; title: string };

function content(index: number, size: number, issue: boolean): string {
  const lines = Array.from({ length: size }, (_, i) => `export const generated_${index}_${i} = "benchmark fixture ${index} line ${i}";`);
  if (issue) {
    const kinds = [
      'export function findUser(db: any, id: string) { return db.query("SELECT * FROM users WHERE id = \'" + id + "\'"); }',
      'export const API_KEY = "ghp_benchmark_fake_not_a_real_secret_000000000000000000";',
      'export function displayName(user: { profile?: { name?: string } } | null) { return user.profile.name; }',
    ];
    lines[Math.min(2, lines.length - 1)] = kinds[index % kinds.length]!;
  }
  return `${lines.join("\n")}\n`;
}

async function waitForReview(prNumber: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await prisma.review.findFirst({
      where: { repository: { fullName: repo }, prNumber },
      orderBy: { receivedAt: "desc" },
      select: { status: true, error: true },
    });
    if (row?.status === "COMPLETED") return;
    if (row?.status === "FAILED") throw new Error(`Review for PR #${prNumber} failed: ${row.error ?? "unknown error"}`);
    await pause(Math.max(gapMs, 5_000));
  }
  throw new Error(`Timed out waiting for review of PR #${prNumber} after ${timeoutMs}ms`);
}

async function main() {
  const { default_branch: base } = await gh<{ default_branch: string }>("");
  const baseRef = await gh<Ref>(`/git/ref/heads/${encodeURIComponent(base)}`);
  const [owner, name] = repo!.split("/");
  console.log(`Generating 40 benchmark pull requests in ${owner}/${name} from ${base}.`);

  for (let index = 1; index <= 40; index++) {
    const size = index <= 10 ? 5 : index <= 30 ? 100 : 520;
    const issue = index > 30;
    const branch = `benchmark/pr-${String(index).padStart(2, "0")}`;
    const path = `benchmark/generated-${String(index).padStart(2, "0")}.ts`;
    const blob = await gh<{ sha: string }>("/git/blobs", { method: "POST", body: JSON.stringify({ content: content(index, size, issue), encoding: "utf-8" }) });
    const tree = await gh<{ sha: string }>("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: (await gh<Commit>(`/git/commits/${baseRef.object.sha}`)).commit.tree.sha, tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }] }) });
    const commit = await gh<Commit>("/git/commits", { method: "POST", body: JSON.stringify({ message: `Benchmark fixture ${index}`, tree: tree.sha, parents: [baseRef.object.sha] }) });
    await gh(`/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
    const pull = await gh<Pull>("/pulls", { method: "POST", body: JSON.stringify({ title: `Benchmark ${index}: ${issue ? "intentional issue" : `${size}-line change`}`, head: branch, base, body: `Generated benchmark fixture ${index}.${issue ? " Contains a deliberate security or null-safety issue." : ""}` }) });
    console.log(`Opened PR #${pull.number} (${size} lines${issue ? ", intentional issue" : ""}).`);
    await waitForReview(pull.number);

    if (index <= 5) {
      const followup = await gh<{ sha: string }>(`/contents/${path}?ref=${encodeURIComponent(branch)}`);
      const encoded = Buffer.from(`${content(index, size, issue)}// follow-up benchmark commit\n`).toString("base64");
      await gh(`/contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `Follow-up commit for benchmark ${index}`, content: encoded, sha: followup.sha, branch }) });
      await pause();
      await waitForReview(pull.number);
    }
    if (index <= 3) {
      await gh(`/pulls/${pull.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
      await pause();
      await gh(`/pulls/${pull.number}`, { method: "PATCH", body: JSON.stringify({ state: "open" }) });
      await pause();
      await waitForReview(pull.number);
    }
    await pause();
  }
  console.log("All generated pull requests and follow-up reviews completed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
