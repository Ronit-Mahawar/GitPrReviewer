import { inngest } from "../client";
import { db } from "@/server/db";
import { logger } from "@/server/lib/logger";
import { parsePositiveInt } from "@/server/review/config";
import { reviewPullRequest, type RunStep } from "@/server/review/review-pull-request";
import { createGeminiLlm } from "@/server/services/ai";
import { prismaContextCache } from "@/server/services/context-cache";
import { createGitHubContextProvider, createGitHubFetchJson } from "@/server/services/github-context-provider";
import {
  fetchPullRequest,
  fetchPullRequestFiles,
  getGitHubAccessToken,
} from "@/server/services/github";

export type ReviewPREvent = {
  name: "review/pr.requested";
  data: {
    reviewId: string;
    repositoryId: string;
    prNumber: number;
    userId: string;
    forceRetryTest?: boolean;
  };
};

/**
 * A short, user-facing version of an error: its last non-empty line, at most 300 characters.
 * Prisma validation errors dump the whole query (including the review text) before the reason on the last line.
 */
export function shortErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "Unknown error";
  return last.length > 300 ? `${last.slice(0, 297)}...` : last;
}

/** Runs once the job has used all its retries, so the review ends FAILED instead of staying PROCESSING. */
export async function markReviewFailed(reviewId: string, error: unknown): Promise<void> {
  const message = shortErrorMessage(error);
  logger.warn("review-pr failed after retries", { reviewId, error: message });
  await db.review.updateMany({
    where: { id: reviewId, status: { not: "COMPLETED" } },
    data: { status: "FAILED", error: message },
  });
}

export const reviewPR = inngest.createFunction(
  {
    id: "review-pr",
    retries: 2,
    // At most 3 steps (e.g. chunk reviews) run at once per user, so one big PR can't flood Gemini's rate limit (D5).
    concurrency: { key: "event.data.userId", limit: 3 },
    onFailure: async ({ event, error }) => {
      await markReviewFailed(event.data.event.data.reviewId, error);
    },
  },
  { event: "review/pr.requested" },
  async ({ event, step }) => {
    const { reviewId, repositoryId, prNumber, userId } = event.data;
    logger.info("review-pr started", { reviewId });

    if (event.data.forceRetryTest && process.env.BENCH_ENABLE_RETRY_TEST === "true") {
      const claim = await db.review.updateMany({
        where: { id: reviewId, error: null },
        data: { error: "BENCH_RETRY_TEST_FIRST_ATTEMPT" },
      });
      if (claim.count === 1) throw new Error("Forced benchmark retry test failure");
      await db.review.updateMany({
        where: { id: reviewId, error: "BENCH_RETRY_TEST_FIRST_ATTEMPT" },
        data: { error: null },
      });
    }

    await step.run("update-status-processing", async () => {
      await db.review.update({
        where: { id: reviewId },
        data: { status: "PROCESSING" },
      });
    });

    const repository = await step.run("get-repository", async () => {
      return db.repository.findUnique({
        where: { id: repositoryId },
      });
    });

    if (!repository) {
      await step.run("mark-failed-no-repo", async () => {
        await db.review.update({
          where: { id: reviewId },
          data: { status: "FAILED", error: "No repository found" },
        });
      });
      return { success: false, error: "No repository found" };
    }

    const accessToken = await step.run("get-access-token", async () => {
      return getGitHubAccessToken(userId);
    });

    if (!accessToken) {
      await step.run("mark-failed-no-token", async () => {
        await db.review.update({
          where: { id: reviewId },
          data: {
            status: "FAILED",
            error: "GitHub access token not found",
          },
        });
      });
      return { success: false, error: "GitHub access token not found" };
    }

    const [owner, repo] = repository.fullName.split("/");
    if (!owner || !repo) {
      await step.run("mark-failed-invalid-repo", async () => {
        await db.review.update({
          where: { id: reviewId },
          data: {
            status: "FAILED",
            error: "Invalid repository name",
          },
        });
      });
      return { success: false, error: "Invalid repository name" };
    }

    const files = await step.run("fetch-pr-files", async () => {
      return fetchPullRequestFiles(accessToken, owner, repo, prNumber);
    });

    const pr = await step.run("fetch-pr", async () => {
      return fetchPullRequest(accessToken, owner, repo, prNumber);
    });

    // Each chunk runs as its own step ("review-chunk-<i>"), in parallel; the summary is a "summarize" step.
    // Inngest retries a failed step and remembers finished ones, so a retry never re-reviews a finished chunk.
    const runStep: RunStep = (name, fn) => step.run(name, fn) as Promise<Awaited<ReturnType<typeof fn>>>;
    // Repo context (Phase 4): files at the PR's head commit, cached by blob SHA in Postgres.
    const contextProvider = createGitHubContextProvider({ owner, repo, fetchJson: createGitHubFetchJson(accessToken), cache: prismaContextCache });
    const reviewResult = await reviewPullRequest(
      {
        title: pr.title,
        contextProvider,
        ref: pr.head.sha,
        files: files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        })),
      },
      { llm: createGeminiLlm(), runStep },
      {
        chunkTokenBudget: parsePositiveInt(process.env.CHUNK_TOKEN_BUDGET, 7000),
        maxComments: parsePositiveInt(process.env.MAX_COMMENTS, 15),
        contextTokenBudget: parsePositiveInt(process.env.CONTEXT_TOKEN_BUDGET, 4000),
      },
    );

    await step.run("save-review-result", async () => {
      await db.review.update({
        where: { id: reviewId },
        data: {
          status: "COMPLETED",
          summary: reviewResult.summary,
          riskScore: reviewResult.riskScore,
          comments: reviewResult.comments,
          promptTokens: reviewResult.meta.promptTokens,
          completionTokens: reviewResult.meta.completionTokens,
          zodValid: reviewResult.meta.failedChunks === 0, // false if any chunk's output stayed invalid after a retry
          meta: JSON.parse(JSON.stringify(reviewResult.meta)), // plain JSON for the Json column
          completedAt: new Date(),
        },
      });
    });
    logger.info("review-pr completed", {
      reviewId,
      comments: reviewResult.comments.length,
      chunks: reviewResult.meta.chunks,
      failedChunks: reviewResult.meta.failedChunks,
      latencyMs: reviewResult.meta.latencyMs,
    });

    return { success: true, reviewId };
  },
);
