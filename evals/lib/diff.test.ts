import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff";

const modified = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@ export const x = 1;
 keep
-old
+new
 keep
`;

describe("parseUnifiedDiff", () => {
  it("parses a modified file like GitHub's files API (patch starts at the first hunk)", () => {
    expect(parseUnifiedDiff(modified)).toEqual([
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,3 +1,3 @@ export const x = 1;\n keep\n-old\n+new\n keep" },
    ]);
  });

  it("parses a new file and a deleted file", () => {
    const diff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.filename, f.status, f.additions, f.deletions])).toEqual([
      ["src/new.ts", "added", 2, 0],
      ["src/gone.ts", "removed", 0, 1],
    ]);
  });

  it("parses a pure rename (no hunks, so no patch) and a rename with changes", () => {
    const diff = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
diff --git a/a.ts b/b.ts
similarity index 80%
rename from a.ts
rename to b.ts
index 5555555..6666666 100644
--- a/a.ts
+++ b/b.ts
@@ -1 +1 @@
-x
+y
`;
    const [pure, changed] = parseUnifiedDiff(diff);
    expect(pure).toEqual({ filename: "new.ts", status: "renamed", additions: 0, deletions: 0 });
    expect(changed).toMatchObject({ filename: "b.ts", status: "renamed", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-x\n+y" });
  });

  it("gives a binary file no patch", () => {
    const diff = `diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/logo.png differ
`;
    expect(parseUnifiedDiff(diff)).toEqual([{ filename: "logo.png", status: "added", additions: 0, deletions: 0 }]);
  });

  it("keeps the 'No newline at end of file' marker in the patch without counting it", () => {
    const diff = `diff --git a/a.txt b/a.txt
index 1..2 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
\\ No newline at end of file
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file).toMatchObject({ additions: 1, deletions: 1 });
    expect(file!.patch!.split("\n")).toEqual(["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file"]);
  });

  it("does not count '+++'/'---' header lines as changes", () => {
    expect(parseUnifiedDiff(modified)[0]).toMatchObject({ additions: 1, deletions: 1 });
  });

  it("returns no files for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
