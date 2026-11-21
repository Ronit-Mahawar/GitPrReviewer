/**
 * Packs the (already filtered) changed files into chunks that each fit a token budget (D3).
 *
 * - Small files share a chunk, in PR order (next-fit: when the next file doesn't fit, start a new chunk).
 * - A file too big for one chunk is split at hunk boundaries into parts ("part 1 of 3"),
 *   so a change is never cut in half.
 * - A single hunk bigger than the whole budget is skipped with reason "hunk too large".
 *
 * The budget covers the diff text only; the system prompt and repo context (Phase 4) are extra.
 */
import { annotatePatch } from "./annotate";
import type { SkippedFile } from "./filter";
import type { FileChange } from "./schema";
import { estimateTokens } from "./tokens";

export const DEFAULT_CHUNK_TOKEN_BUDGET = 7000;

export interface ChunkFile {
  filename: string;
  status: string;
  /** The Markdown section the model sees for this file (or file part). */
  text: string;
  /** Added lines in this section: the only lines a comment may point at. */
  validLines: number[];
  /** Set only when a big file was split: part 1 of 3, etc. */
  part?: { index: number; total: number };
}

export interface Chunk {
  index: number;
  files: ChunkFile[];
  /** estimateTokens() of the chunk's diff text. */
  tokens: number;
}

export interface ChunkResult {
  chunks: Chunk[];
  skipped: SkippedFile[];
}

export function renderFileSection(filename: string, status: string, body: string, part?: ChunkFile["part"]): string {
  const label = part ? `${status}, part ${part.index} of ${part.total}` : status;
  return `### ${filename} (${label})\n\`\`\`diff\n${body}\n\`\`\``;
}

/** The text of a chunk, as it will appear in the prompt. */
export function chunkText(files: Pick<ChunkFile, "text">[]): string {
  return files.map((f) => f.text).join("\n\n");
}

/** Splits one file into sections that each fit the budget. Hunks that can never fit are reported. */
function fileSections(file: FileChange, budget: number): { sections: ChunkFile[]; skipped: SkippedFile[] } {
  const annotated = annotatePatch(file.patch ?? "");
  if (annotated.hunks.length === 0) {
    return { sections: [], skipped: [{ file: file.filename, reason: "no hunks in patch" }] };
  }

  const whole = renderFileSection(file.filename, file.status, annotated.text);
  if (estimateTokens(whole) <= budget) {
    return { sections: [{ filename: file.filename, status: file.status, text: whole, validLines: [...annotated.validLines] }], skipped: [] };
  }

  // Too big: group consecutive hunks. Estimate with a worst-case part label so the real label always fits.
  const worstPart = { index: 999, total: 999 };
  const fits = (hunks: typeof annotated.hunks) =>
    estimateTokens(renderFileSection(file.filename, file.status, hunks.map((h) => h.text).join("\n"), worstPart)) <= budget;

  const skipped: SkippedFile[] = [];
  const groups: Array<typeof annotated.hunks> = [];
  let current: typeof annotated.hunks = [];
  for (const hunk of annotated.hunks) {
    if (!fits([hunk])) {
      skipped.push({ file: file.filename, reason: "hunk too large", detail: hunk.text.split("\n")[0] });
      continue;
    }
    if (current.length > 0 && !fits([...current, hunk])) {
      groups.push(current);
      current = [];
    }
    current.push(hunk);
  }
  if (current.length > 0) groups.push(current);

  const sections = groups.map((hunks, i) => {
    const part = groups.length > 1 ? { index: i + 1, total: groups.length } : undefined;
    return {
      filename: file.filename,
      status: file.status,
      text: renderFileSection(file.filename, file.status, hunks.map((h) => h.text).join("\n"), part),
      validLines: hunks.flatMap((h) => h.validLines),
      ...(part ? { part } : {}),
    };
  });
  return { sections, skipped };
}

export function chunkFiles(files: FileChange[], budget = DEFAULT_CHUNK_TOKEN_BUDGET): ChunkResult {
  if (!Number.isInteger(budget) || budget <= 0) throw new RangeError("chunk token budget must be a positive integer");

  const sections: ChunkFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const file of files) {
    const result = fileSections(file, budget);
    sections.push(...result.sections);
    skipped.push(...result.skipped);
  }

  // Next-fit packing: keep adding sections to the current chunk until the next one doesn't fit.
  const chunks: Chunk[] = [];
  let current: ChunkFile[] = [];
  const close = () => {
    if (current.length === 0) return;
    chunks.push({ index: chunks.length, files: current, tokens: estimateTokens(chunkText(current)) });
    current = [];
  };
  for (const section of sections) {
    if (current.length > 0 && estimateTokens(chunkText([...current, section])) > budget) close();
    current.push(section);
  }
  close();

  return { chunks, skipped };
}
