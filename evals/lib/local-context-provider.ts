/**
 * ContextProvider for evals: the fixture repo on disk, with the case's changed files laid on top,
 * so it shows the repository *after* the PR (like GitHub at the head commit). `ref` is ignored.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { CallSite, ContextProvider } from "../../src/server/review/context";

/** Lines of context shown on each side of a call site. */
export const CALL_SITE_PADDING = 3;

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param root      the fixture repo
 * @param overrides file contents after the PR, by repo path; null means the PR deleted the file
 */
export function createLocalContextProvider(root: string, overrides: Record<string, string | null> = {}): ContextProvider {
  const rootDir = resolve(root);
  const toRepoPath = (full: string) => relative(rootDir, full).split(sep).join("/");

  function read(path: string): string | null {
    if (path in overrides) return overrides[path] ?? null;
    const full = resolve(rootDir, path);
    if (full !== rootDir && !full.startsWith(rootDir + sep)) return null; // no "../" escapes
    try {
      return readFileSync(full, "utf8");
    } catch {
      return null;
    }
  }

  function allPaths(): string[] {
    const paths = new Set(listFiles(rootDir).map(toRepoPath));
    for (const [path, content] of Object.entries(overrides)) {
      if (content === null) paths.delete(path);
      else paths.add(path);
    }
    return [...paths].sort();
  }

  return {
    async getFile(path) {
      return read(path);
    },

    /** Lines in .ts/.tsx files that mention `symbol` as a whole word, excluding imports and its own declaration. */
    async findCallers(symbol) {
      const word = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
      const declaration = new RegExp(`\\b(function|const|let|class|interface|type)\\s+${escapeRegExp(symbol)}\\b`);
      const results: CallSite[] = [];
      for (const path of allPaths().filter((p) => /\.tsx?$/.test(p))) {
        const lines = (read(path) ?? "").replace(/\n$/, "").split("\n"); // no empty "line" after the final newline
        lines.forEach((text, i) => {
          if (!word.test(text) || declaration.test(text) || /^\s*import\b/.test(text)) return;
          const start = Math.max(0, i - CALL_SITE_PADDING);
          results.push({ file: path, line: i + 1, snippet: lines.slice(start, i + CALL_SITE_PADDING + 1).join("\n"), snippetStartLine: start + 1 });
        });
      }
      return results;
    },
  };
}
