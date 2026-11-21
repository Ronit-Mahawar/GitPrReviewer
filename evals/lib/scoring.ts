/**
 * Pure scoring helpers: location filter, judge prompt + answer parsing, metrics, Markdown.
 * evals/score.ts does the only impure part (calling the judge model).
 */
import { createHash } from "node:crypto";
import { parseJsonObject } from "../../src/server/review/parse";
import type { LlmMessage } from "../../src/server/review/review-pull-request";
import type { ReviewComment } from "../../src/server/review/schema";
import type { EvalCase } from "./cases";

/** A comment can only match a bug if it is on the same file and within this many lines. */
export const LOCATION_TOLERANCE = 3;

export interface RunRecord {
  caseId: string;
  run: number;
  ok: boolean;
  error?: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  summary?: string;
  riskScore?: number;
  comments: ReviewComment[];
}

export interface RunFile {
  label: string;
  startedAt: string;
  model: string;
  temperature: number;
  runs: number;
  gitCommit: string | null;
  caseIds: string[];
  records: RunRecord[];
}

export type Bug = NonNullable<EvalCase["bug"]>;
export type ScoredCase = Pick<EvalCase, "id" | "kind" | "bug">;

/** Comments (with their index) on the bug's file and within ±LOCATION_TOLERANCE lines of it. */
export function locationCandidates(comments: ReviewComment[], bug: Bug): Array<{ index: number; comment: ReviewComment }> {
  return comments
    .map((comment, index) => ({ index, comment }))
    .filter(({ comment }) => comment.file === bug.file && Math.abs(comment.line - bug.line) <= LOCATION_TOLERANCE);
}

export function buildJudgeMessages(bug: Bug, comment: ReviewComment): LlmMessage[] {
  return [
    {
      role: "system",
      content:
        "You grade code review comments against a known bug. Answer YES only if the comment identifies that specific bug: " +
        "it names the bug's cause or its effect (paraphrases are fine). A comment about a different problem, or generic advice " +
        'that would apply to any code, is NO. Respond with JSON only: {"answer": "YES" | "NO", "reason": "<one sentence>"}',
    },
    {
      role: "user",
      content:
        `Known bug (${bug.file} line ${bug.line}, ${bug.category}):\n${bug.description}\n\n` +
        `Review comment (${comment.file}:${comment.line}, ${comment.severity}/${comment.category}):\n${comment.message}` +
        (comment.suggestion ? `\nSuggested fix: ${comment.suggestion}` : "") +
        `\n\nDoes this comment identify this bug: ${bug.description}?`,
    },
  ];
}

/**
 * Key for the on-disk judge cache. A verdict depends only on the judge model, the bug and the
 * comment's text and position, so the same inputs never need a second judge call.
 */
export function judgeCacheKey(judgeModel: string, bug: Bug, comment: ReviewComment): string {
  const parts = [judgeModel, bug.file, bug.line, bug.description, comment.file, comment.line, comment.severity, comment.category, comment.message, comment.suggestion ?? ""];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/** answer: true for YES, false for NO, null if the judge's reply can't be read. */
export function parseJudgeReply(content: string | null): { answer: boolean | null; reason: string | null } {
  if (!content) return { answer: null, reason: null };
  try {
    const parsed = parseJsonObject(content) as { answer?: unknown; reason?: unknown };
    const answer = String(parsed.answer ?? "").trim().toUpperCase();
    const reason = typeof parsed.reason === "string" && parsed.reason ? parsed.reason : null;
    if (answer === "YES") return { answer: true, reason };
    if (answer === "NO") return { answer: false, reason };
  } catch {
    // not JSON; fall through to a plain-text YES/NO
  }
  const plain = content.trim().toUpperCase();
  if (/^YES\b/.test(plain)) return { answer: true, reason: null };
  if (/^NO\b/.test(plain)) return { answer: false, reason: null };
  return { answer: null, reason: null };
}

/** Nearest-rank percentile, e.g. percentile(xs, 95). NaN for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(rank, 1)) - 1]!;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

export const recordKey = (r: Pick<RunRecord, "caseId" | "run">) => `${r.caseId}#${r.run}`;

export interface Rate {
  caught: number;
  total: number;
}

export interface Metrics {
  reviews: number;
  failedReviews: number;
  catchRate: { overall: Rate; byKind: Record<string, Rate>; byCategory: Record<string, Rate> };
  noisePerPr: number;
  cleanFalseAlarms: { reviewsWithHighOrCritical: number; cleanReviews: number };
  latencyMs: { avg: number; median: number; p95: number };
  tokensPerPr: { prompt: number; completion: number };
  perCase: Array<{ id: string; kind: string; category: string | null; caught: number; runs: number; avgComments: number; avgNoise: number }>;
}

/**
 * `matched` holds, per review (recordKey), the indexes of comments the judge said identify the bug.
 * A bug counts as caught in a review if at least one comment matched; a failed review counts as a miss.
 * Noise = comments that matched no bug, averaged over successful reviews.
 */
export function computeMetrics(file: RunFile, cases: ScoredCase[], matched: Map<string, Set<number>>): Metrics {
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const okRecords = file.records.filter((r) => r.ok);
  const isCaught = (r: RunRecord) => (matched.get(recordKey(r))?.size ?? 0) > 0;
  const noiseOf = (r: RunRecord) => r.comments.length - (matched.get(recordKey(r))?.size ?? 0);

  const overall: Rate = { caught: 0, total: 0 };
  const byKind: Record<string, Rate> = {};
  const byCategory: Record<string, Rate> = {};
  for (const r of file.records) {
    const c = caseById.get(r.caseId);
    if (!c) throw new Error(`Result has unknown case ${r.caseId}`);
    if (!c.bug) continue;
    const caught = isCaught(r) ? 1 : 0;
    for (const rate of [overall, (byKind[c.kind] ??= { caught: 0, total: 0 }), (byCategory[c.bug.category] ??= { caught: 0, total: 0 })]) {
      rate.caught += caught;
      rate.total += 1;
    }
  }

  const cleanRecords = file.records.filter((r) => caseById.get(r.caseId)?.kind === "clean");
  const highOrCritical = (r: RunRecord) => r.comments.some((c) => c.severity === "high" || c.severity === "critical");
  const tokenRecords = file.records.filter((r) => r.promptTokens !== null);

  return {
    reviews: file.records.length,
    failedReviews: file.records.length - okRecords.length,
    catchRate: { overall, byKind, byCategory },
    noisePerPr: mean(okRecords.map(noiseOf)),
    cleanFalseAlarms: { reviewsWithHighOrCritical: cleanRecords.filter(highOrCritical).length, cleanReviews: cleanRecords.length },
    latencyMs: {
      avg: mean(okRecords.map((r) => r.latencyMs)),
      median: percentile(okRecords.map((r) => r.latencyMs), 50),
      p95: percentile(okRecords.map((r) => r.latencyMs), 95),
    },
    tokensPerPr: {
      prompt: mean(tokenRecords.map((r) => r.promptTokens ?? 0)),
      completion: mean(tokenRecords.map((r) => r.completionTokens ?? 0)),
    },
    perCase: file.caseIds.map((id) => {
      const c = caseById.get(id)!;
      const records = file.records.filter((r) => r.caseId === id);
      const ok = records.filter((r) => r.ok);
      return {
        id,
        kind: c.kind,
        category: c.bug?.category ?? null,
        caught: records.filter(isCaught).length,
        runs: records.length,
        avgComments: mean(ok.map((r) => r.comments.length)),
        avgNoise: mean(ok.map(noiseOf)),
      };
    }),
  };
}

export interface Judgement {
  caseId: string;
  run: number;
  commentIndex: number;
  comment: Pick<ReviewComment, "file" | "line" | "severity" | "message">;
  answer: boolean | null;
  reason: string | null;
}

const pct = (r: Rate) => (r.total ? `${Math.round((100 * r.caught) / r.total)}% (${r.caught}/${r.total})` : "–");
const fmt = (n: number, digits = 1) => (Number.isNaN(n) ? "–" : n.toFixed(digits));

/**
 * Up to `n` judgements for a manual spot-check (D2): distinct comments only (at temperature 0 the
 * same comment repeats across runs), half YES and half NO when available.
 */
export function spotCheckSample(judgements: Judgement[], n = 10): Judgement[] {
  const seen = new Set<string>();
  const distinct = judgements.filter((j) => {
    const key = `${j.caseId}|${j.comment.file}|${j.comment.line}|${j.comment.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const yes = distinct.filter((j) => j.answer === true);
  const no = distinct.filter((j) => j.answer !== true);
  const half = Math.ceil(n / 2);
  const pickYes = yes.slice(0, Math.max(half, n - no.length));
  return [...pickYes, ...no.slice(0, n - pickYes.length)];
}

export function renderMarkdown(file: RunFile, judgeModel: string, metrics: Metrics, judgements: Judgement[]): string {
  const m = metrics;
  const lines: string[] = [];
  lines.push(`# Eval: ${file.label}`);
  lines.push("");
  lines.push(`${file.startedAt} · commit \`${file.gitCommit ?? "unknown"}\` · reviewer \`${file.model}\` (temperature ${file.temperature}) · judge \`${judgeModel}\` · ${file.caseIds.length} cases × ${file.runs} runs`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Catch rate | **${pct(m.catchRate.overall)}** |`);
  for (const [kind, rate] of Object.entries(m.catchRate.byKind)) lines.push(`| Catch rate, kind \`${kind}\` | ${pct(rate)} |`);
  lines.push(`| Noise comments per PR | ${fmt(m.noisePerPr, 2)} |`);
  lines.push(`| False alarms on clean PRs (any high/critical) | ${m.cleanFalseAlarms.reviewsWithHighOrCritical}/${m.cleanFalseAlarms.cleanReviews} reviews |`);
  lines.push(`| Failed reviews | ${m.failedReviews}/${m.reviews} |`);
  lines.push(`| Latency avg / median / p95 | ${fmt(m.latencyMs.avg / 1000, 2)}s / ${fmt(m.latencyMs.median / 1000, 2)}s / ${fmt(m.latencyMs.p95 / 1000, 2)}s |`);
  lines.push(`| Tokens per PR (prompt / completion) | ${fmt(m.tokensPerPr.prompt, 0)} / ${fmt(m.tokensPerPr.completion, 0)} |`);
  lines.push("");
  lines.push("## Catch rate by category");
  lines.push("");
  lines.push("| Category | Catch rate |");
  lines.push("|---|---|");
  for (const [category, rate] of Object.entries(m.catchRate.byCategory).sort()) lines.push(`| ${category} | ${pct(rate)} |`);
  lines.push("");
  lines.push("## Per case");
  lines.push("");
  lines.push("| Case | Kind | Category | Caught | Comments (avg) | Noise (avg) |");
  lines.push("|---|---|---|---|---|---|");
  for (const c of m.perCase) {
    lines.push(`| ${c.id} | ${c.kind} | ${c.category ?? "–"} | ${c.category ? `${c.caught}/${c.runs}` : "n/a"} | ${fmt(c.avgComments)} | ${fmt(c.avgNoise)} |`);
  }
  const unreadable = judgements.filter((j) => j.answer === null).length;
  lines.push("");
  lines.push("## Judge spot-check");
  lines.push("");
  lines.push(`${judgements.length} judge calls (${judgements.filter((j) => j.answer).length} YES, ${judgements.filter((j) => j.answer === false).length} NO${unreadable ? `, ${unreadable} unreadable → counted as NO` : ""}). Check these by hand (D2); if you disagree with more than 1 in 10, revisit the judge.`);
  lines.push("");
  lines.push("| Case | Run | Comment | Judge | Reason | Agree? |");
  lines.push("|---|---|---|---|---|---|");
  for (const j of spotCheckSample(judgements)) {
    const text = j.comment.message.replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${j.caseId} | ${j.run} | \`${j.comment.file}:${j.comment.line}\` ${text} | ${j.answer === null ? "?" : j.answer ? "YES" : "NO"} | ${(j.reason ?? "").replace(/\|/g, "\\|")} | |`);
  }
  lines.push("");
  lines.push("_Definitions: a bug is caught in a review if a comment is on the same file within ±3 lines and the judge answers YES. A failed review counts as a miss. Noise = comments that match no bug, averaged over successful reviews. Latency is wall time of `reviewPullRequest()`._");
  return lines.join("\n") + "\n";
}
