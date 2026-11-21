import { describe, expect, it } from "vitest";
import { annotatePatch } from "./annotate";

describe("annotatePatch", () => {
  it("numbers added and context lines, marks deleted lines, and collects added lines as valid", () => {
    const patch = ["@@ -8,3 +8,3 @@ function f() {", " keep", "-old", "+new", " keep2"].join("\n");
    const out = annotatePatch(patch);
    expect(out.text.split("\n")).toEqual([
      "@@ -8,3 +8,3 @@ function f() {",
      "   8 | keep",
      "-    | old",
      "+  9 | new",
      "  10 | keep2",
    ]);
    expect([...out.validLines]).toEqual([9]);
  });

  it("handles several hunks and keeps them separate", () => {
    const patch = ["@@ -1,2 +1,2 @@", " a", "+b", "@@ -40,1 +40,2 @@", " x", "+y"].join("\n");
    const out = annotatePatch(patch);
    expect(out.hunks).toHaveLength(2);
    expect(out.hunks[0]!.validLines).toEqual([2]);
    expect(out.hunks[1]!.validLines).toEqual([41]);
    expect(out.hunks[1]!.text).toBe("@@ -40,1 +40,2 @@\n  40 | x\n+ 41 | y"); // width 2: the largest number is 41
    expect(out.text).toBe(out.hunks.map((h) => h.text).join("\n"));
  });

  it("handles a new file whose header has no line counts", () => {
    const out = annotatePatch("@@ -0,0 +1 @@\n+only");
    expect(out.text).toBe("@@ -0,0 +1 @@\n+ 1 | only");
    expect([...out.validLines]).toEqual([1]);
  });

  it("passes the 'No newline at end of file' marker through without a number", () => {
    const patch = ["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file"].join("\n");
    expect(annotatePatch(patch).text.split("\n")).toEqual([
      "@@ -1 +1 @@",
      "-   | a",
      "\\ No newline at end of file",
      "+ 1 | b",
      "\\ No newline at end of file",
    ]);
  });

  it("keeps blank context lines (a single space) and their numbering", () => {
    const out = annotatePatch(["@@ -1,3 +1,3 @@", " a", " ", "+c"].join("\n"));
    expect(out.text.split("\n")).toEqual(["@@ -1,3 +1,3 @@", "  1 | a", "  2 | ", "+ 3 | c"]);
  });

  it("returns nothing for an empty patch, or text with no hunk header", () => {
    expect(annotatePatch("")).toEqual({ hunks: [], text: "", validLines: new Set() });
    expect(annotatePatch("+stray line").hunks).toEqual([]);
  });

  it("ignores a trailing newline", () => {
    expect(annotatePatch("@@ -1 +1 @@\n+x\n").text).toBe("@@ -1 +1 @@\n+ 1 | x");
  });

  it("pads numbers to the widest line number in the file", () => {
    const out = annotatePatch(["@@ -98,2 +98,3 @@", " a", "+b", " c"].join("\n"));
    expect(out.text.split("\n").slice(1)).toEqual(["   98 | a", "+  99 | b", "  100 | c"]);
  });

  it("has no valid lines when a hunk only deletes", () => {
    const out = annotatePatch("@@ -5,2 +4,0 @@\n-a\n-b");
    expect(out.validLines.size).toBe(0);
    expect(out.text).toBe("@@ -5,2 +4,0 @@\n-   | a\n-   | b");
  });
});
