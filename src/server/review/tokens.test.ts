import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, estimateTokens } from "./tokens";

describe("estimateTokens", () => {
  it("is 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });
  it("rounds up, so any non-empty text costs at least 1 token", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2); // 5 / 2.5 = 2 exactly
    expect(estimateTokens("abcdef")).toBe(3); // 6 / 2.5 = 2.4 → 3
  });
  it("grows linearly with length", () => {
    expect(estimateTokens("x".repeat(25_000))).toBe(25_000 / CHARS_PER_TOKEN);
  });
  it("counts characters, not bytes (multi-byte text isn't overcounted)", () => {
    expect(estimateTokens("é".repeat(5))).toBe(2);
  });
});
