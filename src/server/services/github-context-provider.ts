/**
 * ContextProvider backed by GitHub (Phase 4, D8–D11).
 *
 * - The PR's head-commit tree is read once (`git/trees/<sha>?recursive=1`) to map every path to its blob SHA.
 * - File contents are fetched by blob SHA (`git/blobs/<sha>`) and cached by (repo, blobSha), so a file is
 *   downloaded once ever; on a `synchronize` push most files are unchanged and come from the cache.
 * - Signatures are extracted with the TypeScript compiler API and cached the same way.
 * - Call sites come from GitHub code search, which only searches the default branch (D10).
 *
 * `fetchJson` and `cache` are passed in so this can be tested without network or database.
 */
import { extractSignatures } from "@/server/review/signatures";
import type { CallSite, ContextProvider } from "@/server/review/context";

export interface ContextCache {
  get(repo: string, blobSha: string, kind: "file" | "signatures"): Promise<string | null>;
  set(repo: string, blobSha: string, kind: "file" | "signatures", content: string): Promise<void>;
}

export type FetchJson = (path: string, accept?: string) => Promise<unknown>;

/** Files bigger than this are not used as context (and GitHub's blob API is slow for them). */
export const MAX_CONTEXT_FILE_BYTES = 512 * 1024;
const CALL_SITE_PADDING = 3;

export function createGitHubFetchJson(token: string): FetchJson {
  return async (path, accept = "application/vnd.github+json") => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path.split("?")[0]}`);
    return res.json();
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lines in `source` that use `symbol` (not its import or declaration), each with 3 lines either side. */
export function findUsages(source: string, file: string, symbol: string): CallSite[] {
  const word = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  const declaration = new RegExp(`\\b(function|const|let|class|interface|type)\\s+${escapeRegExp(symbol)}\\b`);
  const lines = source.replace(/\n$/, "").split("\n");
  const sites: CallSite[] = [];
  lines.forEach((text, i) => {
    if (!word.test(text) || declaration.test(text) || /^\s*import\b/.test(text)) return;
    const start = Math.max(0, i - CALL_SITE_PADDING);
    sites.push({ file, line: i + 1, snippet: lines.slice(start, i + CALL_SITE_PADDING + 1).join("\n"), snippetStartLine: start + 1 });
  });
  return sites;
}

export function createGitHubContextProvider(opts: { owner: string; repo: string; fetchJson: FetchJson; cache?: ContextCache }): ContextProvider {
  const repoName = `${opts.owner}/${opts.repo}`;
  const base = `/repos/${opts.owner}/${opts.repo}`;
  const trees = new Map<string, Promise<Map<string, string>>>(); // ref → (path → blob SHA), per review

  function tree(ref: string): Promise<Map<string, string>> {
    let pending = trees.get(ref);
    if (!pending) {
      pending = (async () => {
        const body = (await opts.fetchJson(`${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`)) as {
          tree: Array<{ path: string; type: string; sha: string; size?: number }>;
        };
        return new Map(body.tree.filter((e) => e.type === "blob" && (e.size ?? 0) <= MAX_CONTEXT_FILE_BYTES).map((e) => [e.path, e.sha]));
      })();
      trees.set(ref, pending);
    }
    return pending;
  }

  async function blob(sha: string): Promise<string | null> {
    const cached = await opts.cache?.get(repoName, sha, "file");
    if (cached !== null && cached !== undefined) return cached;
    const body = (await opts.fetchJson(`${base}/git/blobs/${sha}`)) as { content: string; encoding: string; size: number };
    if (body.encoding !== "base64" || body.size > MAX_CONTEXT_FILE_BYTES) return null;
    const content = Buffer.from(body.content, "base64").toString("utf8");
    await opts.cache?.set(repoName, sha, "file", content);
    return content;
  }

  return {
    async getFile(path, ref) {
      const sha = (await tree(ref)).get(path);
      return sha ? blob(sha) : null;
    },

    async getSignatures(path, ref) {
      const sha = (await tree(ref)).get(path);
      if (!sha) return null;
      const cached = await opts.cache?.get(repoName, sha, "signatures");
      if (cached !== null && cached !== undefined) return cached;
      const source = await blob(sha);
      if (source === null) return null;
      const signatures = extractSignatures(source, path);
      await opts.cache?.set(repoName, sha, "signatures", signatures);
      return signatures;
    },

    /** Code search runs on the default branch, so callers added in the PR itself only appear in the diff (D10). */
    async findCallers(symbol) {
      const q = encodeURIComponent(`${symbol} repo:${repoName}`);
      const body = (await opts.fetchJson(`/search/code?q=${q}&per_page=10`)) as { items: Array<{ path: string; sha: string }> };
      const sites: CallSite[] = [];
      for (const item of body.items) {
        const source = await blob(item.sha);
        if (source !== null) sites.push(...findUsages(source, item.path, symbol));
      }
      return sites;
    },
  };
}
