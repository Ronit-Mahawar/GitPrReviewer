/**
 * Puts the new-file line number in front of every added and context line of a patch,
 * so the model never has to count lines itself (D4):
 *
 *   @@ -10,3 +10,3 @@ fn
 *     10 | unchanged
 *   -    | removed
 *   + 11 | added
 *
 * Also returns the "valid lines": the added lines, the only ones a comment may point at.
 */

export interface AnnotatedHunk {
  /** The hunk header followed by the annotated lines. */
  text: string;
  /** New-file line numbers of this hunk's added lines. */
  validLines: number[];
}

export interface AnnotatedPatch {
  hunks: AnnotatedHunk[];
  /** All hunks joined; what the model sees for this file. */
  text: string;
  validLines: Set<number>;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

type Line =
  | { kind: "added" | "context"; num: number; code: string }
  | { kind: "deleted"; code: string }
  | { kind: "raw"; text: string }; // "\ No newline at end of file"

export function annotatePatch(patch: string): AnnotatedPatch {
  // 1. Parse into hunks of typed lines, tracking the new-file line number.
  const parsed: Array<{ header: string; lines: Line[] }> = [];
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      newLine = Number(header[1]);
      parsed.push({ header: line, lines: [] });
      continue;
    }
    const hunk = parsed[parsed.length - 1];
    if (!hunk || line === "") continue; // text before the first hunk, or a trailing newline
    if (line.startsWith("+")) hunk.lines.push({ kind: "added", num: newLine++, code: line.slice(1) });
    else if (line.startsWith("-")) hunk.lines.push({ kind: "deleted", code: line.slice(1) });
    else if (line.startsWith("\\")) hunk.lines.push({ kind: "raw", text: line });
    else hunk.lines.push({ kind: "context", num: newLine++, code: line.slice(1) });
  }

  // 2. Format, padding numbers to the same width so the "|" column lines up.
  const width = String(Math.max(0, newLine - 1)).length;
  const blank = " ".repeat(width);
  const format = (l: Line): string => {
    if (l.kind === "raw") return l.text;
    if (l.kind === "deleted") return `- ${blank} | ${l.code}`;
    const marker = l.kind === "added" ? "+" : " ";
    return `${marker} ${String(l.num).padStart(width)} | ${l.code}`;
  };

  const hunks = parsed.map(({ header, lines }) => ({
    text: [header, ...lines.map(format)].join("\n"),
    validLines: lines.flatMap((l) => (l.kind === "added" ? [l.num] : [])),
  }));
  return {
    hunks,
    text: hunks.map((h) => h.text).join("\n"),
    validLines: new Set(hunks.flatMap((h) => h.validLines)),
  };
}
