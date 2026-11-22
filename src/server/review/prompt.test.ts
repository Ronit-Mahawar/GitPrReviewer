import { describe, expect, it } from "vitest";
import { buildChunkUserPrompt, buildSummaryUserPrompt, CHUNK_SYSTEM_PROMPT, chunkSystemPrompt, SUMMARY_SYSTEM_PROMPT } from "./prompt";

describe("CHUNK_SYSTEM_PROMPT", () => {
  it("explains the annotated format and limits comments to added lines", () => {
    expect(CHUNK_SYSTEM_PROMPT).toContain('"+ 45 | code" is a line added by this pull request');
    expect(CHUNK_SYSTEM_PROMPT).toContain('Only on added lines (marked "+")');
    expect(CHUNK_SYSTEM_PROMPT).toContain("at most 5 comments");
  });
  it("keeps the v1 review rules", () => {
    expect(CHUNK_SYSTEM_PROMPT).toContain("Severity guide:");
    expect(CHUNK_SYSTEM_PROMPT).toContain("Do NOT comment on:");
    expect(CHUNK_SYSTEM_PROMPT).toContain("Before reporting, check each claim against the code:");
  });
  it("asks for comments only, not a summary", () => {
    expect(CHUNK_SYSTEM_PROMPT).not.toContain('"summary"');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('{"summary": "...", "riskScore": 0-100}');
  });
});

describe("buildChunkUserPrompt", () => {
  it("only says which request this is when there are several", () => {
    expect(buildChunkUserPrompt("Fix bug", "DIFF", { index: 0, total: 1 })).toBe("Review this pull request:\n\n**Title:** Fix bug\n\n**Changes:**\nDIFF");
    expect(buildChunkUserPrompt("Fix bug", "DIFF", { index: 1, total: 3 })).toContain("(request 2 of 3 for this pull request)");
  });
});

describe("context prompts", () => {
  it("adds the context rules only when there is context, before the output rules", () => {
    expect(chunkSystemPrompt(false)).toBe(CHUNK_SYSTEM_PROMPT);
    const withContext = chunkSystemPrompt(true);
    expect(withContext).toContain("Never comment on code in the REFERENCE ONLY section.");
    expect(withContext.indexOf("Repository context:")).toBeLessThan(withContext.indexOf("Output rules:"));
  });

  it("puts the diff under CHANGED CODE and the reference section after it", () => {
    const text = buildChunkUserPrompt("Fix bug", "DIFF", { index: 0, total: 1 }, "## REFERENCE ONLY ...\nREF");
    expect(text).toBe('Review this pull request:\n\n**Title:** Fix bug\n\n## CHANGED CODE (review this; comment only on lines marked "+")\nDIFF\n\n## REFERENCE ONLY ...\nREF');
  });
});

describe("buildSummaryUserPrompt", () => {
  const base = { title: "Add reports", reviewedFiles: [{ filename: "a.ts", status: "added" }], skipped: [], comments: [], failedChunks: 0, totalChunks: 1 };

  it("lists files, skipped files and comments, without any diff", () => {
    const text = buildSummaryUserPrompt({
      ...base,
      skipped: [{ file: "package-lock.json", reason: "lockfile" }],
      comments: [{ file: "a.ts", line: 3, severity: "high", category: "bug", message: "Loop runs 13 times." }],
    });
    expect(text).toContain("**Title:** Add reports");
    expect(text).toContain("- a.ts (added)");
    expect(text).toContain("- package-lock.json: lockfile");
    expect(text).toContain("- [high/bug] a.ts:3: Loop runs 13 times.");
    expect(text).not.toContain("```");
  });

  it("writes (none) for empty lists and mentions failed parts", () => {
    const text = buildSummaryUserPrompt({ ...base, reviewedFiles: [], failedChunks: 1, totalChunks: 2 });
    expect(text.match(/- \(none\)/g)).toHaveLength(3);
    expect(text).toContain("1 of 2 parts of the diff could not be reviewed");
  });
});
