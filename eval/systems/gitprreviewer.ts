import { reviewDiffWithUsage } from "../../src/server/services/ai";
import { reconstructFiles } from "../diff";
import type { DatasetCase, PredictedComment } from "../types";
export async function run(input: { testCase: DatasetCase; model: string; promptVariant: string; context: string; seed?: number }) {
  // The app historically reads GEMINI_API_KEY; the eval CLI accepts either key name.
  if (!process.env.GEMINI_API_KEY && process.env.OPENAI_API_KEY) process.env.GEMINI_API_KEY = process.env.OPENAI_API_KEY;
  const {result, usage, raw_output} = await reviewDiffWithUsage(input.testCase.title, input.testCase.diff, {
    model: input.model, promptVariant: input.promptVariant === "zero_shot" ? "zero_shot" : "default",
    context: input.context === "diff+file" ? "diff+file" : "diff", fileContents: input.testCase.files ?? reconstructFiles(input.testCase.diff), seed: input.seed,
  });
  const comments: PredictedComment[] = result.comments.map((c) => ({ file: c.file, line: c.line, severity: c.severity, category: c.category, message: c.message, suggestion: c.suggestion }));
  return { raw_output, comments, summary: result.summary, riskScore: result.riskScore, ...usage };
}
