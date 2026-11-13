import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  handler: undefined as any,
  reviewUpdate: vi.fn(), reviewUpdateMany: vi.fn(), repositoryFindUnique: vi.fn(), getToken: vi.fn(), fetchFiles: vi.fn(), fetchPr: vi.fn(), reviewCode: vi.fn(),
}));
vi.mock("../client", () => ({ inngest: { createFunction: vi.fn((opts: any, _trigger: any, handler: any) => { mock.handler = handler; return { opts, fn: handler }; }) } }));
vi.mock("@/server/db", () => ({ db: { review: { update: mock.reviewUpdate, updateMany: mock.reviewUpdateMany }, repository: { findUnique: mock.repositoryFindUnique } } }));
vi.mock("@/server/services/github", () => ({ getGitHubAccessToken: mock.getToken, fetchPullRequestFiles: mock.fetchFiles, fetchPullRequest: mock.fetchPr }));
vi.mock("@/server/services/ai", () => ({ reviewCode: mock.reviewCode, ReviewOutputValidationError: class extends Error {} }));

import { reviewPR } from "./review-pr";

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
    mock.fetchPr.mockResolvedValue({ title: "Test" });
  });

  it("retries LLM errors and ends the stored review in a terminal state", async () => {
    mock.reviewCode.mockRejectedValue(new Error("LLM unavailable"));
    const attempts = Number((reviewPR as any).opts.retries ?? 0) + 1;
    for (let i = 0; i < attempts; i++) await expect(mock.handler({ event, step })).rejects.toThrow("LLM unavailable");
    expect(mock.reviewCode).toHaveBeenCalledTimes(attempts);
    expect(mock.reviewUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }));
  });

  it("throws on the first forced benchmark attempt and completes on retry", async () => {
    process.env.BENCH_ENABLE_RETRY_TEST = "true";
    mock.reviewUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    mock.reviewCode.mockResolvedValue({
      result: { summary: "Reviewed", riskScore: 0, comments: [] },
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      zodValid: true,
    });
    const retryEvent = { data: { ...event.data, forceRetryTest: true } };

    await expect(mock.handler({ event: retryEvent, step })).rejects.toThrow("Forced benchmark retry test failure");
    await expect(mock.handler({ event: retryEvent, step })).resolves.toMatchObject({ success: true });

    expect(mock.reviewUpdateMany).toHaveBeenCalledTimes(3);
    expect(mock.reviewUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "review-1" },
      data: expect.objectContaining({ status: "COMPLETED", zodValid: true }),
    }));
  });
});
