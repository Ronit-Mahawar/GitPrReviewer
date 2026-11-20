/**
 * Runs the production reviewer (`reviewCode` from src/server/services/ai.ts) on every
 * test-bed PR, using the same GitHub "list PR files" payload the Inngest job uses.
 * The DB/Inngest/webhook layers are skipped; the model call, prompt, and parsing are identical.
 *
 *   npx tsx --env-file=.env evals/planted-bugs/run.ts [--runs 3] [--only ob-01,sqli-02]
 *
 * Needs GEMINI_API_KEY (from .env) and a GitHub token (GITHUB_TOKEN or `gh auth token`).
 * Writes evals/planted-bugs/results/run-<timestamp>.json
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { reviewCode, ReviewOutputValidationError, type ReviewComment } from "../../src/server/services/ai";
import type { GroundTruth } from "./setup-testbed";

const HERE = resolve(__dirname);
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const runs = Number(opt("--runs") ?? 3);
const only = opt("--only")?.split(",");
const gapMs = Number(opt("--gap-ms") ?? 1500);

const truth = JSON.parse(readFileSync(join(HERE, "ground-truth.json"), "utf8")) as GroundTruth;
if (!truth.repo) throw new Error("ground-truth.json has no repo; run setup-testbed.ts with --repo first.");
const token = process.env.GITHUB_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

async function ghJson<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${truth.repo}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export interface RunRecord {
  caseId: string;
  prNumber: number;
  run: number;
  ok: boolean;
  error?: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  riskScore?: number;
  summary?: string;
  comments: ReviewComment[];
}

async function main() {
  const out: { startedAt: string; repo: string; runs: number; records: RunRecord[] } = {
    startedAt: new Date().toISOString(),
    repo: truth.repo!,
    runs,
    records: [],
  };
  const targets = truth.cases.filter((c) => c.prNumber && (!only || only.some((o) => c.id.startsWith(o))));

  for (const c of targets) {
    const pr = await ghJson<{ title: string }>(`/pulls/${c.prNumber}`);
    const files = await ghJson<Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>>(
      `/pulls/${c.prNumber}/files?per_page=100`,
    );
    for (let r = 1; r <= runs; r++) {
      const silenced = console.log;
      console.log = () => {}; // reviewCode prints the raw model output
      const t0 = performance.now();
      let rec: RunRecord;
      try {
        const { result, usage } = await reviewCode(pr.title, files);
        rec = {
          caseId: c.id, prNumber: c.prNumber!, run: r, ok: true, latencyMs: performance.now() - t0,
          promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
          riskScore: result.riskScore, summary: result.summary, comments: result.comments,
        };
      } catch (err) {
        const usage = err instanceof ReviewOutputValidationError ? err.usage : { prompt_tokens: null, completion_tokens: null };
        rec = {
          caseId: c.id, prNumber: c.prNumber!, run: r, ok: false, error: String((err as Error).message ?? err),
          latencyMs: performance.now() - t0, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, comments: [],
        };
      } finally {
        console.log = silenced;
      }
      out.records.push(rec);
      console.log(
        `${c.id.padEnd(30)} run ${r}  ${rec.ok ? "ok " : "ERR"}  ${(rec.latencyMs / 1000).toFixed(2)}s  ` +
          `tokens ${rec.promptTokens}/${rec.completionTokens}  comments=${rec.comments.length}${rec.error ? `  ${rec.error}` : ""}`,
      );
      await new Promise((res) => setTimeout(res, gapMs));
    }
  }

  mkdirSync(join(HERE, "results"), { recursive: true });
  const file = join(HERE, "results", `run-${out.startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
