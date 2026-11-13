import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ fetchPullRequest: vi.fn(), getGitHubAccessToken: vi.fn(), send: vi.fn() }));
vi.mock("@/server/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("@/server/services/github", () => ({ fetchPullRequest: mock.fetchPullRequest, getGitHubAccessToken: mock.getGitHubAccessToken }));
vi.mock("@/server/inngest", () => ({ inngest: { send: mock.send } }));

import { reviewRouter } from "./review";

function caller(session: any, db: any) {
  return (reviewRouter as any).createCaller({ session, db, headers: new Headers() });
}
const userSession = { user: { id: "user-a", name: "A", email: "a@example.test" }, session: { id: "session" } };

describe("review router", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("requires authentication", async () => {
    const api = caller(null, {});
    await expect(api.get({ id: "review-1" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("scopes reads to the signed-in user", async () => {
    const db = { review: { findUnique: vi.fn().mockResolvedValue(null) } };
    await expect(caller(userSession, db).get({ id: "other-user-review" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.review.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "other-user-review", userId: "user-a" } }));
  });

  it("returns a review belonging to the signed-in user", async () => {
    const stored = { id: "review-a", userId: "user-a", status: "COMPLETED" };
    const db = { review: { findUnique: vi.fn().mockResolvedValue(stored) } };
    await expect(caller(userSession, db).get({ id: "review-a" })).resolves.toEqual(stored);
    expect(db.review.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "review-a", userId: "user-a" } }));
  });

  it("stores a pending review and queues its Inngest event", async () => {
    const repository = { id: "repo-1", userId: "user-a", fullName: "owner/repo" };
    const review = { id: "review-1", status: "PENDING" };
    const db = { repository: { findUnique: vi.fn().mockResolvedValue(repository) }, review: { create: vi.fn().mockResolvedValue(review) } };
    mock.getGitHubAccessToken.mockResolvedValue("mock-token");
    mock.fetchPullRequest.mockResolvedValue({ number: 4, title: "Test PR", html_url: "https://github.invalid/pr/4" });
    mock.send.mockResolvedValue({ ids: ["event-1"] });

    await expect(caller(userSession, db).trigger({ repositoryId: "repo-1", prNumber: 4 })).resolves.toEqual({ reviewId: "review-1" });
    expect(db.review.create).toHaveBeenCalledWith({ data: expect.objectContaining({ repositoryId: "repo-1", userId: "user-a", status: "PENDING" }) });
    expect(mock.send).toHaveBeenCalledWith(expect.objectContaining({ name: "review/pr.requested", data: expect.objectContaining({ reviewId: "review-1" }) }));
  });
});
