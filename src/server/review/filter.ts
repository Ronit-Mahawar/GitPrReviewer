/**
 * Decides which changed files are worth sending to the model.
 * Every skipped file gets a reason, so the review can say what it didn't look at (CLAUDE.md rule 5).
 */
import type { FileChange } from "./schema";

export interface SkippedFile {
  file: string;
  reason: string;
  /** Extra information, e.g. which hunk was too large. */
  detail?: string;
}

export interface FilterResult {
  kept: FileChange[];
  skipped: SkippedFile[];
}

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "go.sum",
]);

/** Any path segment with one of these names means build output or third-party code. */
const SKIPPED_DIRECTORIES = new Set(["dist", "build", ".next", "node_modules", "vendor"]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif", "tif", "tiff"]);
const FONT_EXTENSIONS = new Set(["woff", "woff2", "ttf", "otf", "eot"]);

/** How many lines from the top of a file to search for an "@generated" marker. */
const GENERATED_HEADER_LINES = 5;

function extension(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The reason to skip a file based on its path alone, or null to keep it. */
export function pathSkipReason(path: string): string | null {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (LOCKFILES.has(name)) return "lockfile";
  const dir = segments.slice(0, -1).find((s) => SKIPPED_DIRECTORIES.has(s));
  if (dir) return `in ${dir}/`;
  if (/\.min\.(js|mjs|cjs|css)$/i.test(name)) return "minified";
  if (/\.map$/i.test(name)) return "source map";
  if (IMAGE_EXTENSIONS.has(extension(name))) return "image";
  if (FONT_EXTENSIONS.has(extension(name))) return "font";
  return null;
}

/**
 * True if the first lines of the file contain "@generated".
 * We only have the patch, so this works when the patch starts at line 1 (new files, or edits near the top);
 * a generated file edited only further down isn't detected.
 */
export function hasGeneratedHeader(patch: string): boolean {
  const lines = patch.split("\n");
  const first = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[0] ?? "");
  if (!first || Number(first[1]) > 1) return false;
  return lines
    .slice(1)
    .filter((l) => l.startsWith("+") || l.startsWith(" "))
    .slice(0, GENERATED_HEADER_LINES)
    .some((l) => l.includes("@generated"));
}

export function filterFiles(files: FileChange[]): FilterResult {
  const kept: FileChange[] = [];
  const skipped: SkippedFile[] = [];

  for (const file of files) {
    let reason: string | null = null;
    if (file.status === "removed") reason = "removed file";
    else if (!file.patch) reason = "no patch (binary, too large for GitHub, or rename only)";
    else reason = pathSkipReason(file.filename) ?? (hasGeneratedHeader(file.patch) ? "generated (@generated header)" : null);

    if (reason) skipped.push({ file: file.filename, reason });
    else kept.push(file);
  }
  return { kept, skipped };
}
