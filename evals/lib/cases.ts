/**
 * Loads eval cases from evals/cases/<id>/{case.json, pr.diff}.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { FileChange } from "../../src/server/review/schema";
import { parseUnifiedDiff } from "./diff";

export const CaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, "id must be lowercase letters, digits and dashes"),
    title: z.string().min(1),
    kind: z.enum(["bug", "clean", "context", "large"]),
    bug: z
      .object({
        file: z.string().min(1),
        line: z.number().int().positive(),
        category: z.string().min(1),
        description: z.string().min(10),
      })
      .optional(),
  })
  .refine((c) => (c.kind === "clean" ? !c.bug : true), { message: "a clean case must not have a bug" })
  .refine((c) => (c.kind === "bug" || c.kind === "context" ? !!c.bug : true), { message: "bug and context cases need a bug" });

export type EvalCase = z.infer<typeof CaseSchema> & { files: FileChange[] };

/** Validates one case and checks its bug points at an added line of its own diff. */
export function parseCase(dirName: string, caseJson: unknown, diff: string): EvalCase {
  const parsed = CaseSchema.safeParse(caseJson);
  if (!parsed.success) throw new Error(`${dirName}/case.json: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  if (parsed.data.id !== dirName) throw new Error(`${dirName}/case.json: id "${parsed.data.id}" must match the folder name`);

  const files = parseUnifiedDiff(diff);
  if (files.length === 0) throw new Error(`${dirName}/pr.diff: no files in diff`);

  const bug = parsed.data.bug;
  if (bug) {
    const file = files.find((f) => f.filename === bug.file);
    if (!file) throw new Error(`${dirName}: bug.file "${bug.file}" is not in pr.diff`);
    if (!addedLines(file.patch ?? "").has(bug.line)) {
      throw new Error(`${dirName}: bug.line ${bug.line} is not an added line in ${bug.file}`);
    }
  }
  return { ...parsed.data, files };
}

/** New-file line numbers of the "+" lines in a patch. */
export function addedLines(patch: string): Set<number> {
  const added = new Set<number>();
  let line = 0;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) line = Number(hunk[1]);
    else if (text.startsWith("+")) added.add(line++);
    else if (text.startsWith(" ")) line++;
  }
  return added;
}

export function loadCases(casesDir: string, only?: string[]): EvalCase[] {
  return readdirSync(casesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !only || only.some((prefix) => name.startsWith(prefix)))
    .sort()
    .map((name) => {
      const dir = join(casesDir, name);
      if (!existsSync(join(dir, "case.json")) || !existsSync(join(dir, "pr.diff"))) {
        throw new Error(`${name}: needs case.json and pr.diff`);
      }
      return parseCase(name, JSON.parse(readFileSync(join(dir, "case.json"), "utf8")), readFileSync(join(dir, "pr.diff"), "utf8"));
    });
}
