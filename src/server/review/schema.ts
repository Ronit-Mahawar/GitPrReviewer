/**
 * Shapes of the data going into and out of the reviewer.
 * The Zod schemas validate what the model returns; the TypeScript types are derived from them.
 */
import { z } from "zod";

export const ReviewCommentSchema = z.object({
  file: z.string(),
  line: z.number(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.enum(["bug", "security", "performance", "style", "suggestion"]),
  message: z.string(),
  suggestion: z.string().optional(),
});

export const ReviewResultSchema = z.object({
  summary: z.string(),
  riskScore: z.number().min(0).max(100),
  comments: z.array(ReviewCommentSchema),
});

export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/** One changed file, in the shape GitHub's "list pull request files" API returns. */
export interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}
