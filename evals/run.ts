/**
 * Eval runner: reviews every case in evals/cases with the production reviewPullRequest().
 * No GitHub, no Inngest, no DB. Context comes from evals/fixture-repo via LocalContextProvider.
 *
 *   npm run eval -- [--runs 3] [--label v1] [--only sqli-,race-01]
 *
 * Writes evals/results/<timestamp>-<label>.json. Score it with `npm run eval:score`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ReviewOutputValidationError } from "../src/server/review/parse";
import { reviewPullRequest } from "../src/server/review/review-pull-request";
import { createGeminiLlm, DEFAULT_REVIEW_MODEL } from "../src/server/services/ai";
import { loadCases } from "./lib/cases";
import { createLocalContextProvider } from "./lib/local-context-provider";
import type { RunFile, RunRecord } from "./lib/scoring";

const EVALS_DIR = resolve(__dirname);
const TEMPERATURE = 0;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function gitCommit(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "src"], { encoding: "utf8" }).trim() !== "";
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return null;
  }
}

async function main() {
  const runs = Number(arg("--runs") ?? 3);
  const label = (arg("--label") ?? "run").replace(/[^a-zA-Z0-9_-]/g, "-");
  const only = arg("--only")?.split(",");
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

  const cases = loadCases(join(EVALS_DIR, "cases"), only);
  const model = process.env.REVIEW_MODEL || DEFAULT_REVIEW_MODEL;
  const llm = createGeminiLlm({ model, temperature: TEMPERATURE });
  const contextProvider = createLocalContextProvider(join(EVALS_DIR, "fixture-repo"));
  const startedAt = new Date().toISOString();
  const records: RunRecord[] = [];

  console.log(`Reviewing ${cases.length} cases x ${runs} runs with ${model} (temperature ${TEMPERATURE})`);
  for (const c of cases) {
    for (let run = 1; run <= runs; run++) {
      const started = performance.now();
      let record: RunRecord;
      try {
        const review = await reviewPullRequest({ title: c.title, files: c.files, contextProvider }, { llm });
        record = {
          caseId: c.id, run, ok: true, latencyMs: Math.round(performance.now() - started),
          promptTokens: review.meta.promptTokens, completionTokens: review.meta.completionTokens,
          summary: review.summary, riskScore: review.riskScore, comments: review.comments,
        };
      } catch (error) {
        const usage = error instanceof ReviewOutputValidationError ? error.usage : { promptTokens: null, completionTokens: null };
        record = {
          caseId: c.id, run, ok: false, error: error instanceof Error ? error.message : String(error),
          latencyMs: Math.round(performance.now() - started), ...usage, comments: [],
        };
      }
      records.push(record);
      console.log(
        `${c.id.padEnd(34)} run ${run}  ${record.ok ? "ok " : "ERR"}  ${(record.latencyMs / 1000).toFixed(2)}s  ` +
          `tokens ${record.promptTokens ?? "?"}/${record.completionTokens ?? "?"}  comments ${record.comments.length}` +
          (record.error ? `  (${record.error})` : ""),
      );
    }
  }

  const out: RunFile = { label, startedAt, model, temperature: TEMPERATURE, runs, gitCommit: gitCommit(), caseIds: cases.map((c) => c.id), records };
  mkdirSync(join(EVALS_DIR, "results"), { recursive: true });
  const file = join(EVALS_DIR, "results", `${startedAt.replace(/[:.]/g, "-")}-${label}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${file}\nScore it with: npm run eval:score -- ${file}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
