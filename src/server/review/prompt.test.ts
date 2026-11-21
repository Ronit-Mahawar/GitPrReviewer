import { describe, expect, it } from "vitest";
import { buildDiffText, buildUserPrompt, numberPatch } from "./prompt";

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

  it("handles a new file (hunk without counts) and the no-newline marker", () => {
    const patch = ["@@ -0,0 +1 @@", "+only", "\\ No newline at end of file"].join("\n");
    expect(numberPatch(patch).split("\n")).toEqual(["@@ -0,0 +1 @@", "L1    +only", "\\ No newline at end of file"]);
  });

  it("gives no sensible output for an empty patch, which is why buildDiffText filters those out first", () => {
    // v1 quirk kept as-is in Phase 0; Phase 2's annotate.ts handles empty patches properly.
    expect(numberPatch("")).toBe("L0    ");
  });
});

describe("buildDiffText", () => {
  it("skips files without a patch and formats one block per file", () => {
    const text = buildDiffText([
      { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" },
      { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
    ]);
    expect(text).toBe("### a.ts (modified)\n```diff\n@@ -1 +1 @@\nL1    +x\n```");
  });

  it("returns an empty string when no file has a patch", () => {
    expect(buildDiffText([{ filename: "logo.png", status: "added", additions: 0, deletions: 0 }])).toBe("");
  });
});

describe("buildUserPrompt", () => {
  it("puts the title and diff in the v1 layout", () => {
    expect(buildUserPrompt("Fix bug", "DIFF")).toBe("Review this pull request:\n\n**Title:** Fix bug\n\n**Changes:**\nDIFF");
  });
});
