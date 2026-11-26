import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (ctx: { event: unknown; step: unknown }) => Promise<unknown>;
const mock = vi.hoisted(() => ({
  handler: undefined as unknown as Handler,
  reviewUpdate: vi.fn(), reviewUpdateMany: vi.fn(), repositoryFindUnique: vi.fn(), getToken: vi.fn(), fetchFiles: vi.fn(), fetchPr: vi.fn(), reviewPullRequest: vi.fn(),
}));
vi.mock("../client", () => ({ inngest: { createFunction: vi.fn((opts: unknown, _trigger: unknown, handler: Handler) => { mock.handler = handler; return { opts, fn: handler }; }) } }));
vi.mock("@/server/db", () => ({ db: { review: { update: mock.reviewUpdate, updateMany: mock.reviewUpdateMany }, repository: { findUnique: mock.repositoryFindUnique } } }));
vi.mock("@/server/services/github", () => ({ getGitHubAccessToken: mock.getToken, fetchPullRequestFiles: mock.fetchFiles, fetchPullRequest: mock.fetchPr }));
vi.mock("@/server/review/review-pull-request", () => ({ reviewPullRequest: mock.reviewPullRequest }));
vi.mock("@/server/services/ai", () => ({ createGeminiLlm: vi.fn(() => vi.fn()) }));
vi.mock("@/server/services/context-cache", () => ({ prismaContextCache: { get: vi.fn(), set: vi.fn() } }));

import { markReviewFailed, reviewPR, shortErrorMessage } from "./review-pr";

const event = { data: { reviewId: "review-1", repositoryId: "repo-1", prNumber: 3, userId: "user-1" } };
const step = { run: (_name: string, fn: () => unknown) => fn() };

describe("reviewPR failure state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BENCH_ENABLE_RETRY_TEST;
    mock.reviewUpdate.mockResolvedValue({});
    mock.repositoryFindUnique.mockResolvedValue({ id: "repo-1", fullName: "owner/repo" });
    mock.getToken.mockResolvedValue("mock-token");
    mock.fetchFiles.mockResolvedValue([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+const a = 1;" }]);
    mock.fetchPr.mockResolvedValue({ title: "Test", head: { sha: "head-sha" } });
  });

  it("retries LLM errors and ends the stored review in a terminal state", async () => {
    mock.reviewPullRequest.mockRejectedValue(new Error("LLM unavailable"));
    const attempts = Number((reviewPR as unknown as { opts: { retries?: number } }).opts.retries ?? 0) + 1;
    for (let i = 0; i < attempts; i++) await expect(mock.handler({ event, step })).rejects.toThrow("LLM unavailable");
    expect(mock.reviewPullRequest).toHaveBeenCalledTimes(attempts);
    expect(mock.reviewUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }));
  });

  const meta = (over: Record<string, unknown> = {}) => ({
    model: "m", filesReviewed: 1, filesSkipped: [], chunks: 2, failedChunks: 0, chunkErrors: [],
    comments: { fromModel: 0, droppedInvalidLine: 0, droppedDuplicate: 0, droppedOverLimit: 0 },
    summaryFallback: false, context: { enabled: true, tokens: 0, blocks: 0, dropped: 0, errors: 0 },
    promptTokens: 10, completionTokens: 5, latencyMs: 1, ...over,
  });

  it("passes step.run and the env settings to the review core", async () => {
    process.env.CHUNK_TOKEN_BUDGET = "5000";
    delete process.env.MAX_COMMENTS;
    mock.reviewPullRequest.mockResolvedValue({ summary: "ok", riskScore: 1, comments: [], meta: meta() });
    const runs: string[] = [];
    const trackingStep = { run: (name: string, fn: () => unknown) => { runs.push(name); return fn(); } };
    await mock.handler({ event, step: trackingStep });

    const [input, deps, options] = mock.reviewPullRequest.mock.calls[0]!;
    expect(input).toMatchObject({ title: "Test", ref: "head-sha", files: [{ filename: "src/a.ts", patch: "+const a = 1;" }] });
    expect(typeof input.contextProvider.getFile).toBe("function");
    expect(options).toEqual({ chunkTokenBudget: 5000, maxComments: 15, contextTokenBudget: 4000 });
    await deps.runStep("review-chunk-0", async () => "done");
    expect(runs).toContain("review-chunk-0");
    delete process.env.CHUNK_TOKEN_BUDGET;
  });

  it("saves meta, and zodValid=false when a chunk failed", async () => {
    const m = meta({ failedChunks: 1, chunkErrors: [{ chunk: 1, error: "not json" }] });
    mock.reviewPullRequest.mockResolvedValue({ summary: "partial", riskScore: 40, comments: [], meta: m });
    await expect(mock.handler({ event, step })).resolves.toMatchObject({ success: true });
    expect(mock.reviewUpdate).toHaveBeenCalledWith({
      where: { id: "review-1" },
      data: expect.objectContaining({ status: "COMPLETED", zodValid: false, meta: m, promptTokens: 10, completionTokens: 5 }),
    });
  });

  it("throws on the first forced benchmark attempt and completes on retry", async () => {
    process.env.BENCH_ENABLE_RETRY_TEST = "true";
    mock.reviewUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    mock.reviewPullRequest.mockResolvedValue({
      summary: "Reviewed", riskScore: 0, comments: [], meta: meta(),
    });
    const retryEvent = { data: { ...event.data, forceRetryTest: true } };

    await expect(mock.handler({ event: retryEvent, step })).rejects.toThrow("Forced benchmark retry test failure");
    await expect(mock.handler({ event: retryEvent, step })).resolves.toMatchObject({ success: true });

    expect(mock.reviewUpdateMany).toHaveBeenCalledTimes(3);
    expect(mock.reviewUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "review-1" },
      data: expect.objectContaining({ status: "COMPLETED", zodValid: true, promptTokens: 10, completionTokens: 5 }),
    }));
  });
});

describe("markReviewFailed (onFailure)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is registered as the job's onFailure handler and reads the original event's reviewId", async () => {
    const opts = (reviewPR as unknown as { opts: { onFailure: (ctx: unknown) => Promise<void> } }).opts;
    await opts.onFailure({ event: { data: { event: { data: { reviewId: "review-9" } } } }, error: new Error("boom") });
    expect(mock.reviewUpdateMany).toHaveBeenCalledWith({
      where: { id: "review-9", status: { not: "COMPLETED" } },
      data: { status: "FAILED", error: "boom" },
    });
  });

  it("never overwrites a review that already completed", async () => {
    await markReviewFailed("review-1", new Error("late failure"));
    expect(mock.reviewUpdateMany.mock.calls[0]![0].where.status).toEqual({ not: "COMPLETED" });
  });
});

describe("shortErrorMessage", () => {
  it("keeps only the reason line of a multi-line Prisma error, not the query dump", () => {
    const prisma = new Error("\nInvalid `prisma.review.update()` invocation:\n{\n  data: { summary: \"long review text\" }\n}\n\nUnknown argument `promptTokens`. Available options are marked with ?.");
    expect(shortErrorMessage(prisma)).toBe("Unknown argument `promptTokens`. Available options are marked with ?.");
  });

  it("handles non-Error values, empty messages and very long lines", () => {
    expect(shortErrorMessage("plain")).toBe("plain");
    expect(shortErrorMessage(new Error(""))).toBe("Unknown error");
    const long = shortErrorMessage(new Error("x".repeat(500)));
    expect(long).toHaveLength(300);
    expect(long.endsWith("...")).toBe(true);
  });
});
