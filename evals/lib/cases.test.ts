import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { addedLines, loadCases, parseCase } from "./cases";

const diff = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,3 @@
 context
+added
 context
`;
const bug = { file: "src/a.ts", line: 11, category: "off-by-one", description: "Loop runs one time too many." };

describe("addedLines", () => {
  it("returns new-file numbers of + lines only", () => {
    const patch = "@@ -10,3 +10,3 @@\n a\n-b\n+B\n c\n@@ -40,1 +40,2 @@\n x\n+y";
    expect([...addedLines(patch)]).toEqual([11, 41]);
  });
  it("is empty for an empty patch", () => {
    expect(addedLines("").size).toBe(0);
  });
});

describe("parseCase", () => {
  it("accepts a valid bug case and attaches the parsed files", () => {
    const c = parseCase("my-case", { id: "my-case", title: "T", kind: "bug", bug }, diff);
    expect(c.files).toHaveLength(1);
    expect(c.bug).toEqual(bug);
  });

  it("rejects an id that doesn't match the folder", () => {
    expect(() => parseCase("folder", { id: "other", title: "T", kind: "clean" }, diff)).toThrow(/must match the folder/);
  });

  it("rejects a bug case without a bug, and a clean case with one", () => {
    expect(() => parseCase("c", { id: "c", title: "T", kind: "bug" }, diff)).toThrow(/need a bug/);
    expect(() => parseCase("c", { id: "c", title: "T", kind: "clean", bug }, diff)).toThrow(/must not have a bug/);
  });

  it("allows a large case with or without a bug", () => {
    expect(() => parseCase("c", { id: "c", title: "T", kind: "large" }, diff)).not.toThrow();
    expect(() => parseCase("c", { id: "c", title: "T", kind: "large", bug }, diff)).not.toThrow();
  });

  it("rejects a bug line that isn't an added line, or a file not in the diff", () => {
    expect(() => parseCase("c", { id: "c", title: "T", kind: "bug", bug: { ...bug, line: 10 } }, diff)).toThrow(/not an added line/);
    expect(() => parseCase("c", { id: "c", title: "T", kind: "bug", bug: { ...bug, file: "src/b.ts" } }, diff)).toThrow(/not in pr.diff/);
  });

  it("rejects an empty diff and an unknown kind", () => {
    expect(() => parseCase("c", { id: "c", title: "T", kind: "clean" }, "")).toThrow(/no files/);
    expect(() => parseCase("c", { id: "c", title: "T", kind: "weird" }, diff)).toThrow();
  });
});

describe("loadCases (the real evals/cases folder)", () => {
  const casesDir = join(resolve(__dirname, ".."), "cases");
  it("loads every case without errors", () => {
    const cases = loadCases(casesDir);
    expect(cases.length).toBeGreaterThanOrEqual(3);
    const kinds = new Set(cases.map((c) => c.kind));
    for (const kind of ["bug", "clean", "large"]) expect(kinds.has(kind as "bug")).toBe(true);
  });
  it("filters by id prefix", () => {
    expect(loadCases(casesDir, ["example-"]).map((c) => c.id)).toEqual([
      "example-bug-delete-user-idor",
      "example-clean-page-param",
      "example-large-reports",
    ]);
  });
});
