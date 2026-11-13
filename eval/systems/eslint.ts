import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { DatasetCase, PredictedComment } from "../types";
import { reconstructFiles } from "../diff";
export async function run(input: { testCase: DatasetCase }) {
  const contentByFile = input.testCase.files ?? reconstructFiles(input.testCase.diff);
  const dir = await mkdtemp(path.join(tmpdir(), "gitpr-eval-eslint-"));
  const filePaths: string[] = [];
  try {
    for (const [name, content] of Object.entries(contentByFile)) { const out = path.join(dir, name); await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(out), { recursive: true })); await writeFile(out, content); filePaths.push(out); }
    if (!filePaths.length) return { raw_output: "No reconstructable source files", comments: [], prompt_tokens: null, completion_tokens: null };
    const eslint = path.resolve("node_modules/.bin/eslint");
    const output = await new Promise<string>((resolve) => { const p = spawn(eslint, ["--config", path.resolve("eslint.config.mjs"), "--format", "json", ...filePaths], { cwd: process.cwd() }); let data = ""; p.stdout.on("data", (d) => data += d); p.stderr.on("data", (d) => data += d); p.on("close", () => resolve(data)); });
    let comments: PredictedComment[] = [];
    try { const parsed = JSON.parse(output); comments = parsed.flatMap((f: any) => f.messages.map((m: any) => ({ file: path.relative(dir,f.filePath).split(path.sep).join("/"), line: m.line ?? 1, severity: m.severity === 2 ? "medium" : "low", category: m.ruleId ? "style" : "bug", message: m.message }))); } catch { /* Keep raw ESLint output for debugging. */ }
    return { raw_output: output, comments, prompt_tokens: null, completion_tokens: null };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
