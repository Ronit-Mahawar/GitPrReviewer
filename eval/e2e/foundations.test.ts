import { describe, expect, it } from "vitest";
import { reconstructFiles } from "../diff";
import { matchComments } from "../match";
import { assertAllowedRepo, assertEvalBranch, assertSafeRepoPath } from "./safety";

describe("diff and comment line mapping", () => {
  it("reconstructs added and context lines from a unified diff", () => {
    const files = reconstructFiles("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n const before = 1;\n+const after = 2;\n");
    expect(files["src/a.ts"]).toBe("const before = 1;\nconst after = 2;");
  });

  it("maps a finding only to a matching file and line range", () => {
    const result = matchComments([{ file: "src/a.ts", line: 2, message: "Possible null dereference" }], [{ file: "src/a.ts", line_start: 2, line_end: 2, bug_type: "null_deref", severity: "high", description: "null" }]);
    expect(result.labels[0].auto_label).toBe("TP");
    expect(result.missed_truth).toEqual([]);
  });

  it("refuses repos outside an explicit allowlist and branches outside eval/*", () => {
    expect(() => assertAllowedRepo("example/sandbox")).toThrow(/allowlist/);
    expect(() => assertAllowedRepo("other/repo", new Set(["owner/sandbox"]))).toThrow(/allowlist/);
    expect(() => assertAllowedRepo("owner/sandbox", new Set(["owner/sandbox"]))).not.toThrow();
    expect(() => assertEvalBranch("feature/unsafe")).toThrow(/eval/);
    expect(() => assertEvalBranch("eval/case-123")).not.toThrow();
  });

  it("rejects paths that escape the cloned repository", () => {
    expect(() => assertSafeRepoPath("../../outside.txt")).toThrow(/Unsafe path/);
    expect(() => assertSafeRepoPath("src/safe.ts")).not.toThrow();
  });
});
