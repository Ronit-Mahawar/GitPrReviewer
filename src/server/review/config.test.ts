import { describe, expect, it } from "vitest";
import { parsePositiveInt } from "./config";

describe("parsePositiveInt", () => {
  it("parses a positive integer", () => {
    expect(parsePositiveInt("7000", 1)).toBe(7000);
    expect(parsePositiveInt(" 15 ", 1)).toBe(15);
  });
  it.each([undefined, "", "  ", "0", "-5", "1.5", "abc", "12px"])("falls back for %j", (raw) => {
    expect(parsePositiveInt(raw, 42)).toBe(42);
  });
});
