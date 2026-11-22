import { describe, expect, it, vi } from "vitest";
import type { LlmReply } from "../../src/server/review/review-pull-request";
import { withRetries } from "./retry";

const ok: LlmReply = { content: "{}", model: "m", promptTokens: 1, completionTokens: 1, finishReason: "stop" };
const noSleep = vi.fn(async () => {});

describe("withRetries", () => {
  it("returns the first successful reply without retrying", async () => {
    const llm = vi.fn(async () => ok);
    expect(await withRetries(llm, [5, 10], noSleep)([])).toBe(ok);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("retries provider errors with the given delays", async () => {
    const llm = vi.fn().mockRejectedValueOnce(new Error("429")).mockRejectedValueOnce(new Error("503")).mockResolvedValue(ok);
    const sleep = vi.fn(async () => {});
    expect(await withRetries(llm, [5, 10], sleep)([])).toBe(ok);
    expect(sleep.mock.calls).toEqual([[5], [10]]);
  });

  it("throws the last error once the delays run out", async () => {
    const llm = vi.fn().mockRejectedValue(new Error("429 again"));
    await expect(withRetries(llm, [5], noSleep)([])).rejects.toThrow("429 again");
    expect(llm).toHaveBeenCalledTimes(2);
  });
});
