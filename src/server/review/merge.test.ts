import { describe, expect, it } from "vitest";
import { mergeComments } from "./merge";
import type { ReviewComment } from "./schema";

const c = (file: string, line: number, severity: ReviewComment["severity"] = "medium", category: ReviewComment["category"] = "bug"): ReviewComment => ({
  file, line, severity, category, message: `${severity} ${file}:${line}`,
});
const valid = (entries: Record<string, number[]>) => new Map(Object.entries(entries).map(([f, lines]) => [f, new Set(lines)]));

describe("mergeComments", () => {
  it("drops comments on lines that aren't added lines, or files that weren't reviewed", () => {
    const { comments, stats } = mergeComments([[c("a.ts", 10), c("a.ts", 11), c("b.ts", 10)]], valid({ "a.ts": [10] }));
    expect(comments.map((x) => `${x.file}:${x.line}`)).toEqual(["a.ts:10"]);
    expect(stats).toEqual({ fromModel: 3, droppedInvalidLine: 2, droppedDuplicate: 0, droppedOverLimit: 0 });
  });

  it("sorts by severity, then file and line", () => {
    const lines = valid({ "a.ts": [1, 50], "b.ts": [1] });
    const { comments } = mergeComments([[c("b.ts", 1, "low"), c("a.ts", 50, "critical"), c("a.ts", 1, "low"), c("b.ts", 1, "high", "security")]], lines);
    expect(comments.map((x) => x.message)).toEqual(["critical a.ts:50", "high b.ts:1", "low a.ts:1", "low b.ts:1"]);
  });

  it("removes duplicates (same file and category, lines within 2), keeping the most severe", () => {
    const lines = valid({ "a.ts": [10, 11, 12, 13, 20] });
    const { comments, stats } = mergeComments(
      [[c("a.ts", 10, "low"), c("a.ts", 12, "high")], [c("a.ts", 11, "medium"), c("a.ts", 13, "medium", "security"), c("a.ts", 20, "low")]],
      lines,
    );
    expect(comments.map((x) => x.message)).toEqual(["high a.ts:12", "medium a.ts:13", "low a.ts:20"]);
    expect(stats.droppedDuplicate).toBe(2);
  });

  it("does not treat lines 3 apart, or other files, as duplicates", () => {
    const { comments } = mergeComments([[c("a.ts", 10), c("a.ts", 13), c("b.ts", 10)]], valid({ "a.ts": [10, 13], "b.ts": [10] }));
    expect(comments).toHaveLength(3);
  });

  it("keeps only the top maxComments", () => {
    const lines = valid({ "a.ts": Array.from({ length: 100 }, (_, i) => i) });
    const many = Array.from({ length: 20 }, (_, i) => c("a.ts", i * 5, i < 3 ? "critical" : "low"));
    const { comments, stats } = mergeComments([many], lines, 15);
    expect(comments).toHaveLength(15);
    expect(comments.slice(0, 3).every((x) => x.severity === "critical")).toBe(true);
    expect(stats.droppedOverLimit).toBe(5);
  });

  it("returns nothing for no comments", () => {
    expect(mergeComments([], new Map())).toEqual({
      comments: [],
      stats: { fromModel: 0, droppedInvalidLine: 0, droppedDuplicate: 0, droppedOverLimit: 0 },
    });
  });
});
