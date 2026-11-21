import { describe, expect, it } from "vitest";
import { chunkFiles, chunkText, renderFileSection } from "./chunk";
import type { FileChange } from "./schema";
import { estimateTokens } from "./tokens";

/** A hunk adding `lines` lines of `width` characters, starting at new-file line `start`. */
function hunk(start: number, lines: number, width = 40): string {
  const body = Array.from({ length: lines }, (_, i) => `+${String(i).padEnd(width, "x")}`);
  return [`@@ -${start},0 +${start},${lines} @@`, ...body].join("\n");
}
const file = (filename: string, patch: string, status = "modified"): FileChange => ({ filename, status, additions: 0, deletions: 0, patch });

describe("renderFileSection", () => {
  it("labels parts only when given", () => {
    expect(renderFileSection("a.ts", "added", "BODY")).toBe("### a.ts (added)\n```diff\nBODY\n```");
    expect(renderFileSection("a.ts", "modified", "BODY", { index: 2, total: 3 })).toBe("### a.ts (modified, part 2 of 3)\n```diff\nBODY\n```");
  });
});

describe("chunkFiles", () => {
  it("packs small files into one chunk, in PR order, with their valid lines", () => {
    const { chunks, skipped } = chunkFiles([file("a.ts", hunk(1, 2)), file("b.ts", hunk(10, 1))], 7000);
    expect(skipped).toEqual([]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.files.map((f) => [f.filename, f.validLines])).toEqual([["a.ts", [1, 2]], ["b.ts", [10]]]);
    expect(chunks[0]!.files[0]!.text).toContain("+ 1 | 0");
    expect(chunks[0]!.tokens).toBe(estimateTokens(chunkText(chunks[0]!.files)));
  });

  it("starts a new chunk when the next file doesn't fit", () => {
    const files = ["a", "b", "c", "d", "e"].map((n) => file(`${n}.ts`, hunk(1, 12)));
    // budget for exactly two files per chunk, whatever the chars-per-token ratio is
    const one = chunkFiles([files[0]!]).chunks[0]!.tokens;
    const two = estimateTokens(chunkText(chunkFiles(files.slice(0, 2)).chunks[0]!.files));
    expect(two).toBeLessThan(3 * one);
    const { chunks } = chunkFiles(files, two);
    expect(chunks.map((c) => c.files.map((f) => f.filename))).toEqual([["a.ts", "b.ts"], ["c.ts", "d.ts"], ["e.ts"]]);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("splits an oversized file at hunk boundaries into labelled parts", () => {
    const big = file("big.ts", [hunk(1, 12), hunk(100, 12), hunk(200, 12)].join("\n"));
    const { chunks, skipped } = chunkFiles([big], 400);
    expect(skipped).toEqual([]);
    const parts = chunks.flatMap((c) => c.files);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.filename === "big.ts" && p.part?.total === parts.length)).toBe(true);
    expect(parts[0]!.text).toContain(`(modified, part 1 of ${parts.length})`);
    // every hunk lands whole in exactly one part, and valid lines are split with it
    expect(parts.flatMap((p) => p.validLines)).toEqual([
      ...Array.from({ length: 12 }, (_, i) => 1 + i),
      ...Array.from({ length: 12 }, (_, i) => 100 + i),
      ...Array.from({ length: 12 }, (_, i) => 200 + i),
    ]);
    expect(parts.map((p) => (p.text.match(/^@@ /gm) ?? []).length).reduce((a, b) => a + b)).toBe(3);
  });

  it("skips a single hunk that is bigger than the budget, but still reviews the file's other hunks", () => {
    const patch = [hunk(1, 3), hunk(50, 400), hunk(900, 3)].join("\n");
    const { chunks, skipped } = chunkFiles([file("mixed.ts", patch)], 1000);
    expect(skipped).toEqual([{ file: "mixed.ts", reason: "hunk too large", detail: "@@ -50,0 +50,400 @@" }]);
    const lines = chunks.flatMap((c) => c.files.flatMap((f) => f.validLines));
    expect(lines).toEqual([1, 2, 3, 900, 901, 902]);
  });

  it("skips a file that is one giant hunk entirely, producing no chunk for it", () => {
    const { chunks, skipped } = chunkFiles([file("huge.ts", hunk(1, 2000)), file("small.ts", hunk(1, 1))], 1000);
    expect(skipped.map((s) => [s.file, s.reason])).toEqual([["huge.ts", "hunk too large"]]);
    expect(chunks.flatMap((c) => c.files.map((f) => f.filename))).toEqual(["small.ts"]);
  });

  it("keeps every chunk within the budget", () => {
    const files = Array.from({ length: 30 }, (_, i) => file(`f${i}.ts`, [hunk(1, 5 + (i % 7) * 4), hunk(300, 3 + (i % 5) * 6)].join("\n")));
    const budget = 600;
    const { chunks } = chunkFiles(files, budget);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(estimateTokens(chunkText(c.files))).toBeLessThanOrEqual(budget);
  });

  it("uses the new name and status for a renamed file", () => {
    const { chunks } = chunkFiles([file("src/new-name.ts", "@@ -1 +1 @@\n-a\n+b", "renamed")]);
    expect(chunks[0]!.files[0]!.text.startsWith("### src/new-name.ts (renamed)\n")).toBe(true);
  });

  it("handles a new file and keeps the 'No newline' marker", () => {
    const { chunks } = chunkFiles([file("n.ts", "@@ -0,0 +1 @@\n+x\n\\ No newline at end of file", "added")]);
    expect(chunks[0]!.files[0]).toMatchObject({ validLines: [1] });
    expect(chunks[0]!.files[0]!.text).toContain("+ 1 | x\n\\ No newline at end of file");
  });

  it("reports an empty patch, or one without hunks, as skipped", () => {
    const { chunks, skipped } = chunkFiles([file("empty.ts", ""), file("odd.ts", "+no header")]);
    expect(chunks).toEqual([]);
    expect(skipped).toEqual([
      { file: "empty.ts", reason: "no hunks in patch" },
      { file: "odd.ts", reason: "no hunks in patch" },
    ]);
  });

  it("returns no chunks for no files, and rejects a bad budget", () => {
    expect(chunkFiles([])).toEqual({ chunks: [], skipped: [] });
    expect(() => chunkFiles([], 0)).toThrow(RangeError);
    expect(() => chunkFiles([], 1.5)).toThrow(RangeError);
  });
});
