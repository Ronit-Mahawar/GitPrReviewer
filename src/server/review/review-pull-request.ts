/**
 * The review core: PR title + changed files in, review out.
 *
 * Pure by design: it never imports the OpenAI SDK, Prisma, Inngest or fetch.
 * The model is passed in as `deps.llm`, so production (Gemini), the eval runner
 * and unit tests (a fake function) all call exactly the same code.
 */
import { logger } from "@/server/lib/logger";
import { parseReview, ReviewOutputValidationError, type TokenUsage } from "./parse";
import { buildDiffText, buildUserPrompt, EMPTY_DIFF_SUMMARY, SYSTEM_PROMPT } from "./prompt";
import type { FileChange, ReviewResult } from "./schema";

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

/**
 * Reads repo files for extra context. Not used yet; implemented in Phase 4
 * (GitHubContextProvider for production, LocalContextProvider for evals).
 */
export interface ContextProvider {
  getFile(path: string, ref: string): Promise<string | null>;
  findCallers(symbol: string, ref: string): Promise<Array<{ file: string; line: number; snippet: string }>>;
}

export interface ReviewInput {
  title: string;
  files: FileChange[];
  contextProvider?: ContextProvider;
}

export interface ReviewDeps {
  llm: Llm;
}

export interface ReviewMeta extends TokenUsage {
  model: string | null; // null when the model wasn't called (empty diff)
  latencyMs: number; // time spent in the model call
  finishReason: string | null;
}

export type ReviewOutput = ReviewResult & { meta: ReviewMeta };

export async function reviewPullRequest(input: ReviewInput, deps: ReviewDeps): Promise<ReviewOutput> {
  const diffText = buildDiffText(input.files);

  if (!diffText.trim()) {
    return {
      summary: EMPTY_DIFF_SUMMARY,
      riskScore: 0,
      comments: [],
      meta: { model: null, promptTokens: 0, completionTokens: 0, latencyMs: 0, finishReason: null },
    };
  }

  const started = Date.now();
  const reply = await deps.llm([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(input.title, diffText) },
  ]);
  const latencyMs = Date.now() - started;

  if (!reply.content) throw new Error("No response from AI");
  const usage = { promptTokens: reply.promptTokens, completionTokens: reply.completionTokens };

  let result: ReviewResult;
  try {
    result = parseReview(reply.content, usage);
  } catch (error) {
    if (error instanceof ReviewOutputValidationError) {
      logger.warn("AI review output failed validation", { finishReason: reply.finishReason });
      logger.debug("Raw model output", { content: reply.content });
    }
    throw error;
  }

  logger.debug("Raw model output", { content: reply.content, finishReason: reply.finishReason });
  return {
    ...result,
    meta: { model: reply.model, ...usage, latencyMs, finishReason: reply.finishReason },
  };
}
