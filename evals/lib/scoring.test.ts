import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../../src/server/review/schema";
import {
  buildJudgeMessages,
  computeMetrics,
  judgeCacheKey,
  locationCandidates,
  parseJudgeReply,
  percentile,
  renderMarkdown,
  spotCheckSample,
  type Judgement,
  type RunFile,
  type RunRecord,
  type ScoredCase,
} from "./scoring";

const bug = { file: "src/a.ts", line: 20, category: "off-by-one", description: "Loop runs one time too many." };
const comment = (file: string, line: number, severity: ReviewComment["severity"] = "medium"): ReviewComment => ({
  file, line, severity, category: "bug", message: `issue at ${line}`,
});

describe("locationCandidates", () => {
  it("keeps comments on the bug's file within ±3 lines, with their original index", () => {
    const comments = [comment("src/a.ts", 17), comment("src/a.ts", 16), comment("src/b.ts", 20), comment("src/a.ts", 23), comment("src/a.ts", 24)];
    expect(locationCandidates(comments, bug).map((c) => c.index)).toEqual([0, 3]);
  });
  it("returns nothing for no comments", () => {
    expect(locationCandidates([], bug)).toEqual([]);
  });
});

describe("buildJudgeMessages", () => {
  it("asks the exact question from the brief and includes the comment", () => {
    const [, user] = buildJudgeMessages(bug, { ...comment("src/a.ts", 20), suggestion: "use <" });
    expect(user!.content).toContain(`Does this comment identify this bug: ${bug.description}?`);
    expect(user!.content).toContain("issue at 20");
    expect(user!.content).toContain("Suggested fix: use <");
  });
});

describe("parseJudgeReply", () => {
  it("reads JSON answers in any case, with the reason", () => {
    expect(parseJudgeReply('{"answer":"yes","reason":"names the loop"}')).toEqual({ answer: true, reason: "names the loop" });
    expect(parseJudgeReply('{"answer":"NO"}')).toEqual({ answer: false, reason: null });
  });
  it("reads fenced JSON and plain-text YES/NO", () => {
    expect(parseJudgeReply('```json\n{"answer":"YES"}\n```').answer).toBe(true);
    expect(parseJudgeReply("NO, it is about naming").answer).toBe(false);
  });
  it("returns null when the reply can't be read", () => {
    expect(parseJudgeReply(null).answer).toBeNull();
    expect(parseJudgeReply('{"answer":"maybe"}').answer).toBeNull();
    expect(parseJudgeReply("I think so").answer).toBeNull();
  });
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(percentile(xs, 95)).toBe(19);
    expect(percentile(xs, 100)).toBe(20);
    expect(percentile([5], 95)).toBe(5);
  });
  it("is NaN for no values and ignores input order", () => {
    expect(percentile([], 95)).toBeNaN();
    expect(percentile([3, 1, 2], 50)).toBe(2);
  });
});

const cases: ScoredCase[] = [
  { id: "b1", kind: "bug", bug },
  { id: "big", kind: "large", bug: { ...bug, category: "sql-injection" } },
  { id: "c1", kind: "clean" },
];
const rec = (caseId: string, run: number, over: Partial<RunRecord> = {}): RunRecord => ({
  caseId, run, ok: true, latencyMs: 1000, promptTokens: 100, completionTokens: 10, comments: [], ...over,
});

describe("computeMetrics", () => {
  const file: RunFile = {
    label: "t", startedAt: "2026-01-01T00:00:00Z", model: "m", temperature: 0, runs: 2, gitCommit: "abc",
    caseIds: ["b1", "big", "c1"],
    records: [
      rec("b1", 1, { comments: [comment("src/a.ts", 20), comment("src/a.ts", 5)] }), // caught + 1 noise
      rec("b1", 2, { ok: false, error: "bad json", latencyMs: 9000, comments: [] }), // failed → miss
      rec("big", 1, { comments: [comment("src/x.ts", 1)], latencyMs: 3000 }), // missed, 1 noise
      rec("big", 2, { latencyMs: 2000, promptTokens: null, completionTokens: null }),
      rec("c1", 1, { comments: [comment("src/c.ts", 1, "high")] }), // false alarm
      rec("c1", 2, { comments: [comment("src/c.ts", 1, "low")] }),
    ],
  };
  const matched = new Map([["b1#1", new Set([0])]]);
  const m = computeMetrics(file, cases, matched);

  it("counts catch rate overall, by kind and by category; failed reviews are misses", () => {
    expect(m.catchRate.overall).toEqual({ caught: 1, total: 4 });
    expect(m.catchRate.byKind).toEqual({ bug: { caught: 1, total: 2 }, large: { caught: 0, total: 2 } });
    expect(m.catchRate.byCategory).toEqual({ "off-by-one": { caught: 1, total: 2 }, "sql-injection": { caught: 0, total: 2 } });
  });

  it("counts noise over successful reviews only, and clean-PR false alarms", () => {
    expect(m.noisePerPr).toBeCloseTo((1 + 1 + 0 + 1 + 1) / 5);
    expect(m.cleanFalseAlarms).toEqual({ reviewsWithHighOrCritical: 1, cleanReviews: 2 });
    expect(m.failedReviews).toBe(1);
    expect(m.reviews).toBe(6);
  });

  it("averages latency over successful reviews and tokens over reviews that report them", () => {
    expect(m.latencyMs.avg).toBe((1000 + 3000 + 2000 + 1000 + 1000) / 5);
    expect(m.latencyMs.median).toBe(1000);
    expect(m.latencyMs.p95).toBe(3000);
    expect(m.tokensPerPr).toEqual({ prompt: 100, completion: 10 });
    expect(m.chunks).toBeNull(); // v1-style records have no chunk info
  });

  it("reports per-case rows in run order", () => {
    expect(m.perCase.map((c) => [c.id, c.caught, c.runs])).toEqual([["b1", 1, 2], ["big", 0, 2], ["c1", 0, 2]]);
    expect(m.perCase[2]!.category).toBeNull();
  });

  it("totals chunk info for v2 runs", () => {
    const v2 = { ...file, records: [rec("b1", 1, { chunks: 2, failedChunks: 1, droppedInvalidLine: 3 }), rec("c1", 1, { chunks: 1, failedChunks: 0, droppedInvalidLine: 0 })] };
    expect(computeMetrics(v2, cases, new Map()).chunks).toEqual({ total: 3, failed: 1, droppedInvalidLine: 3 });
    expect(renderMarkdown(v2, "j", computeMetrics(v2, cases, new Map()), [])).toContain("| Chunks reviewed / failed | 3 / 1 |");
  });

  it("throws on a result for an unknown case", () => {
    expect(() => computeMetrics({ ...file, records: [rec("nope", 1)] }, cases, new Map())).toThrow(/unknown case/);
  });

  it("renders a Markdown table with the headline numbers", () => {
    const md = renderMarkdown(file, "judge-m", m, []);
    expect(md).toContain("| Catch rate | **25% (1/4)** |");
    expect(md).toContain("| False alarms on clean PRs (any high/critical) | 1/2 reviews |");
    expect(md).toContain("| Failed reviews | 1/6 |");
  });
});

describe("spotCheckSample", () => {
  const j = (answer: boolean | null, i: number): Judgement => ({
    caseId: "c", run: 1, commentIndex: i, comment: { file: "f", line: 1, severity: "low", message: `m${i}-${answer}` }, answer, reason: null,
  });
  it("shows each distinct comment once, even if it repeats across runs", () => {
    const repeated = [1, 2, 3].map((run) => ({ ...j(true, 0), run }));
    expect(spotCheckSample([...repeated, j(false, 1)])).toHaveLength(2);
  });
  it("takes half YES and half NO when both exist", () => {
    const all = [...Array.from({ length: 8 }, (_, i) => j(true, i)), ...Array.from({ length: 8 }, (_, i) => j(false, i))];
    const sample = spotCheckSample(all);
    expect(sample.filter((s) => s.answer).length).toBe(5);
    expect(sample).toHaveLength(10);
  });
  it("fills with the other answer when one side is short", () => {
    const all = [...Array.from({ length: 12 }, (_, i) => j(true, i)), j(false, 0), j(null, 1)];
    const sample = spotCheckSample(all);
    expect(sample).toHaveLength(10);
    expect(sample.filter((s) => !s.answer).length).toBe(2);
  });
});

describe("judgeCacheKey", () => {
  const c = comment("src/a.ts", 20);
  it("is stable for the same inputs", () => {
    expect(judgeCacheKey("j", bug, c)).toBe(judgeCacheKey("j", bug, { ...c }));
  });
  it("changes with the judge model, the bug or the comment text", () => {
    const base = judgeCacheKey("j", bug, c);
    expect(judgeCacheKey("other-judge", bug, c)).not.toBe(base);
    expect(judgeCacheKey("j", { ...bug, description: "Different bug." }, c)).not.toBe(base);
    expect(judgeCacheKey("j", bug, { ...c, message: "different text" })).not.toBe(base);
    expect(judgeCacheKey("j", bug, { ...c, suggestion: "a fix" })).not.toBe(base);
  });
});
