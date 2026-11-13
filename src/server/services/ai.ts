import OpenAI from "openai";
import { z } from "zod";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not set");
}

if (!openaiClient) {
  openaiClient = new OpenAI({
    apiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  });
}

  return openaiClient;
}

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

export interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const SYSTEM_PROMPT = `You are an expert code reviewer. Analyze the provided pull request diff and provide a structured review.

Your review should:
1. Identify bugs, security issues, performance problems, and code style issues
2. Provide a brief summary of the changes
3. Assign a risk score (0-100) based on the complexity and potential issues
4. Give specific, actionable feedback with line numbers

Respond with valid JSON matching this schema:
{
  "summary": "Brief summary of changes and overall assessment",
  "riskScore": 0-100,
  "comments": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "critical" | "high" | "medium" | "low",
      "category": "bug" | "security" | "performance" | "style" | "suggestion",
      "message": "What the issue is",
      "suggestion": "How to fix it (optional)"
    }
  ]
}

Severity guide:
- critical: Security vulnerabilities, data loss, crashes
- high: Bugs that will cause issues in production
- medium: Should be fixed but won't break things
- low: Style issues, minor improvements

Rules:
- Return ONLY valid JSON.
- Do not use markdown code fences.
- Do not include any text before or after the JSON.
- Keep the summary concise.
- Keep each comment concise.
- Return at most 5 comments.
- Keep each message concise, preferably under 50 words.
- Keep each suggestion concise, preferably under 50 words.
- Reference exact line numbers from the diff.

Be concise but specific. Reference exact line numbers from the diff.`;

export interface ReviewOptions {
  model?: string;
  promptVariant?: "default" | "zero_shot";
  context?: "diff" | "diff+file";
  fileContents?: Record<string, string>;
  seed?: number;
}

export interface ReviewUsage { prompt_tokens: number | null; completion_tokens: number | null; }
export async function reviewDiffWithUsage(
  prTitle: string,
  diff: string,
  options: ReviewOptions = {},
): Promise<{ result: ReviewResult; usage: ReviewUsage; raw_output: string | null; finish_reason?: string | null }> {
  if (!diff.trim()) {
    return { result: { summary: "No code changes to review (binary files or empty diff).", riskScore: 0, comments: [] }, usage: { prompt_tokens: 0, completion_tokens: 0 }, raw_output: null };
  }

  const contextText = options.context === "diff+file" && options.fileContents
    ? `\n\nFile contents:\n${Object.entries(options.fileContents).map(([file, content]) => `### ${file}\n\`\`\`\n${content}\n\`\`\``).join("\n\n")}`
    : "";
  const userPrompt = `Review this pull request:\n\n**Title:** ${prTitle}\n\n**Changes:**\n${diff}${contextText}`;
  const systemPrompt = options.promptVariant === "zero_shot"
    ? "You are a code reviewer. Identify actionable bugs in this diff. Return JSON with summary, riskScore, and comments."
    : SYSTEM_PROMPT;
  const response = await getOpenAIClient().chat.completions.create({
    model: options.model ?? "gemini-3.1-flash-lite",
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
    response_format: { type: "json_object" },
    temperature: 0.3,
    max_tokens: 3000,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("No response from AI");
  let parsed: unknown;
  const usage = { prompt_tokens: response.usage?.prompt_tokens ?? null, completion_tokens: response.usage?.completion_tokens ?? null };
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    console.error("AI review returned invalid JSON; raw output follows:", content, error);
    throw new ReviewOutputValidationError(content, usage, error);
  }
  const validation = ReviewResultSchema.safeParse(parsed);
  if (!validation.success) {
    console.error("AI review failed Zod validation; raw output follows:", content, validation.error.flatten());
    throw new ReviewOutputValidationError(content, usage, validation.error);
  }
  return { result: validation.data, usage, raw_output: content, finish_reason: response.choices[0]?.finish_reason };
}

export class ReviewOutputValidationError extends Error {
  constructor(public readonly rawOutput: string, public readonly usage: ReviewUsage, cause: unknown) {
    super("AI review output failed Zod validation", { cause });
    this.name = "ReviewOutputValidationError";
  }
}

/** Runs the actual review model on text only; it has no GitHub, auth, or database dependencies. */
export async function reviewDiff(prTitle: string, diff: string, options: ReviewOptions = {}): Promise<ReviewResult> {
  return (await reviewDiffWithUsage(prTitle, diff, options)).result;
}

export async function reviewCode(
  prTitle: string,
  files: FileChange[],
): Promise<{ result: ReviewResult; usage: ReviewUsage; zodValid: boolean }> {
  const diffContent = files
    .filter((f) => f.patch)
    .map(
      (f) => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``,
    )
    .join("\n\n");

  if (!diffContent.trim()) {
    return { result: {
      summary: "No code changes to review (binary files or empty diff).",
      riskScore: 0,
      comments: [],
    }, usage: { prompt_tokens: 0, completion_tokens: 0 }, zodValid: true };
  }

  const review = await reviewDiffWithUsage(prTitle, diffContent);
  console.log("RAW GEMINI RESPONSE:");
  console.log(review.raw_output);
  console.log("Finish reason:", review.finish_reason);
  return { result: review.result, usage: review.usage, zodValid: true };
}
