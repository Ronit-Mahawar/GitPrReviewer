import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNK_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT } from "./prompt";
import { coverageNote, fallbackRiskScore, reviewPullRequest, type Llm, type LlmMessage, type LlmReply, type RunStep } from "./review-pull-request";
import type { FileChange, ReviewComment } from "./schema";

const file = (filename: string, patch: string, status = "modified"): FileChange => ({ filename, status, additions: 1, deletions: 0, patch });
const comment = (file: string, line: number, severity: ReviewComment["severity"] = "high"): ReviewComment => ({
  file, line, severity, category: "bug", message: `problem at ${file}:${line}`,
});
const reply = (content: string | null, over: Partial<LlmReply> = {}): LlmReply => ({
  content, model: "fake-model", promptTokens: 100, completionTokens: 10, finishReason: "stop", ...over,
});
const summaryJson = JSON.stringify({ summary: "Looks risky.", riskScore: 60 });

/** A fake model: chunk calls get `onChunk(userPrompt)`, summary calls get the summary reply. */
function fakeLlm(onChunk: (user: string, call: number) => LlmReply | Promise<LlmReply>, onSummary: () => LlmReply | Promise<LlmReply> = () => reply(summaryJson)) {
  let chunkCalls = 0;
  const llm = vi.fn(async (messages: LlmMessage[]) => {
    if (messages[0]!.content === SUMMARY_SYSTEM_PROMPT) return onSummary();
    expect(messages[0]!.content).toBe(CHUNK_SYSTEM_PROMPT);
    return onChunk(messages[1]!.content, chunkCalls++);
  });
  return llm as typeof llm & Llm;
}
const isSummaryCall = (call: unknown[]) => (call[0] as LlmMessage[])[0]!.content === SUMMARY_SYSTEM_PROMPT;

/** A file whose added lines are 1..n, each about `width` characters, so tests can force several chunks. */
const bigFile = (name: string, n: number, width = 60) =>
  file(name, [`@@ -0,0 +1,${n} @@`, ...Array.from({ length: n }, (_, i) => `+${String(i).padEnd(width, "x")}`)].join("\n"), "added");

describe("reviewPullRequest", () => {
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("reviews a small PR with one chunk call and one summary call, using annotated line numbers", async () => {
    const llm = fakeLlm(() => reply(JSON.stringify({ comments: [comment("src/a.ts", 1)] })));
    const out = await reviewPullRequest({ title: "Add a", files: [file("src/a.ts", "@@ -1 +1 @@\n-old\n+const a = 1;")] }, { llm });

    expect(llm).toHaveBeenCalledTimes(2);
    const chunkUser = (llm.mock.calls.find((c) => !isSummaryCall(c))![0] as LlmMessage[])[1]!.content;
    expect(chunkUser).toContain("### src/a.ts (modified)\n```diff\n@@ -1 +1 @@\n-   | old\n+ 1 | const a = 1;\n```");
    expect(out).toMatchObject({ summary: "Looks risky.", riskScore: 60, comments: [comment("src/a.ts", 1)] });
    expect(out.meta).toMatchObject({
      model: "fake-model", filesReviewed: 1, filesSkipped: [], chunks: 1, failedChunks: 0, chunkErrors: [], summaryFallback: false,
      promptTokens: 200, completionTokens: 20,
    });
  });

  it("drops comments on lines the PR didn't add, and counts them", async () => {
    const llm = fakeLlm(() => reply(JSON.stringify({ comments: [comment("src/a.ts", 1), comment("src/a.ts", 2), comment("other.ts", 1)] })));
    const out = await reviewPullRequest({ title: "t", files: [file("src/a.ts", "@@ -1,2 +1,2 @@\n+added\n context")] }, { llm });
    expect(out.comments.map((c) => c.line)).toEqual([1]);
    expect(out.meta.comments).toEqual({ fromModel: 3, droppedInvalidLine: 2, droppedDuplicate: 0, droppedOverLimit: 0 });
  });

  it("asks again once when a chunk's reply isn't valid JSON", async () => {
    const llm = fakeLlm((_user, call) => (call === 0 ? reply('{"comments": [ cut off') : reply(JSON.stringify({ comments: [] }))));
    const out = await reviewPullRequest({ title: "t", files: [file("a.ts", "@@ -1 +1 @@\n+x")] }, { llm });
    expect(out.meta.failedChunks).toBe(0);
    expect(out.meta.promptTokens).toBe(300); // 2 chunk attempts + summary
  });

  it("marks only that chunk as failed after two bad replies; the review still completes and says so", async () => {
    // Two chunks: the first always replies garbage, the second works.
    const llm = fakeLlm((user) =>
      user.includes("### a.ts") ? reply("not json") : reply(JSON.stringify({ comments: [comment("b.ts", 1)] })),
    );
    const out = await reviewPullRequest({ title: "t", files: [bigFile("a.ts", 60), bigFile("b.ts", 60)] }, { llm }, { chunkTokenBudget: 1800 });
    expect(out.meta.chunks).toBe(2);
    expect(out.meta.failedChunks).toBe(1);
    expect(out.meta.chunkErrors[0]!.chunk).toBe(0);
    expect(out.comments.map((c) => c.file)).toEqual(["b.ts"]);
    expect(out.summary).toContain("1 of 2 part(s) of the diff could not be reviewed");
  });

  it("keeps going when the model call itself throws for one chunk", async () => {
    const llm = fakeLlm((user) => {
      if (user.includes("### a.ts")) throw new Error("429 rate limited");
      return reply(JSON.stringify({ comments: [] }));
    });
    const out = await reviewPullRequest({ title: "t", files: [bigFile("a.ts", 60), bigFile("b.ts", 60)] }, { llm }, { chunkTokenBudget: 1800 });
    expect(out.meta.failedChunks).toBe(1);
    expect(out.meta.chunkErrors).toEqual([{ chunk: 0, error: "429 rate limited" }]);
  });

  it("runs chunks in parallel, each as a named step, then a summarize step", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const llm = fakeLlm(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return reply(JSON.stringify({ comments: [] }));
    });
    const names: string[] = [];
    const runStep: RunStep = (name, fn) => {
      names.push(name);
      return fn();
    };
    const files = ["a.ts", "b.ts", "c.ts"].map((n) => bigFile(n, 60));
    const out = await reviewPullRequest({ title: "t", files }, { llm, runStep }, { chunkTokenBudget: 1800 });
    expect(out.meta.chunks).toBe(3);
    expect(maxInFlight).toBe(3);
    expect(names).toEqual(["review-chunk-0", "review-chunk-1", "review-chunk-2", "summarize"]);
  });

  it("doesn't call the model when every file is skipped, and says what was skipped", async () => {
    const llm = fakeLlm(() => reply("{}"));
    const out = await reviewPullRequest(
      { title: "deps", files: [file("package-lock.json", "@@ -1 +1 @@\n+x"), file("logo.png", "", "added")] },
      { llm },
    );
    expect(llm).not.toHaveBeenCalled();
    expect(out.riskScore).toBe(0);
    expect(out.summary).toContain("Not reviewed: 2 file(s) or part(s): package-lock.json (lockfile)");
    expect(out.meta.filesSkipped.map((s) => s.reason)).toEqual(["lockfile", "no patch (binary, too large for GitHub, or rename only)"]);
  });

  it("falls back to a summary written in code when the summary call fails", async () => {
    const llm = fakeLlm(
      () => reply(JSON.stringify({ comments: [comment("a.ts", 1, "critical")] })),
      () => {
        throw new Error("503 high demand");
      },
    );
    const out = await reviewPullRequest({ title: "t", files: [file("a.ts", "@@ -1 +1 @@\n+x")] }, { llm });
    expect(out.meta.summaryFallback).toBe(true);
    expect(out.riskScore).toBe(80);
    expect(out.summary).toContain("found 1 issue(s)");
  });

  it("adds the skipped files to the summary when some files were skipped", async () => {
    const llm = fakeLlm(() => reply(JSON.stringify({ comments: [] })));
    const out = await reviewPullRequest({ title: "t", files: [file("a.ts", "@@ -1 +1 @@\n+x"), file("yarn.lock", "@@ -1 +1 @@\n+y")] }, { llm });
    expect(out.summary).toBe("Looks risky.\n\nNot reviewed: 1 file(s) or part(s): yarn.lock (lockfile).");
  });
});

describe("fallbackRiskScore", () => {
  it("follows the most severe comment", () => {
    expect(fallbackRiskScore([])).toBe(5);
    expect(fallbackRiskScore([comment("a", 1, "low")])).toBe(15);
    expect(fallbackRiskScore([comment("a", 1, "low"), comment("a", 2, "high")])).toBe(60);
    expect(fallbackRiskScore([comment("a", 1, "critical")])).toBe(80);
  });
});

describe("coverageNote", () => {
  it("is empty when everything was reviewed", () => {
    expect(coverageNote([], 0, 3)).toBe("");
  });
  it("lists at most 5 skipped files and mentions failed parts", () => {
    const skipped = Array.from({ length: 7 }, (_, i) => ({ file: `f${i}.png`, reason: "image" }));
    const note = coverageNote(skipped, 2, 4);
    expect(note).toContain("Not reviewed: 7 file(s) or part(s): f0.png (image)");
    expect(note).toContain(", ….");
    expect(note).not.toContain("f5.png");
    expect(note).toContain("2 of 4 part(s) of the diff could not be reviewed");
  });
});
