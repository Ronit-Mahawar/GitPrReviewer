import type { BugType, GroundTruth, PredictedComment } from "./types";

export type Label = "TP" | "FP" | "unmatched";
const COMPATIBLE: Record<string, BugType[]> = {
  bug: ["null_deref", "off_by_one", "missing_error_handling", "race_condition", "logic_error", "resource_leak", "other"],
  security: ["sql_injection", "xss", "hardcoded_secret"],
  performance: ["resource_leak", "race_condition"], style: ["style"], suggestion: ["other", "style"],
};
export function isCompatible(predicted: PredictedComment, truth: GroundTruth): boolean {
  if (truth.bug_type === null) return true;
  let predictedType = predicted.bug_type;
  if (!predictedType) {
    const text = `${predicted.message} ${predicted.suggestion ?? ""}`.toLowerCase();
    const hints: Array<[RegExp, BugType]> = [[/sql injection|parameterized query/,"sql_injection"],[/xss|cross.site|innerhtml|unsanitized html/,"xss"],[/hardcoded secret|api key|credential|secret/,"hardcoded_secret"],[/off.by.one|boundary|index|skips? an item/,"off_by_one"],[/null|undefined|dereferenc/,"null_deref"],[/error handling|response status|http status/,"missing_error_handling"],[/race condition|concurren/,"race_condition"],[/resource leak|close|dispose|cleanup/,"resource_leak"],[/style|format|naming/,"style"]];
    predictedType = hints.find(([pattern]) => pattern.test(text))?.[1];
  }
  if (predictedType === "other") return true;
  if (predictedType) return predictedType === truth.bug_type;
  if (predicted.bug_type === truth.bug_type) return true;
  return (COMPATIBLE[predicted.category ?? ""] ?? []).includes(truth.bug_type);
}
export function matchComments(comments: PredictedComment[], truth: GroundTruth[], tolerance = 3) {
  const claimed = new Set<number>();
  const labels = comments.map((comment) => {
    const match = truth.findIndex((bug, index) => !claimed.has(index) && bug.file === comment.file &&
      comment.line >= bug.line_start - tolerance && comment.line <= bug.line_end + tolerance && isCompatible(comment, bug));
    if (match >= 0) { claimed.add(match); return { auto_label: "TP" as Label, matched_truth: match }; }
    return { auto_label: truth.length === 0 ? "FP" as Label : "unmatched" as Label, matched_truth: null };
  });
  return { labels, missed_truth: truth.map((_, i) => i).filter((i) => !claimed.has(i)) };
}
