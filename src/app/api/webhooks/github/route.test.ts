import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const mock = vi.hoisted(() => ({
  repositoryFindUnique: vi.fn(), webhookCreate: vi.fn(), reviewFindFirst: vi.fn(), reviewCreate: vi.fn(), send: vi.fn(),
}));
vi.mock("@/server/db", () => ({ db: { repository: { findUnique: mock.repositoryFindUnique }, webhookDelivery: { create: mock.webhookCreate }, review: { findFirst: mock.reviewFindFirst, create: mock.reviewCreate } } }));
vi.mock("@/server/inngest", () => ({ inngest: { send: mock.send } }));

import { POST } from "./route";

function signedRequest(payload: string, event = "pull_request", signatureOverride?: string) {
  const signature = signatureOverride ?? `sha256=${crypto.createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET!).update(payload).digest("hex")}`;
  return new Request("http://localhost/api/webhooks/github", { method: "POST", body: payload, headers: {
    "x-hub-signature-256": signature, "x-github-event": event, "x-github-delivery": "delivery-test-1",
  } });
}
const payload = JSON.stringify({ action: "opened", number: 9, pull_request: { id: 9, number: 9, title: "Safe test", html_url: "https://example.test/pr/9", state: "open", draft: false, head: { sha: "abc" } }, repository: { id: 1, full_name: "owner/repo" } });

describe("GitHub webhook", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
    vi.clearAllMocks();
    mock.repositoryFindUnique.mockResolvedValue({ id: "repo-id", userId: "user-id", autoReviewEnabled: true });
    mock.webhookCreate.mockResolvedValue({}); mock.reviewFindFirst.mockResolvedValue(null);
    mock.reviewCreate.mockResolvedValue({ id: "review-id" }); mock.send.mockResolvedValue({});
  });

  it("rejects a bad signature", async () => {
    const response = await POST(signedRequest(payload, "pull_request", "sha256=bad") as any);
    expect(response.status).toBe(401);
    expect(mock.repositoryFindUnique).not.toHaveBeenCalled();
  });

  it("ignores a validly signed unsupported event", async () => {
    const response = await POST(signedRequest(payload, "issues") as any);
    expect(response.status).toBe(200);
    expect(mock.repositoryFindUnique).not.toHaveBeenCalled();
  });

  it("stores the review and sends the background event for a valid PR delivery", async () => {
    const response = await POST(signedRequest(payload) as any);
    expect(response.status).toBe(200);
    expect(mock.webhookCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ deliveryId: "delivery-test-1", event: "pull_request" }) });
    expect(mock.reviewCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ prNumber: 9, status: "PENDING" }) });
    expect(mock.send).toHaveBeenCalledWith(expect.objectContaining({ name: "review/pr.requested" }));
  });
});
