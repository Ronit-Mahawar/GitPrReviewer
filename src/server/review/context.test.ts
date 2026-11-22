import { describe, expect, it, vi } from "vitest";
import {
  buildChunkContext,
  changedLines,
  fileContextBody,
  importCandidates,
  mergeRanges,
  numberLines,
  REFERENCE_HEADER,
  renderWithinBudget,
  type CallSite,
  type ContextProvider,
} from "./context";
import type { FileChange } from "./schema";

function fakeProvider(files: Record<string, string>, callers: Record<string, CallSite[]> = {}): ContextProvider & { getFile: ReturnType<typeof vi.fn> } {
  return {
    getFile: vi.fn(async (path: string) => files[path] ?? null),
    findCallers: vi.fn(async (symbol: string) => callers[symbol] ?? []),
  };
}
const change = (filename: string, patch: string): FileChange => ({ filename, status: "modified", additions: 1, deletions: 0, patch });

const users = `import { query } from "./db";

/** null until onboarding */
export async function getDisplayName(id: string): Promise<string | null> {
  const rows = await query("SELECT name FROM users WHERE id = $1", [id]);
  return rows[0]?.name ?? null;
}
`;
const db = `import { Pool } from "pg";
export const pool = new Pool();
export async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(text, params)).rows;
}
`;
const usersPatch = "@@ -4,3 +4,4 @@\n export async function getDisplayName(id: string): Promise<string | null> {\n   const rows = await query(\"SELECT name FROM users WHERE id = $1\", [id]);\n+  return rows[0]?.name ?? null;\n }";
const caller: CallSite = { file: "src/routes/profile.ts", line: 8, snippetStartLine: 5, snippet: "a\nb\nc\nconst name = await getDisplayName(id);\nd\ne\nf" };

describe("changedLines", () => {
  it("returns added lines and the positions of deletions in the new file", () => {
    expect(changedLines("@@ -10,4 +10,4 @@\n a\n-b\n+B\n c\n-d")).toEqual([11, 13]);
  });
  it("is empty for an empty patch", () => {
    expect(changedLines("")).toEqual([]);
  });
});

describe("numberLines / mergeRanges", () => {
  it("numbers lines with padding", () => {
    expect(numberLines(["a", "b"], 9)).toBe(" 9 | a\n10 | b");
  });
  it("merges overlapping and touching ranges", () => {
    expect(mergeRanges([[30, 40], [1, 5], [6, 8], [35, 50]])).toEqual([[1, 8], [30, 50]]);
  });
});

describe("fileContextBody", () => {
  it("returns the whole file, numbered, when it's under 400 lines", () => {
    expect(fileContextBody("a\nb\n", "x.ts", [2])).toEqual({ body: "1 | a\n2 | b", excerpt: false });
  });

  it("returns only the changed declarations ±20 lines for a long file", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `const filler${i} = ${i};`);
    lines[299] = "export function changed() {";
    lines[300] = "  return 1;";
    lines[301] = "}";
    const { body, excerpt } = fileContextBody(lines.join("\n"), "big.ts", [301]);
    expect(excerpt).toBe(true);
    const numbers = body.split("\n").map((l) => Number(l.split(" | ")[0]));
    expect(numbers[0]).toBe(280); // declaration starts at 300, minus 20
    expect(numbers[numbers.length - 1]).toBe(322); // declaration ends at 302, plus 20
  });

  it("joins separate changed regions with an ellipsis", () => {
    const lines = Array.from({ length: 450 }, (_, i) => `x${i}`);
    const { body } = fileContextBody(lines.join("\n"), "notes.txt", [10, 400]);
    expect(body.split("\n").filter((l) => l === "…")).toHaveLength(1);
  });
});

describe("importCandidates", () => {
  it("resolves relative paths and tries the usual extensions", () => {
    expect(importCandidates("src/routes/users.ts", "../db")).toEqual([
      "src/db.ts", "src/db.tsx", "src/db.js", "src/db/index.ts", "src/db/index.tsx", "src/db/index.js",
    ]);
  });
  it("maps a .js import in TS source to the .ts file first", () => {
    expect(importCandidates("src/a.ts", "./b.js").slice(0, 3)).toEqual(["src/b.ts", "src/b.tsx", "src/b.js"]);
  });
  it("uses an explicit .ts path as is", () => {
    expect(importCandidates("src/a.ts", "./b.ts")).toEqual(["src/b.ts"]);
  });
});

describe("buildChunkContext", () => {
  it("gathers the full file, imported signatures and call sites, in that order", async () => {
    const provider = fakeProvider({ "src/users.ts": users, "src/db.ts": db }, { getDisplayName: [caller] });
    const ctx = await buildChunkContext({ files: [change("src/users.ts", usersPatch)], provider, ref: "HEAD" });

    expect(ctx.included.map((b) => b.title)).toEqual([
      "FULL FILE (after this PR): src/users.ts",
      "SIGNATURES: src/db.ts (imported by src/users.ts)",
      "CALL SITES of getDisplayName (changed in src/users.ts)",
    ]);
    expect(ctx.text.startsWith(REFERENCE_HEADER)).toBe(true);
    expect(ctx.text).toContain("6 |   return rows[0]?.name ?? null;");
    expect(ctx.text).toContain("export async function query<T>(text: string, params: unknown[] = []): Promise<T[]>;");
    expect(ctx.text).not.toContain("pool.query(text, params)).rows"); // no function bodies
    expect(ctx.text).toContain("src/routes/profile.ts:8\n 5 | a");
    expect(ctx.errors).toEqual([]);
  });

  it("only looks up callers of exports the diff touched", async () => {
    const provider = fakeProvider({ "src/users.ts": users, "src/db.ts": db });
    await buildChunkContext({ files: [change("src/users.ts", "@@ -1,1 +1,2 @@\n import { query } from \"./db\";\n+// comment")], provider, ref: "HEAD" });
    expect(provider.findCallers).not.toHaveBeenCalled();
  });

  it("skips signatures of files that are already in the chunk, and of missing files", async () => {
    const provider = fakeProvider({ "src/users.ts": users, "src/db.ts": db });
    const ctx = await buildChunkContext({ files: [change("src/users.ts", usersPatch), change("src/db.ts", "@@ -1 +1 @@\n+x")], provider, ref: "HEAD" });
    expect(ctx.included.filter((b) => b.priority === 2)).toEqual([]);

    const missing = await buildChunkContext({ files: [change("src/users.ts", usersPatch)], provider: fakeProvider({ "src/users.ts": users }), ref: "HEAD" });
    expect(missing.included.map((b) => b.priority)).toEqual([1]);
  });

  it("stops at 5 call sites and never shows the changed file as its own caller", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...caller, file: `src/c${i}.ts` }));
    const self = { ...caller, file: "src/users.ts" };
    const provider = fakeProvider({ "src/users.ts": users }, { getDisplayName: [self, ...many] });
    const ctx = await buildChunkContext({ files: [change("src/users.ts", usersPatch)], provider, ref: "HEAD" });
    expect((ctx.text.match(/^src\/c\d\.ts:8$/gm) ?? []).length).toBe(5);
    expect(ctx.text).not.toContain("src/users.ts:8");
  });

  it("drops lower-priority blocks first when over budget", async () => {
    const provider = fakeProvider({ "src/users.ts": users, "src/db.ts": db }, { getDisplayName: [caller] });
    const full = await buildChunkContext({ files: [change("src/users.ts", usersPatch)], provider, ref: "HEAD" });
    const tight = await buildChunkContext({ files: [change("src/users.ts", usersPatch)], provider, ref: "HEAD", budget: full.tokens - 5 });
    expect(tight.included.map((b) => b.priority)).toEqual([1, 2]);
    expect(tight.dropped.map((b) => b.priority)).toEqual([3]);
    expect(tight.tokens).toBeLessThanOrEqual(full.tokens - 5);
  });

  it("returns empty text when nothing fits or nothing is found", async () => {
    const none = await buildChunkContext({ files: [change("src/users.ts", usersPatch)], provider: fakeProvider({}), ref: "HEAD" });
    expect(none).toEqual({ text: "", tokens: 0, included: [], dropped: [], errors: [] });
    const tiny = await buildChunkContext({ files: [change("src/users.ts", usersPatch)], provider: fakeProvider({ "src/users.ts": users }), ref: "HEAD", budget: 10 });
    expect(tiny.text).toBe("");
    expect(tiny.dropped).toHaveLength(1);
  });

  it("never throws: provider errors are recorded and that piece is skipped", async () => {
    const provider: ContextProvider = {
      getFile: async (path) => (path === "src/users.ts" ? users : Promise.reject(new Error("GitHub 502"))),
      findCallers: async () => {
        throw new Error("search rate limited");
      },
    };
    const ctx = await buildChunkContext({ files: [change("src/users.ts", usersPatch)], provider, ref: "HEAD" });
    expect(ctx.included.map((b) => b.priority)).toEqual([1]);
    expect(ctx.errors).toEqual(expect.arrayContaining(["callers of getDisplayName: search rate limited"]));
    expect(ctx.errors.some((e) => e.includes("GitHub 502"))).toBe(true);
  });

  it("uses the provider's cached getSignatures when it has one", async () => {
    const provider = { ...fakeProvider({ "src/users.ts": users }), getSignatures: vi.fn(async (p: string) => (p === "src/db.ts" ? "export function query(): void;" : null)) };
    const ctx = await buildChunkContext({ files: [change("src/users.ts", usersPatch)], provider, ref: "HEAD" });
    expect(provider.getSignatures).toHaveBeenCalledWith("src/db.ts", "HEAD");
    expect(ctx.text).toContain("export function query(): void;");
  });

  it("gives non-TypeScript files only the full file", async () => {
    const provider = fakeProvider({ "README.md": "# Title\ntext\n" });
    const ctx = await buildChunkContext({ files: [change("README.md", "@@ -1 +1 @@\n+# Title")], provider, ref: "HEAD" });
    expect(ctx.included.map((b) => b.title)).toEqual(["FULL FILE (after this PR): README.md"]);
  });
});

describe("renderWithinBudget", () => {
  it("keeps a small later block when a bigger earlier one doesn't fit", () => {
    const blocks = [
      { priority: 1 as const, language: "text" as const, title: "big", body: "x".repeat(10_000) },
      { priority: 2 as const, language: "ts" as const, title: "small", body: "y" },
    ];
    const ctx = renderWithinBudget(blocks, 200);
    expect(ctx.included.map((b) => b.title)).toEqual(["small"]);
    expect(ctx.dropped.map((b) => b.title)).toEqual(["big"]);
  });
});
