import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: mock.create } }; } }));

import { reviewDiffWithUsage } from "./ai";

const validReview = { summary: "Reviewed", riskScore: 12, comments: [] };
function response(content: string | null) {
  return { choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8 } };
}

describe("reviewDiffWithUsage", () => {
  beforeEach(() => { process.env.GEMINI_API_KEY = "test-only-key"; mock.create.mockReset(); });

  it("returns validated output and usage for a valid LLM response", async () => {
    mock.create.mockResolvedValue(response(JSON.stringify(validReview)));
    const result = await reviewDiffWithUsage("title", "diff text");
    expect(result.result).toEqual(validReview);
    expect(result.usage).toEqual({ prompt_tokens: 20, completion_tokens: 8 });
    expect(result.raw_output).toBe(JSON.stringify(validReview));
  });

  it("rejects malformed JSON", async () => {
    mock.create.mockResolvedValue(response("not-json"));
    await expect(reviewDiffWithUsage("title", "diff")).rejects.toThrow();
  });

  it("rejects an empty LLM response", async () => {
    mock.create.mockResolvedValue(response(null));
    await expect(reviewDiffWithUsage("title", "diff")).rejects.toThrow("No response from AI");
  });

  it("propagates a timeout from the mocked client", async () => {
    mock.create.mockRejectedValue(new Error("request timeout"));
    await expect(reviewDiffWithUsage("title", "diff")).rejects.toThrow("request timeout");
  });
});
