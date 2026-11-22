/**
 * Applies a GitHub-style patch (hunks only) to a file's old contents and returns the new contents.
 * Evals use it to rebuild "the repo after the PR" from the fixture repo plus a case's diff, so the
 * context provider can show the changed file as it is after the PR, like GitHub at the head commit.
 */
export function applyPatch(oldText: string, patch: string): string {
  const oldLines = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let oldIndex = 0; // next old line (0-based) not yet copied
  let noNewlineAtEnd = false;

  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk) {
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      // A hunk with 0 old lines starts *after* line oldStart; otherwise it starts *at* it.
      const firstOld = oldCount === 0 ? oldStart : oldStart - 1;
      while (oldIndex < firstOld) out.push(oldLines[oldIndex++]!);
      continue;
    }
    if (line.startsWith("+")) out.push(line.slice(1));
    else if (line.startsWith("-")) {
      if (oldLines[oldIndex] !== line.slice(1)) throw new Error(`patch does not match: expected "${line.slice(1)}" at old line ${oldIndex + 1}`);
      oldIndex++;
    } else if (line.startsWith(" ")) {
      if (oldLines[oldIndex] !== line.slice(1)) throw new Error(`patch does not match: expected "${line.slice(1)}" at old line ${oldIndex + 1}`);
      out.push(oldLines[oldIndex++]!);
    } else if (line.startsWith("\\")) {
      noNewlineAtEnd = true; // "\ No newline at end of file" (applies to the line before it)
    }
  }
  while (oldIndex < oldLines.length) out.push(oldLines[oldIndex++]!);
  return out.join("\n") + (out.length > 0 && !noNewlineAtEnd ? "\n" : "");
}
