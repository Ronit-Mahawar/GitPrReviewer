/**
 * The review core (v2): PR title + changed files in, review out.
 *
 *   filterFiles → chunkFiles → reviewChunk (repo context + one model call per chunk, in parallel)
 *               → mergeComments → summarizeReview (one small call) → result + meta
 *
 * Pure by design: it never imports the OpenAI SDK, Prisma, Inngest or fetch. The model is passed in
 * as `deps.llm`. `deps.runStep` lets the Inngest job run each chunk as its own retryable step
 * (D5); evals and tests leave it out and the functions are just called directly.
 */
import { logger } from "@/server/lib/logger";
import { chunkFiles, chunkText, DEFAULT_CHUNK_TOKEN_BUDGET, type Chunk } from "./chunk";
import { buildChunkContext, DEFAULT_CONTEXT_TOKEN_BUDGET, type ContextProvider } from "./context";
import { filterFiles, type SkippedFile } from "./filter";
import { DEFAULT_MAX_COMMENTS, mergeComments, type MergeStats } from "./merge";
import { parseReply, type TokenUsage } from "./parse";
import { buildChunkUserPrompt, buildSummaryUserPrompt, chunkSystemPrompt, SUMMARY_SYSTEM_PROMPT, type SummaryInput } from "./prompt";
import { ChunkReplySchema, SummaryReplySchema, type FileChange, type ReviewComment, type ReviewResult } from "./schema";

export interface LlmMessage {
  role: "system" | "user";
  content: string;
}

export interface LlmReply {
  content: string | null;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason: string | null;
}

/** Any function that sends messages to a model and returns its reply. */
export type Llm = (messages: LlmMessage[]) => Promise<LlmReply>;

/** Runs `fn` as a named unit of work. Inngest passes step.run; the default just calls fn. */
export type RunStep = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export type { CallSite, ContextProvider } from "./context";

export interface ReviewInput {
  title: string;
  files: FileChange[];
  /** Where repo context comes from (Phase 4). Leave out for a diff-only review. */
  contextProvider?: ContextProvider;
  /** Commit to read context at, normally the PR's head SHA. */
  ref?: string;
}

export interface ReviewDeps {
  llm: Llm;
  runStep?: RunStep;
}

export interface ReviewOptions {
  chunkTokenBudget?: number; // default 7000 (CHUNK_TOKEN_BUDGET)
  maxComments?: number; // default 15 (MAX_COMMENTS)
  contextTokenBudget?: number; // default 4000 per chunk (CONTEXT_TOKEN_BUDGET)
}

export interface ChunkContextStats {
  tokens: number;
  blocks: number;
  dropped: number;
  errors: number;
}

/** How many times a chunk or the summary is asked again after a reply that isn't valid JSON (D6). */
export const BAD_OUTPUT_RETRIES = 1;

export interface ChunkReview {
  index: number;
  ok: boolean;
  comments: ReviewComment[];
  error?: string;
  attempts: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  context: ChunkContextStats;
}

export interface ReviewMeta {
  model: string | null; // null when the model was never called
  filesReviewed: number;
  filesSkipped: SkippedFile[];
  chunks: number;
  failedChunks: number;
  chunkErrors: Array<{ chunk: number; error: string }>;
  comments: MergeStats;
  summaryFallback: boolean; // true if the summary call failed and the summary was written in code
  /** Repo context, summed over chunks; enabled is false for a diff-only review. */
  context: ChunkContextStats & { enabled: boolean };
  promptTokens: number;
  completionTokens: number;
  /** Model time on the critical path: the slowest chunk plus the summary call. */
  latencyMs: number;
}

export type ReviewOutput = ReviewResult & { meta: ReviewMeta };

const callDirectly: RunStep = (_name, fn) => fn();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sends `messages`, parses the reply with `schema`, and asks once more if the reply is bad. Provider errors are thrown. */
async function callWithRetry<T>(llm: Llm, messages: LlmMessage[], parse: (content: string, usage: TokenUsage) => T) {
  let promptTokens = 0;
  let completionTokens = 0;
  let model: string | null = null;
  let lastError = "";
  const started = Date.now();
  for (let attempt = 1; attempt <= 1 + BAD_OUTPUT_RETRIES; attempt++) {
    const reply = await llm(messages);
    model = reply.model;
    promptTokens += reply.promptTokens ?? 0;
    completionTokens += reply.completionTokens ?? 0;
    try {
      if (!reply.content) throw new Error(`empty reply (finish reason: ${reply.finishReason ?? "unknown"})`);
      const value = parse(reply.content, { promptTokens: reply.promptTokens, completionTokens: reply.completionTokens });
      return { ok: true as const, value, attempts: attempt, model, promptTokens, completionTokens, latencyMs: Date.now() - started };
    } catch (error) {
      lastError = errorMessage(error);
      logger.warn("model reply was not valid, retrying", { attempt, finishReason: reply.finishReason });
      logger.debug("invalid model reply", { content: reply.content });
    }
  }
  return { ok: false as const, error: lastError, attempts: 1 + BAD_OUTPUT_RETRIES, model, promptTokens, completionTokens, latencyMs: Date.now() - started };
}

const NO_CONTEXT: ChunkContextStats = { tokens: 0, blocks: 0, dropped: 0, errors: 0 };

export interface ChunkContextInput {
  provider: ContextProvider;
  ref: string;
  budget: number;
  /** The PR's changed files that appear in this chunk (with patches). */
  files: FileChange[];
}

/**
 * Reviews one chunk: gathers repo context (if a provider is given), then one model call.
 * A bad reply (twice) marks only this chunk as failed; provider errors are thrown so a step can retry.
 */
export async function reviewChunk(
  title: string,
  chunk: Chunk,
  totalChunks: number,
  llm: Llm,
  context?: ChunkContextInput,
): Promise<ChunkReview & { model: string | null }> {
  const ctx = context ? await buildChunkContext({ files: context.files, provider: context.provider, ref: context.ref, budget: context.budget }) : null;
  if (ctx?.errors.length) logger.warn("some repo context could not be loaded", { chunk: chunk.index, errors: ctx.errors.slice(0, 3) });
  const contextStats: ChunkContextStats = ctx
    ? { tokens: ctx.tokens, blocks: ctx.included.length, dropped: ctx.dropped.length, errors: ctx.errors.length }
    : NO_CONTEXT;

  const messages: LlmMessage[] = [
    { role: "system", content: chunkSystemPrompt(Boolean(ctx?.text)) },
    { role: "user", content: buildChunkUserPrompt(title, chunkText(chunk.files), { index: chunk.index, total: totalChunks }, ctx?.text ?? "") },
  ];
  const result = await callWithRetry(llm, messages, (content, usage) => parseReply(ChunkReplySchema, content, usage));
  const base = { index: chunk.index, attempts: result.attempts, model: result.model, promptTokens: result.promptTokens, completionTokens: result.completionTokens, latencyMs: result.latencyMs, context: contextStats };
  return result.ok ? { ...base, ok: true, comments: result.value.comments } : { ...base, ok: false, comments: [], error: result.error };
}

/** Highest severity → a risk score, used when the summary call fails. */
export function fallbackRiskScore(comments: ReviewComment[]): number {
  if (comments.some((c) => c.severity === "critical")) return 80;
  if (comments.some((c) => c.severity === "high")) return 60;
  if (comments.some((c) => c.severity === "medium")) return 35;
  return comments.length > 0 ? 15 : 5;
}

/** One small call that sees only the comments and file lists, never the diff (D7). Never throws. */
export async function summarizeReview(input: SummaryInput, llm: Llm) {
  const messages: LlmMessage[] = [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: buildSummaryUserPrompt(input) },
  ];
  try {
    const result = await callWithRetry(llm, messages, (content, usage) => parseReply(SummaryReplySchema, content, usage));
    if (result.ok) return { ...result.value, fallback: false, promptTokens: result.promptTokens, completionTokens: result.completionTokens, latencyMs: result.latencyMs };
    return { ...fallbackSummary(input), promptTokens: result.promptTokens, completionTokens: result.completionTokens, latencyMs: result.latencyMs };
  } catch (error) {
    logger.warn("summary call failed, using fallback", { error: errorMessage(error) });
    return { ...fallbackSummary(input), promptTokens: 0, completionTokens: 0, latencyMs: 0 };
  }
}

function fallbackSummary(input: SummaryInput) {
  const n = input.comments.length;
  const summary =
    n === 0
      ? `Reviewed ${input.reviewedFiles.length} file(s); no problems found.`
      : `Reviewed ${input.reviewedFiles.length} file(s) and found ${n} issue(s). Most severe: ${input.comments[0]!.message}`;
  return { summary, riskScore: fallbackRiskScore(input.comments), fallback: true };
}

/** A sentence about what wasn't reviewed, appended to the summary so the user sees it (rule 5). */
export function coverageNote(skipped: SkippedFile[], failedChunks: number, totalChunks: number): string {
  const parts: string[] = [];
  if (skipped.length > 0) {
    const shown = skipped.slice(0, 5).map((s) => `${s.file} (${s.reason})`).join(", ");
    parts.push(`Not reviewed: ${skipped.length} file(s) or part(s): ${shown}${skipped.length > 5 ? ", …" : ""}.`);
  }
  if (failedChunks > 0) parts.push(`${failedChunks} of ${totalChunks} part(s) of the diff could not be reviewed (invalid model output).`);
  return parts.join(" ");
}

export async function reviewPullRequest(input: ReviewInput, deps: ReviewDeps, options: ReviewOptions = {}): Promise<ReviewOutput> {
  const runStep = deps.runStep ?? callDirectly;
  const { kept, skipped: filtered } = filterFiles(input.files);
  const { chunks, skipped: tooLarge } = chunkFiles(kept, options.chunkTokenBudget ?? DEFAULT_CHUNK_TOKEN_BUDGET);
  const skipped = [...filtered, ...tooLarge];

  if (chunks.length === 0) {
    const note = coverageNote(skipped, 0, 0);
    return {
      summary: `No code changes to review.${note ? ` ${note}` : ""}`,
      riskScore: 0,
      comments: [],
      meta: {
        model: null, filesReviewed: 0, filesSkipped: skipped, chunks: 0, failedChunks: 0, chunkErrors: [],
        comments: { fromModel: 0, droppedInvalidLine: 0, droppedDuplicate: 0, droppedOverLimit: 0 },
        summaryFallback: false, context: { enabled: Boolean(input.contextProvider), ...NO_CONTEXT },
        promptTokens: 0, completionTokens: 0, latencyMs: 0,
      },
    };
  }

  // Context for a chunk comes from the changed files in it (a split file appears once).
  const contextFor = (chunk: Chunk): ChunkContextInput | undefined => {
    if (!input.contextProvider) return undefined;
    const names = new Set(chunk.files.map((f) => f.filename));
    return {
      provider: input.contextProvider,
      ref: input.ref ?? "HEAD",
      budget: options.contextTokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET,
      files: kept.filter((f) => names.has(f.filename)),
    };
  };

  // One call per chunk, in parallel. Whatever goes wrong stays inside that chunk (rule 4).
  const reviews = await Promise.all(
    chunks.map((chunk) =>
      runStep(`review-chunk-${chunk.index}`, () => reviewChunk(input.title, chunk, chunks.length, deps.llm, contextFor(chunk))).catch(
        (error): ChunkReview & { model: string | null } => ({
          index: chunk.index, ok: false, comments: [], error: errorMessage(error), attempts: 0,
          promptTokens: 0, completionTokens: 0, latencyMs: 0, model: null, context: NO_CONTEXT,
        }),
      ),
    ),
  );

  // Valid lines per file across all chunks, so a file split into parts is checked as one.
  const validLines = new Map<string, Set<number>>();
  for (const file of chunks.flatMap((c) => c.files)) {
    const set = validLines.get(file.filename) ?? new Set<number>();
    file.validLines.forEach((line) => set.add(line));
    validLines.set(file.filename, set);
  }
  const merged = mergeComments(
    reviews.filter((r) => r.ok).map((r) => r.comments),
    validLines,
    options.maxComments ?? DEFAULT_MAX_COMMENTS,
  );

  const failed = reviews.filter((r) => !r.ok);
  const reviewedFiles = [...new Map(chunks.flatMap((c) => c.files).map((f) => [f.filename, { filename: f.filename, status: f.status }])).values()];
  const summary = await runStep("summarize", () =>
    summarizeReview({ title: input.title, reviewedFiles, skipped, comments: merged.comments, failedChunks: failed.length, totalChunks: chunks.length }, deps.llm),
  );

  const note = coverageNote(skipped, failed.length, chunks.length);
  return {
    summary: note ? `${summary.summary}\n\n${note}` : summary.summary,
    riskScore: summary.riskScore,
    comments: merged.comments,
    meta: {
      model: reviews.find((r) => r.model)?.model ?? null,
      filesReviewed: reviewedFiles.length,
      filesSkipped: skipped,
      chunks: chunks.length,
      failedChunks: failed.length,
      chunkErrors: failed.map((r) => ({ chunk: r.index, error: r.error ?? "unknown error" })),
      comments: merged.stats,
      summaryFallback: summary.fallback,
      context: {
        enabled: Boolean(input.contextProvider),
        tokens: reviews.reduce((sum, r) => sum + r.context.tokens, 0),
        blocks: reviews.reduce((sum, r) => sum + r.context.blocks, 0),
        dropped: reviews.reduce((sum, r) => sum + r.context.dropped, 0),
        errors: reviews.reduce((sum, r) => sum + r.context.errors, 0),
      },
      promptTokens: reviews.reduce((sum, r) => sum + r.promptTokens, 0) + summary.promptTokens,
      completionTokens: reviews.reduce((sum, r) => sum + r.completionTokens, 0) + summary.completionTokens,
      latencyMs: Math.max(...reviews.map((r) => r.latencyMs)) + summary.latencyMs,
    },
  };
}
