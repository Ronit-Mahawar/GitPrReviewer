/**
 * Combines the comments from every chunk into the final list (D4, D14):
 *   1. drop comments whose line isn't an added line of that file (the model may cite context or invent lines)
 *   2. sort by severity, most severe first
 *   3. drop duplicates: same file, same category, lines within 2 of each other (the most severe copy is kept)
 *   4. keep the top `maxComments`
 */
import type { ReviewComment } from "./schema";

export const DEFAULT_MAX_COMMENTS = 15;
export const DUPLICATE_LINE_DISTANCE = 2;

const SEVERITY_RANK: Record<ReviewComment["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface MergeStats {
  /** Comments the model returned across all successful chunks. */
  fromModel: number;
  droppedInvalidLine: number;
  droppedDuplicate: number;
  droppedOverLimit: number;
}

export interface MergeResult {
  comments: ReviewComment[];
  stats: MergeStats;
}

/**
 * @param commentLists comments from each successful chunk
 * @param validLines   added line numbers per file, across all chunks (a split file's parts are combined)
 */
export function mergeComments(
  commentLists: ReviewComment[][],
  validLines: Map<string, Set<number>>,
  maxComments = DEFAULT_MAX_COMMENTS,
): MergeResult {
  const all = commentLists.flat();
  const onValidLines = all.filter((c) => validLines.get(c.file)?.has(c.line) ?? false);

  // Stable sort: equal severities keep file/line order.
  const sorted = [...onValidLines].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line,
  );

  const unique: ReviewComment[] = [];
  for (const comment of sorted) {
    const duplicate = unique.some(
      (kept) =>
        kept.file === comment.file &&
        kept.category === comment.category &&
        Math.abs(kept.line - comment.line) <= DUPLICATE_LINE_DISTANCE,
    );
    if (!duplicate) unique.push(comment);
  }

  const comments = unique.slice(0, maxComments);
  return {
    comments,
    stats: {
      fromModel: all.length,
      droppedInvalidLine: all.length - onValidLines.length,
      droppedDuplicate: sorted.length - unique.length,
      droppedOverLimit: unique.length - comments.length,
    },
  };
}
