import OpenAI from "openai";
import { reconstructFiles } from "../diff";
import type { DatasetCase, PredictedComment } from "../types";
export async function run(input: { testCase: DatasetCase; model: string; context: string; seed?: number }) {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Set OPENAI_API_KEY (or GEMINI_API_KEY for the configured Gemini endpoint)");
  const client = new OpenAI({ apiKey, baseURL: process.env.EVAL_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/" });
  const fileContents = input.testCase.files ?? reconstructFiles(input.testCase.diff);
  const files = input.context === "diff+file"
    ? `\n\nFile contents:\n${Object.entries(fileContents).map(([name, content]) => `### ${name}\n${content}`).join("\n\n")}`
    : "";
  const prompt = `${input.testCase.title}\n\n${input.testCase.description}\n\n${input.testCase.diff}${files}`;
  const res = await client.chat.completions.create({ model: input.model, messages: [{ role: "user", content: prompt }], ...(input.seed === undefined ? {} : { seed: input.seed }) });
  const raw = res.choices[0]?.message?.content ?? "";
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const rawComments = Array.isArray(parsed) ? parsed : parsed?.comments ?? [];
  const comments: PredictedComment[] = rawComments.filter((c: any) => c && c.file && Number.isFinite(Number(c.line))).map((c: any) => ({ file: String(c.file), line: Number(c.line), severity: c.severity, category: c.category, message: String(c.message ?? c.description ?? ""), suggestion: c.suggestion }));
  return { raw_output: raw, comments, summary: parsed?.summary, riskScore: parsed?.riskScore, prompt_tokens: res.usage?.prompt_tokens ?? null, completion_tokens: res.usage?.completion_tokens ?? null };
}
