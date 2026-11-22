import { describe, expect, it, vi } from "vitest";
import { createGitHubContextProvider, findUsages, MAX_CONTEXT_FILE_BYTES, type ContextCache, type FetchJson } from "./github-context-provider";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const users = 'export async function findUser(id: string) {\n  return id;\n}\n';
const route = 'import { findUser } from "../users";\n\nexport async function handler() {\n  const u = await findUser("1");\n  return u;\n}\n';

function fakeGitHub() {
  const calls: string[] = [];
  const fetchJson: FetchJson = vi.fn(async (path: string) => {
    calls.push(path);
    if (path.startsWith("/repos/o/r/git/trees/")) {
      return {
        tree: [
          { path: "src/users.ts", type: "blob", sha: "sha-users", size: users.length },
          { path: "src/routes/get.ts", type: "blob", sha: "sha-route", size: route.length },
          { path: "src", type: "tree", sha: "sha-dir" },
          { path: "big.json", type: "blob", sha: "sha-big", size: MAX_CONTEXT_FILE_BYTES + 1 },
        ],
      };
    }
    if (path === "/repos/o/r/git/blobs/sha-users") return { content: b64(users), encoding: "base64", size: users.length };
    if (path === "/repos/o/r/git/blobs/sha-route") return { content: b64(route), encoding: "base64", size: route.length };
    if (path.startsWith("/search/code")) return { items: [{ path: "src/routes/get.ts", sha: "sha-route" }] };
    throw new Error(`unexpected ${path}`);
  });
  return { fetchJson, calls };
}

function memoryCache(): ContextCache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (repo, sha, kind) => store.get(`${repo}|${sha}|${kind}`) ?? null,
    set: async (repo, sha, kind, content) => {
      store.set(`${repo}|${sha}|${kind}`, content);
    },
  };
}

describe("createGitHubContextProvider", () => {
  it("reads files at the given commit through the tree and blob APIs", async () => {
    const gh = fakeGitHub();
    const provider = createGitHubContextProvider({ owner: "o", repo: "r", fetchJson: gh.fetchJson });
    expect(await provider.getFile("src/users.ts", "abc123")).toBe(users);
    expect(await provider.getFile("src/missing.ts", "abc123")).toBeNull();
    expect(await provider.getFile("big.json", "abc123")).toBeNull(); // too big to use as context
    expect(gh.calls.filter((c) => c.includes("/git/trees/"))).toEqual(["/repos/o/r/git/trees/abc123?recursive=1"]); // tree fetched once
  });

  it("caches file contents and signatures by blob SHA, so a second review downloads nothing", async () => {
    const cache = memoryCache();
    const first = fakeGitHub();
    const p1 = createGitHubContextProvider({ owner: "o", repo: "r", fetchJson: first.fetchJson, cache });
    expect(await p1.getSignatures!("src/users.ts", "abc123")).toBe("export async function findUser(id: string);");
    expect([...cache.store.keys()].sort()).toEqual(["o/r|sha-users|file", "o/r|sha-users|signatures"]);

    const second = fakeGitHub();
    const p2 = createGitHubContextProvider({ owner: "o", repo: "r", fetchJson: second.fetchJson, cache });
    await p2.getFile("src/users.ts", "def456");
    await p2.getSignatures!("src/users.ts", "def456");
    expect(second.calls.filter((c) => c.includes("/git/blobs/"))).toEqual([]); // only the tree call
  });

  it("finds call sites through code search, scoped to the repo", async () => {
    const gh = fakeGitHub();
    const provider = createGitHubContextProvider({ owner: "o", repo: "r", fetchJson: gh.fetchJson });
    const sites = await provider.findCallers("findUser", "abc123");
    expect(gh.calls.find((c) => c.startsWith("/search/code"))).toBe(`/search/code?q=${encodeURIComponent("findUser repo:o/r")}&per_page=10`);
    expect(sites).toEqual([{ file: "src/routes/get.ts", line: 4, snippetStartLine: 1, snippet: route.replace(/\n$/, "").split("\n").slice(0, 7).join("\n") }]);
  });

  it("passes GitHub errors up (the context builder records and skips them)", async () => {
    const provider = createGitHubContextProvider({ owner: "o", repo: "r", fetchJson: async () => { throw new Error("GitHub 403 for /search/code"); } });
    await expect(provider.findCallers("x", "abc")).rejects.toThrow("GitHub 403");
  });
});

describe("findUsages", () => {
  it("skips imports and declarations and handles the first lines of a file", () => {
    expect(findUsages(route, "r.ts", "findUser").map((s) => [s.line, s.snippetStartLine])).toEqual([[4, 1]]);
    expect(findUsages(users, "u.ts", "findUser")).toEqual([]);
  });
});
