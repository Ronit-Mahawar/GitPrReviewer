/**
 * Scores an eval run: location filter (±3 lines) + LLM judge, then metrics.
 *
 *   npm run eval:score -- [evals/results/<file>.json]     # default: newest run
 *
 * Writes <run>.score.md (table, printed too) and <run>.score.json (metrics + every judge decision).
 * Verdicts are cached in results/judge-cache.json, so a comment is only ever judged once per judge model.
 * Judge model: JUDGE_MODEL, default gemini-3-flash-preview. Key: JUDGE_API_KEY, else GEMINI_API_KEY. A judge call that still fails after 3 retries stops the scoring,
 * because counting it as "NO" would silently lower the catch rate.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Llm, LlmMessage } from "../src/server/review/review-pull-request";
import { createGeminiLlm } from "../src/server/services/ai";
import { loadCases } from "./lib/cases";
import {
  buildJudgeMessages,
  computeMetrics,
  judgeCacheKey,
  locationCandidates,
  parseJudgeReply,
  recordKey,
  renderMarkdown,
  type Judgement,
  type RunFile,
} from "./lib/scoring";

const EVALS_DIR = resolve(__dirname);
const DEFAULT_JUDGE_MODEL = "gemini-3-flash-preview";
const JUDGE_TIMEOUT_MS = 60_000; // a hung call fails fast and goes through the retry/backoff below

function newestRun(): string {
  const dir = join(EVALS_DIR, "results");
  // Run files start with their timestamp ("2026-11-21T…-label.json"); this skips .score.json and judge-cache.json.
  const runs = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}T.*\.json$/.test(f) && !f.endsWith(".score.json")).sort();
  if (runs.length === 0) throw new Error("No runs in evals/results. Run `npm run eval` first.");
  return join(dir, runs[runs.length - 1]!);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits before each retry; covers rate limits (429) and "high demand" (503). */
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
/** Pause between judge calls so a full run stays under the per-minute rate limit. */
const GAP_BETWEEN_CALLS_MS = 1_000;

/** Retries with backoff; if every attempt fails, stops the run rather than guessing. */
async function callJudge(judge: Llm, messages: LlmMessage[]) {
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = await judge(messages);
      await sleep(GAP_BETWEEN_CALLS_MS);
      return reply;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      const reason = error instanceof Error ? error.message : String(error);
      if (delay === undefined) {
        throw new Error(`Judge call failed ${attempt + 1} times, stopping (${reason}). Check JUDGE_MODEL or try again later.`);
      }
      console.warn(`judge call failed (${reason}); retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

type Verdict = { answer: boolean | null; reason: string | null };
const CACHE_PATH = join(EVALS_DIR, "results", "judge-cache.json");

function readCache(): Record<string, Verdict> {
  return existsSync(CACHE_PATH) ? (JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Record<string, Verdict>) : {};
}

function writeCache(cache: Record<string, Verdict>): void {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

async function main() {
  const runPath = resolve(process.argv.slice(2).find((a) => a.endsWith(".json")) ?? newestRun());
  const file = JSON.parse(readFileSync(runPath, "utf8")) as RunFile;
  const cases = loadCases(join(EVALS_DIR, "cases")).filter((c) => file.caseIds.includes(c.id));
  const missing = file.caseIds.filter((id) => !cases.some((c) => c.id === id));
  if (missing.length) throw new Error(`Cases in the run no longer exist: ${missing.join(", ")}`);

  const judgeModel = process.env.JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
  // JUDGE_API_KEY lets the judge use a different Google project's quota; empty falls back to GEMINI_API_KEY.
  const judge = createGeminiLlm({ model: judgeModel, temperature: 0, timeoutMs: JUDGE_TIMEOUT_MS, apiKey: process.env.JUDGE_API_KEY });
  const cache = readCache();
  const matched = new Map<string, Set<number>>();
  const judgements: Judgement[] = [];
  let judgeCalls = 0;

  for (const record of file.records.filter((r) => r.ok)) {
    const bug = cases.find((c) => c.id === record.caseId)!.bug;
    if (!bug) continue;
    for (const { index, comment } of locationCandidates(record.comments, bug)) {
      const key = judgeCacheKey(judgeModel, bug, comment);
      let verdict = cache[key];
      if (!verdict) {
        verdict = parseJudgeReply((await callJudge(judge, buildJudgeMessages(bug, comment))).content);
        judgeCalls++;
        cache[key] = verdict;
        writeCache(cache); // save after every call, so an aborted run keeps its progress
      }
      judgements.push({ caseId: record.caseId, run: record.run, commentIndex: index, comment, ...verdict });
      if (verdict.answer) {
        const set = matched.get(recordKey(record)) ?? new Set<number>();
        set.add(index);
        matched.set(recordKey(record), set);
      }
    }
  }

  const metrics = computeMetrics(file, cases, matched);
  const markdown = renderMarkdown(file, judgeModel, metrics, judgements);
  const base = runPath.replace(/\.json$/, "");
  writeFileSync(`${base}.score.md`, markdown);
  writeFileSync(`${base}.score.json`, JSON.stringify({ run: runPath.split("/").pop(), judgeModel, metrics, judgements }, null, 2) + "\n");
  console.log(markdown);
  console.log(`${judgeCalls} new judge calls, ${judgements.length - judgeCalls} answered from evals/results/judge-cache.json`);
  console.log(`Wrote ${base}.score.md and ${base}.score.json`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
