import { describe, expect, it } from "vitest";
import { parseJsonObject, parseReview, ReviewOutputValidationError } from "./parse";

const valid = { summary: "Reviewed", riskScore: 12, comments: [] };
const usage = { promptTokens: 10, completionTokens: 5 };

describe("parseJsonObject", () => {
  it("parses plain JSON", () => {
    expect(parseJsonObject(JSON.stringify(valid))).toEqual(valid);
  });
  it("recovers JSON followed by stray characters", () => {
    expect(parseJsonObject(`${JSON.stringify(valid)}\n\`\``)).toEqual(valid);
  });
  it("recovers JSON wrapped in a code fence", () => {
    expect(parseJsonObject("```json\n" + JSON.stringify(valid) + "\n```")).toEqual(valid);
  });
  it("handles braces and escaped quotes inside strings", () => {
    expect(parseJsonObject('note: {"a":"}{ \\"x\\"","b":{"c":1}} trailing')).toEqual({ a: '}{ "x"', b: { c: 1 } });
  });
  it("throws when there is no object", () => {
    expect(() => parseJsonObject("nothing here")).toThrow();
  });
  it("throws on a cut-off object", () => {
    expect(() => parseJsonObject('{"summary": "cut')).toThrow();
  });
});

describe("parseReview", () => {
  it("returns the validated review", () => {
    expect(parseReview(JSON.stringify(valid), usage)).toEqual(valid);
  });
  it("throws ReviewOutputValidationError with usage and raw output on bad JSON", () => {
    try {
      parseReview("not-json", usage);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewOutputValidationError);
      expect((error as ReviewOutputValidationError).usage).toEqual(usage);
      expect((error as ReviewOutputValidationError).rawOutput).toBe("not-json");
    }
  });
  it("throws ReviewOutputValidationError when the schema doesn't match", () => {
    expect(() => parseReview(JSON.stringify({ ...valid, riskScore: 150 }), usage)).toThrow(ReviewOutputValidationError);
    expect(() => parseReview(JSON.stringify({ summary: "x", riskScore: 1, comments: [{ file: "a", line: 1 }] }), usage)).toThrow(
      ReviewOutputValidationError,
    );
  });
});
