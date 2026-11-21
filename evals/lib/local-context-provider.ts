/**
 * ContextProvider that reads the eval fixture repo from disk (production uses GitHub, Phase 4).
 * Files are the base version (before the PR); `ref` is ignored because the fixture has one version.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ContextProvider } from "../../src/server/review/review-pull-request";

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createLocalContextProvider(root: string): ContextProvider {
  const rootDir = resolve(root);

  return {
    async getFile(path) {
      const full = resolve(rootDir, path);
      if (full !== rootDir && !full.startsWith(rootDir + sep)) return null; // no "../" escapes
      try {
        return readFileSync(full, "utf8");
      } catch {
        return null;
      }
    },

    /** Lines in .ts/.tsx files that mention `symbol` as a whole word, excluding its own declaration. */
    async findCallers(symbol) {
      const word = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
      const declaration = new RegExp(`\\b(function|const|let|class|interface|type)\\s+${escapeRegExp(symbol)}\\b`);
      const results: Array<{ file: string; line: number; snippet: string }> = [];

      for (const full of listFiles(rootDir).filter((f) => /\.tsx?$/.test(f)).sort()) {
        const lines = readFileSync(full, "utf8").split("\n");
        lines.forEach((text, i) => {
          if (!word.test(text) || declaration.test(text) || /^\s*import\b/.test(text)) return;
          const snippet = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
          results.push({ file: relative(rootDir, full).split(sep).join("/"), line: i + 1, snippet });
        });
      }
      return results;
    },
  };
}
