import { inngest } from "../client";
import { db } from "@/server/db";
import { logger } from "@/server/lib/logger";
import { ReviewOutputValidationError } from "@/server/review/parse";
import { reviewPullRequest } from "@/server/review/review-pull-request";
import { createGeminiLlm } from "@/server/services/ai";
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

export const reviewPR = inngest.createFunction(
  {
    id: "review-pr",
    retries: 2,
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

    const reviewResult = await step.run("generate-review", async () => {
      try {
        return await reviewPullRequest(
          {
            title: pr.title,
            files: files.map((f) => ({
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              patch: f.patch,
            })),
          },
          { llm: createGeminiLlm() },
        );
      } catch (error) {
        if (error instanceof ReviewOutputValidationError) {
          await db.review.update({
            where: { id: reviewId },
            data: {
              promptTokens: error.usage.promptTokens,
              completionTokens: error.usage.completionTokens,
              zodValid: false,
            },
          });
        }
        throw error;
      }
    });

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
          zodValid: true, // reviewPullRequest throws if the output fails validation
          completedAt: new Date(),
        },
      });
    });
    logger.info("review-pr completed", {
      reviewId,
      comments: reviewResult.comments.length,
      latencyMs: reviewResult.meta.latencyMs,
    });

    return { success: true, reviewId };
  },
);
