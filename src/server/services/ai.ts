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

interface FileChange {
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

export async function reviewCode(
  prTitle: string,
  files: FileChange[],
): Promise<ReviewResult> {
  const diffContent = files
    .filter((f) => f.patch)
    .map(
      (f) => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``,
    )
    .join("\n\n");

  if (!diffContent.trim()) {
    return {
      summary: "No code changes to review (binary files or empty diff).",
      riskScore: 0,
      comments: [],
    };
  }

  const userPrompt = `Review this pull request:

**Title:** ${prTitle}

**Changes:**
${diffContent}`;

  const openai = getOpenAIClient();
  


  const response = await openai.chat.completions.create({
    model: "gemini-3.1-flash-lite",
    messages: [
      
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
    max_tokens: 3000,
  });
//   try {
//   const response = await openai.chat.completions.create({
//     model: "gemini-3.1-flash-lite",
//     // messages: [
//     //   {
//     //     role: "system",
//     //     content: SYSTEM_PROMPT,
//     //   },
//     //   {
//     //     role: "user",
//     //     content: userPrompt,
//     //   },
//     // ],
//     messages: [
//   {
//     role: "system",
//     content: "You are an expert code reviewer.",
//   },
//   {
//     role: "user",
//     content: "Review this code: const x = 10;",
//   },
// ],

//     // response_format: { type: "json_object" },
//     // temperature: 0.3,
//     // max_tokens: 2000,
//   });

//   console.log(response);
// } catch (error: any) {
//   console.log("STATUS:", error.status);
//   console.log("MESSAGE:", error.message);
//   console.log("ERROR:", error.error);
//   console.log("BODY:", error.body);
//   console.log("HEADERS:", error.headers);

//   throw error;
// }
// const response = await openai.chat.completions.create({
//   model: "gemini-3.7-flash",
//   messages: [
//     {
//       role: "user",
//       content: "Say hello",
//     },
//   ],
// });

// console.log("Gemini response:", response.choices[0]?.message?.content);

// return {
//   summary: "Test successful",
//   riskScore: 0,
//   comments: [],
// };

  
  const content = response.choices[0]?.message?.content;
  console.log("RAW GEMINI RESPONSE:");
  console.log(content);
  if (!content) {
    throw new Error("No response from AI");
  }
  console.log("Finish reason:", response.choices[0]?.finish_reason);

  const parsed = JSON.parse(content);
  const validated = ReviewResultSchema.parse(parsed);

  return validated;
//   const content = response.choices[0]?.message?.content;

// if (!content) {
//   throw new Error("No response from AI");
// }

// console.log("Raw Gemini response:", content);

// let parsed: unknown;

// try {
//   parsed = JSON.parse(content);
// } catch (error) {
//   console.error("Gemini returned invalid JSON:", content);
//   throw new Error("Gemini returned invalid JSON");
// }

// const validated = ReviewResultSchema.parse(parsed);

// return validated;
// 
}
