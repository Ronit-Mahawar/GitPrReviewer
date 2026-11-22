import { describe, expect, it } from "vitest";
import { applyPatch } from "./apply-patch";

describe("applyPatch", () => {
  it("applies additions, deletions and context in the middle of a file", () => {
    const old = "a\nb\nc\nd\ne\n";
    expect(applyPatch(old, "@@ -2,3 +2,3 @@\n b\n-c\n+C\n d")).toBe("a\nb\nC\nd\ne\n");
  });

  it("applies several hunks and appends at the end", () => {
    const old = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const patch = "@@ -1,2 +1,3 @@\n l1\n+new\n l2\n@@ -9,2 +10,4 @@\n l9\n l10\n+x\n+y";
    expect(applyPatch(old, patch)).toBe("l1\nnew\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nx\ny\n");
  });

  it("creates a new file from an empty one", () => {
    expect(applyPatch("", "@@ -0,0 +1,2 @@\n+one\n+two")).toBe("one\ntwo\n");
  });

  it("handles an insertion hunk with 0 old lines after a given line", () => {
    expect(applyPatch("a\nb\n", "@@ -1,0 +2 @@\n+inserted")).toBe("a\ninserted\nb\n");
  });

  it("respects 'No newline at end of file'", () => {
    expect(applyPatch("a\n", "@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file")).toBe("b");
  });

  it("throws when the patch doesn't match the file", () => {
    expect(() => applyPatch("a\nb\n", "@@ -1,2 +1,2 @@\n a\n-not-b\n+c")).toThrow(/does not match/);
  });
});
