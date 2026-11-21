/**
 * Turns a unified diff (output of `git diff`) into the per-file list GitHub's
 * "list pull request files" API returns, so evals feed the reviewer the same shape as production.
 */
import type { FileChange } from "../../src/server/review/schema";

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  // Each file section starts with "diff --git a/<old> b/<new>".
  const sections = diff.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git "));

  for (const section of sections) {
    const lines = section.replace(/\n$/, "").split("\n");
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0]!);
    if (!header) throw new Error(`Bad diff header: ${lines[0]}`);
    let oldPath = header[1]!;
    let newPath = header[2]!;
    let status = "modified";

    const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
    const headerLines = firstHunk === -1 ? lines : lines.slice(0, firstHunk);
    for (const line of headerLines) {
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "removed";
      else if (line.startsWith("rename from ")) { oldPath = line.slice("rename from ".length); status = "renamed"; }
      else if (line.startsWith("rename to ")) newPath = line.slice("rename to ".length);
      else if (line.startsWith("--- ") && line !== "--- /dev/null") oldPath = stripPrefix(line.slice(4));
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") newPath = stripPrefix(line.slice(4));
    }

    const file: FileChange = {
      filename: status === "removed" ? oldPath : newPath,
      status,
      additions: 0,
      deletions: 0,
    };

    // Binary files and pure renames have no hunks, so no patch (GitHub omits it too).
    if (firstHunk !== -1) {
      const patchLines = lines.slice(firstHunk);
      for (const line of patchLines) {
        if (line.startsWith("+")) file.additions++;
        else if (line.startsWith("-")) file.deletions++;
      }
      file.patch = patchLines.join("\n");
    }
    files.push(file);
  }
  return files;
}
