/**
 * Repo context for one chunk (D8): code from the rest of the repository that helps judge the change,
 * shown to the model as "reference only". In priority order, cut from the bottom when over budget:
 *
 *   1. the full changed file after the PR (if under 400 lines; otherwise the changed declarations ±20 lines)
 *   2. exported signatures of files it imports with a relative path (one level deep, no bodies)
 *   3. call sites of exported symbols the diff changed (at most 5, with 3 lines either side)
 *
 * Best-effort: anything that fails is skipped and counted, never thrown, so context can't fail a review.
 */
import { posix } from "node:path";
import type { FileChange } from "./schema";
import { exportedDeclarations, extractSignatures, isTsLike, relativeImports } from "./signatures";
import { estimateTokens } from "./tokens";

export const DEFAULT_CONTEXT_TOKEN_BUDGET = 4000;
export const FULL_FILE_MAX_LINES = 400;
export const EXCERPT_PADDING_LINES = 20;
export const MAX_CALL_SITES = 5;

export interface CallSite {
  file: string;
  line: number;
  /** The call line plus up to 3 lines on each side. */
  snippet: string;
  /** Line number of the snippet's first line. */
  snippetStartLine: number;
}

/** Where context comes from: GitHub at the PR's head commit in production, the fixture repo in evals. */
export interface ContextProvider {
  getFile(path: string, ref: string): Promise<string | null>;
  findCallers(symbol: string, ref: string): Promise<CallSite[]>;
  /** Optional cached shortcut for extractSignatures(getFile(path)); the GitHub provider caches it by blob SHA. */
  getSignatures?(path: string, ref: string): Promise<string | null>;
}

export interface ContextBlock {
  priority: 1 | 2 | 3;
  title: string;
  /** Fence language for the body: "text" for numbered code, "ts" for signatures. */
  language: "text" | "ts";
  body: string;
}

export interface ChunkContext {
  /** The rendered "REFERENCE ONLY" section, or "" if there's no context. */
  text: string;
  tokens: number;
  included: Array<Pick<ContextBlock, "priority" | "title">>;
  dropped: Array<Pick<ContextBlock, "priority" | "title">>;
  errors: string[];
}

/** New-file lines a patch touches: added lines, plus the line where a deletion happened. */
export function changedLines(patch: string): number[] {
  const lines = new Set<number>();
  let newLine = 0;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) newLine = Number(hunk[1]);
    else if (text.startsWith("+")) lines.add(newLine++);
    else if (text.startsWith("-")) lines.add(Math.max(newLine, 1));
    else if (text.startsWith(" ")) newLine++;
  }
  return [...lines].sort((a, b) => a - b);
}

/** "  45 | code" for each line, numbers starting at `firstLine`, padded to the same width. */
export function numberLines(lines: string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines.map((text, i) => `${String(firstLine + i).padStart(width)} | ${text}`).join("\n");
}

/** Merges overlapping or touching [start, end] ranges (1-based, inclusive). */
export function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** The whole file if it's short; otherwise the declarations containing changed lines, ±20 lines, with "…" gaps. */
export function fileContextBody(source: string, path: string, changed: number[]): { body: string; excerpt: boolean } {
  const lines = source.replace(/\n$/, "").split("\n");
  if (lines.length < FULL_FILE_MAX_LINES) return { body: numberLines(lines, 1), excerpt: false };

  const declarations = isTsLike(path) ? exportedDeclarationsSafe(source, path) : [];
  const ranges = changed.map((line): [number, number] => {
    const decl = declarations.find((d) => d.startLine <= line && line <= d.endLine);
    const [start, end] = decl ? [decl.startLine, decl.endLine] : [line, line];
    return [Math.max(1, start - EXCERPT_PADDING_LINES), Math.min(lines.length, end + EXCERPT_PADDING_LINES)];
  });
  const parts = mergeRanges(ranges).map(([start, end]) => numberLines(lines.slice(start - 1, end), start));
  return { body: parts.join("\n…\n"), excerpt: true };
}

function exportedDeclarationsSafe(source: string, path: string) {
  try {
    return exportedDeclarations(source, path);
  } catch {
    return [];
  }
}

/** Candidate paths for a relative import, e.g. "./db" from "src/users.ts" → src/db.ts, src/db.tsx, src/db/index.ts, … */
export function importCandidates(fromFile: string, specifier: string): string[] {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  if (/\.(ts|tsx|mts|cts)$/.test(base)) return [base];
  const withoutJs = base.replace(/\.(js|jsx|mjs|cjs)$/, ""); // "./db.js" in TS source means db.ts
  return [
    ...(withoutJs !== base ? [`${withoutJs}.ts`, `${withoutJs}.tsx`, base] : []),
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`,
  ];
}

export interface BuildContextInput {
  /** The changed files in this chunk (with their patches). */
  files: FileChange[];
  provider: ContextProvider;
  ref: string;
  budget?: number;
}

export async function buildChunkContext(input: BuildContextInput): Promise<ChunkContext> {
  const { provider, ref } = input;
  const budget = input.budget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
  const errors: string[] = [];
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (error) {
      errors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const changedPaths = new Set(input.files.map((f) => f.filename));
  const blocks: ContextBlock[] = [];
  const contents = new Map<string, string>();

  // 1. Full changed files.
  for (const file of input.files) {
    const source = await attempt(`read ${file.filename}`, () => provider.getFile(file.filename, ref));
    if (source === null || source === undefined) continue;
    contents.set(file.filename, source);
    const { body, excerpt } = fileContextBody(source, file.filename, changedLines(file.patch ?? ""));
    blocks.push({ priority: 1, language: "text", title: `${excerpt ? "CHANGED PARTS" : "FULL FILE"} (after this PR): ${file.filename}`, body });
  }

  // 2. Signatures of relatively imported files, once each, skipping files already in this chunk.
  const seenImports = new Set<string>();
  for (const [path, source] of contents) {
    if (!isTsLike(path)) continue;
    const specifiers = (await attempt(`parse imports of ${path}`, async () => relativeImports(source, path))) ?? [];
    for (const specifier of specifiers) {
      for (const candidate of importCandidates(path, specifier)) {
        if (seenImports.has(candidate) || changedPaths.has(candidate)) break;
        const signatures = await attempt(`signatures of ${candidate}`, async () => {
          if (provider.getSignatures) return provider.getSignatures(candidate, ref);
          const imported = await provider.getFile(candidate, ref);
          return imported === null ? null : extractSignatures(imported, candidate);
        });
        if (signatures === null || signatures === undefined) continue; // try the next candidate path
        seenImports.add(candidate);
        if (signatures.trim()) blocks.push({ priority: 2, language: "ts", title: `SIGNATURES: ${candidate} (imported by ${path})`, body: signatures });
        break;
      }
    }
  }

  // 3. Call sites of exported symbols whose declaration the diff touched.
  let callSites = 0;
  for (const file of input.files) {
    const source = contents.get(file.filename);
    if (!source || !isTsLike(file.filename) || callSites >= MAX_CALL_SITES) continue;
    const changed = changedLines(file.patch ?? "");
    const touched = exportedDeclarationsSafe(source, file.filename).filter((d) => changed.some((l) => d.startLine <= l && l <= d.endLine));
    for (const decl of touched) {
      if (callSites >= MAX_CALL_SITES) break;
      const sites = ((await attempt(`callers of ${decl.name}`, () => provider.findCallers(decl.name, ref))) ?? [])
        .filter((s) => s.file !== file.filename)
        .slice(0, MAX_CALL_SITES - callSites);
      if (sites.length === 0) continue;
      callSites += sites.length;
      const body = sites.map((s) => `${s.file}:${s.line}\n${numberLines(s.snippet.split("\n"), s.snippetStartLine)}`).join("\n\n");
      blocks.push({ priority: 3, language: "text", title: `CALL SITES of ${decl.name} (changed in ${file.filename})`, body });
    }
  }

  return renderWithinBudget(blocks, budget, errors);
}

function renderBlock(block: ContextBlock): string {
  return `### ${block.title}\n\`\`\`${block.language}\n${block.body}\n\`\`\``;
}

export const REFERENCE_HEADER =
  "## REFERENCE ONLY (do not comment on anything in this section; it is other code from the repository, to help you judge the change)";

/** Adds blocks in priority order while they fit; a block that doesn't fit is dropped (D8: cut from the bottom). */
export function renderWithinBudget(blocks: ContextBlock[], budget: number, errors: string[] = []): ChunkContext {
  const ordered = [...blocks].sort((a, b) => a.priority - b.priority); // stable: keeps file order within a priority
  const included: ContextBlock[] = [];
  const dropped: ContextBlock[] = [];
  let tokens = estimateTokens(REFERENCE_HEADER);
  for (const block of ordered) {
    const cost = estimateTokens(renderBlock(block)) + 1;
    if (tokens + cost <= budget) {
      included.push(block);
      tokens += cost;
    } else dropped.push(block);
  }
  const strip = (b: ContextBlock) => ({ priority: b.priority, title: b.title });
  if (included.length === 0) return { text: "", tokens: 0, included: [], dropped: dropped.map(strip), errors };
  return {
    text: [REFERENCE_HEADER, ...included.map(renderBlock)].join("\n\n"),
    tokens,
    included: included.map(strip),
    dropped: dropped.map(strip),
    errors,
  };
}
