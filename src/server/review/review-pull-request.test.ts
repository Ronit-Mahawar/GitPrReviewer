import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewOutputValidationError } from "./parse";
import { SYSTEM_PROMPT } from "./prompt";
import { reviewPullRequest, type Llm, type LlmReply } from "./review-pull-request";

const files = [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+const a = 1;" }];
const validReview = {
  summary: "Adds a constant",
  riskScore: 5,
  comments: [{ file: "src/a.ts", line: 1, severity: "low" as const, category: "bug" as const, message: "m" }],
};

function fakeLlm(reply: Partial<LlmReply>): ReturnType<typeof vi.fn> & Llm {
  return vi.fn(async () => ({ content: null, model: "fake-model", promptTokens: 100, completionTokens: 20, finishReason: "stop", ...reply }));
}

describe("reviewPullRequest", () => {
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("sends the v1 system prompt and a user prompt with the numbered diff", async () => {
    const llm = fakeLlm({ content: JSON.stringify(validReview) });
    await reviewPullRequest({ title: "Add a", files }, { llm });

    expect(llm).toHaveBeenCalledTimes(1);
    const [messages] = llm.mock.calls[0];
    expect(messages).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: "Review this pull request:\n\n**Title:** Add a\n\n**Changes:**\n### src/a.ts (modified)\n```diff\n@@ -1 +1 @@\nL1    +const a = 1;\n```",
      },
    ]);
  });

  it("returns the parsed review plus meta", async () => {
    const llm = fakeLlm({ content: JSON.stringify(validReview) });
    const out = await reviewPullRequest({ title: "Add a", files }, { llm });

    expect(out).toMatchObject(validReview);
    expect(out.meta).toMatchObject({ model: "fake-model", promptTokens: 100, completionTokens: 20, finishReason: "stop" });
    expect(out.meta.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("skips the model and returns a zero-risk review when no file has a patch", async () => {
    const llm = fakeLlm({});
    const out = await reviewPullRequest({ title: "Binary", files: [{ filename: "a.png", status: "added", additions: 0, deletions: 0 }] }, { llm });

    expect(llm).not.toHaveBeenCalled();
    expect(out).toEqual({
      summary: "No code changes to review (binary files or empty diff).",
      riskScore: 0,
      comments: [],
      meta: { model: null, promptTokens: 0, completionTokens: 0, latencyMs: 0, finishReason: null },
    });
  });

  it("throws when the model returns no content", async () => {
    await expect(reviewPullRequest({ title: "t", files }, { llm: fakeLlm({ content: null }) })).rejects.toThrow("No response from AI");
  });

  it("throws ReviewOutputValidationError carrying usage on invalid JSON, without logging the raw output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const promise = reviewPullRequest({ title: "t", files }, { llm: fakeLlm({ content: "not-json" }) });

    await expect(promise).rejects.toBeInstanceOf(ReviewOutputValidationError);
    await expect(promise).rejects.toMatchObject({ usage: { promptTokens: 100, completionTokens: 20 } });
    expect(log).not.toHaveBeenCalled(); // raw output only at LOG_LEVEL=debug
  });

  it("propagates errors from the llm", async () => {
    const llm: Llm = async () => {
      throw new Error("rate limited");
    };
    await expect(reviewPullRequest({ title: "t", files }, { llm })).rejects.toThrow("rate limited");
  });
});
