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

  it("accepts valid JSON followed by stray characters", async () => {
    mock.create.mockResolvedValue(response(`${JSON.stringify(validReview)}\n\`\``));
    const result = await reviewDiffWithUsage("title", "diff");
    expect(result.result).toEqual(validReview);
  });

  it("accepts JSON wrapped in a code fence", async () => {
    mock.create.mockResolvedValue(response("```json\n" + JSON.stringify(validReview) + "\n```"));
    const result = await reviewDiffWithUsage("title", "diff");
    expect(result.result).toEqual(validReview);
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

import { numberPatch, parseJsonObject } from "./ai";

describe("parseJsonObject", () => {
  it("handles braces inside strings when recovering", () => {
    expect(parseJsonObject('note: {"a":"}{","b":{"c":1}} trailing')).toEqual({ a: "}{", b: { c: 1 } });
  });
  it("throws when there is no object", () => {
    expect(() => parseJsonObject("nothing here")).toThrow();
  });
});

describe("numberPatch", () => {
  it("labels added and context lines with new-file numbers and skips removed lines", () => {
    const patch = ["@@ -10,3 +10,3 @@ fn", " a", "-b", "+B", " c", "@@ -40,1 +40,2 @@", " x", "+y"].join("\n");
    expect(numberPatch(patch).split("\n")).toEqual([
      "@@ -10,3 +10,3 @@ fn",
      "L10    a",
      "      -b",
      "L11   +B",
      "L12    c",
      "@@ -40,1 +40,2 @@",
      "L40    x",
      "L41   +y",
    ]);
  });
});
