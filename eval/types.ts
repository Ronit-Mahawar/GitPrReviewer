export const BUG_TYPES = ["null_deref", "off_by_one", "sql_injection", "xss", "hardcoded_secret", "missing_error_handling", "race_condition", "logic_error", "resource_leak", "style", "other"] as const;
export type BugType = typeof BUG_TYPES[number];
export type Severity = "critical" | "high" | "medium" | "low";
export interface GroundTruth { file: string; line_start: number; line_end: number; bug_type: BugType | null; severity: Severity; description: string; }
export interface DatasetCase { id: string; diff: string; title: string; description: string; is_clean: boolean; ground_truth: GroundTruth[]; files?: Record<string, string>; scenario?: string; }
export interface PredictedComment { file: string; line: number; severity?: string; category?: string; bug_type?: BugType | null; message: string; suggestion?: string; }
export interface EvaluationRow {
  system: string; case_id: string; run: number; raw_output: unknown; comments: PredictedComment[]; summary?: string; riskScore?: number;
  latency_ms: number; prompt_tokens: number | null; completion_tokens: number | null; estimated_cost: number | null;
  success: boolean; retries: number; retry_log: string[]; error?: string;
}
