/**
 * Scores a run file against ground-truth.json (+ optional manual labels) and writes a Markdown report.
 *
 *   npx tsx evals/planted-bugs/score.ts [results/run-*.json]        # defaults to the newest run
 *   npx tsx evals/planted-bugs/score.ts --export-unlabeled           # dump non-matching comments to label
 *
 * Matching: a comment "catches" a planted bug when it is on the bug's file, within ±LINE_TOLERANCE
 * lines of a marked bug line, and its message/suggestion matches the bug class's keyword pattern.
 * Every other comment is "other" and is classified via labels.json as
 *   valid   – a real, different issue worth raising
 *   useless – technically true but not actionable / nitpick / speculative / restates the code
 *   false   – factually wrong about the code
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReviewComment } from "../../src/server/services/ai";
import type { BugKind } from "./cases";
import type { RunRecord } from "./run";
import type { GroundTruth } from "./setup-testbed";

const HERE = resolve(__dirname);
const LINE_TOLERANCE = 6;
/** Gemini 3.1 Flash-Lite standard pricing, USD per 1M tokens (verify at ai.google.dev/pricing). */
const PRICE = { inputPerM: 0.25, outputPerM: 1.5 };

const KIND_PATTERNS: Record<Exclude<BugKind, "clean">, RegExp> = {
  "off-by-one":
    /off[- ]by[- ]one|one[- ]indexed|1[- ]indexed|zero[- ]indexed|0[- ]indexed|page\s*-\s*1|<=|empty (chunk|batch|array)|extra|n\s*\+\s*1|one (more|fewer|less|too many)|too many|skip|never (be )?(call|invok|execut|run|attempt)|attempts?\s*-\s*1|fewer|boundary|slice\(-n\)/i,
  "sql-injection": /sql[- ]injection|inject|parameteri[sz]|sanitiz|escap|allow-?list|whitelist|prepared statement|placeholder/i,
  "null-check": /null|undefined|non-null|optional|nullish|crash|TypeError|guard|does not exist|doesn't exist|not found|missing|may be absent|\?\./i,
  "race-condition": /race|concurren|atomic|transaction|lock|TOCTOU|lost update|simultaneous|in parallel|parallel requests|oversell|double|idempoten|FOR UPDATE|INCR|ON CONFLICT/i,
  "leaked-secret": /secret|hard-?coded|credential|api key|access key|leak|expos|sensitive|environment variable|env var|redact|password|token|rotate/i,
};

type Label = "valid" | "useless" | "false" | "hit"; // "hit" = manual override: catches the bug elsewhere (e.g. at the call site)
type Labels = Record<string, { label: Label; note?: string }>;

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const truth = JSON.parse(readFileSync(join(HERE, "ground-truth.json"), "utf8")) as GroundTruth;
const runFile =
  (args.find((a) => a.endsWith(".json") && a !== opt("--labels")) as string | undefined) ??
  join(HERE, "results", readdirSync(join(HERE, "results")).filter((f) => f.startsWith("run-")).sort().pop()!);
const run = JSON.parse(readFileSync(resolve(runFile), "utf8")) as { startedAt: string; repo: string; runs: number; records: RunRecord[] };
const labelsPath = resolve(opt("--labels") ?? join(HERE, "labels.json"));
const labels: Labels = existsSync(labelsPath) ? JSON.parse(readFileSync(labelsPath, "utf8")) : {};

const caseById = new Map(truth.cases.map((c) => [c.id, c]));
const commentKey = (r: RunRecord, i: number) => `${r.caseId}#${r.run}#${i}`;
const text = (c: ReviewComment) => `${c.message} ${c.suggestion ?? ""}`;
const manualHit = (r: RunRecord, i: number) => labels[commentKey(r, i)]?.label === "hit";

function isHit(caseId: string, c: ReviewComment, strictLine: boolean): boolean {
  const gt = caseById.get(caseId)!;
  if (gt.kind === "clean") return false;
  const bug = gt.bugs.find((b) => b.file === c.file);
  if (!bug) return false;
  if (!KIND_PATTERNS[gt.kind].test(text(c))) return false;
  return !strictLine || bug.lines.some((l) => Math.abs(l - c.line) <= LINE_TOLERANCE);
}

// ── classify every comment ──
interface Classified { rec: RunRecord; idx: number; c: ReviewComment; cls: "hit" | "duplicate-hit" | Exclude<Label, "hit"> | "unlabeled" }
const classified: Classified[] = [];
for (const rec of run.records) {
  let hitSeen = false;
  rec.comments.forEach((c, idx) => {
    let cls: Classified["cls"];
    const manual = labels[commentKey(rec, idx)]?.label;
    if (manual && manual !== "hit") cls = manual; // a hand label overrides the keyword matcher
    else if (isHit(rec.caseId, c, true) || manualHit(rec, idx)) {
      cls = hitSeen ? "duplicate-hit" : "hit";
      hitSeen = true;
    } else cls = (labels[commentKey(rec, idx)]?.label as Exclude<Label, "hit">) ?? "unlabeled";
    classified.push({ rec, idx, c, cls });
  });
}

if (args.includes("--export-unlabeled")) {
  const rows = classified
    .filter((x) => x.cls === "unlabeled")
    .map((x) => ({ key: commentKey(x.rec, x.idx), caseKind: caseById.get(x.rec.caseId)!.kind, expected: caseById.get(x.rec.caseId)!.expected, ...x.c }));
  writeFileSync(join(HERE, "results", "unlabeled.json"), JSON.stringify(rows, null, 2) + "\n");
  console.log(`${rows.length} unlabeled comments → results/unlabeled.json`);
  process.exit(0);
}

// ── metrics ──
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "–");
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const cost = (r: RunRecord) => ((r.promptTokens ?? 0) * PRICE.inputPerM + (r.completionTokens ?? 0) * PRICE.outputPerM) / 1e6;

const bugRecs = run.records.filter((r) => caseById.get(r.caseId)!.kind !== "clean");
const overridden = (r: RunRecord, i: number) => { const l = labels[commentKey(r, i)]?.label; return !!l && l !== "hit"; };
const caughtStrict = (r: RunRecord) => r.comments.some((c, i) => !overridden(r, i) && (isHit(r.caseId, c, true) || manualHit(r, i)));
const caughtLenient = (r: RunRecord) => r.comments.some((c, i) => !overridden(r, i) && (isHit(r.caseId, c, false) || manualHit(r, i)));

const kinds = ["off-by-one", "sql-injection", "null-check", "race-condition", "leaked-secret"] as const;
const perKind = kinds.map((k) => {
  const recs = bugRecs.filter((r) => caseById.get(r.caseId)!.kind === k);
  const caseIds = [...new Set(recs.map((r) => r.caseId))];
  return {
    kind: k,
    runs: recs.length,
    caught: recs.filter(caughtStrict).length,
    lenient: recs.filter(caughtLenient).length,
    anyRun: caseIds.filter((id) => recs.some((r) => r.caseId === id && caughtStrict(r))).length,
    allRuns: caseIds.filter((id) => recs.filter((r) => r.caseId === id).every(caughtStrict)).length,
    cases: caseIds.length,
  };
});

const okRecs = run.records.filter((r) => r.ok);
const count = (pred: (x: Classified) => boolean) => classified.filter(pred).length;
const onBug = (x: Classified) => caseById.get(x.rec.caseId)!.kind !== "clean";
const totalComments = classified.length;
const hits = count((x) => x.cls === "hit");
const dup = count((x) => x.cls === "duplicate-hit");
const valid = count((x) => x.cls === "valid");
const useless = count((x) => x.cls === "useless");
const falseC = count((x) => x.cls === "false");
const unlabeled = count((x) => x.cls === "unlabeled");
const cleanComments = classified.filter((x) => !onBug(x));
const cleanRecs = run.records.filter((r) => caseById.get(r.caseId)!.kind === "clean");

const lat = okRecs.map((r) => r.latencyMs / 1000);
const costs = run.records.map(cost);
const hitSev = classified.filter((x) => x.cls === "hit").map((x) => x.c.severity);
const hitLineOffsets = classified
  .filter((x) => x.cls === "hit")
  .map((x) => {
    const bug = caseById.get(x.rec.caseId)!.bugs.find((b) => b.file === x.c.file);
    return bug ? Math.min(...bug.lines.map((l) => Math.abs(l - x.c.line))) : null;
  })
  .filter((d): d is number => d !== null);

const md: string[] = [];
md.push(`# Planted-bug eval — ${run.startedAt.slice(0, 10)}`);
md.push("");
md.push(`Repo: \`${run.repo}\` · ${truth.cases.length} PRs (${truth.cases.filter((c) => c.kind !== "clean").length} planted bugs + ${truth.cases.filter((c) => c.kind === "clean").length} clean controls) · ${run.runs} runs each · ${run.records.length} reviews · model calls via \`reviewCode()\``);
md.push("");
md.push("## Headline");
md.push("");
md.push(`| Metric | Value |`);
md.push(`|---|---|`);
md.push(`| Bug catch rate (per review) | **${pct(bugRecs.filter(caughtStrict).length, bugRecs.length)}** (${bugRecs.filter(caughtStrict).length}/${bugRecs.length}) |`);
md.push(`| Catch rate, ignoring line number | ${pct(bugRecs.filter(caughtLenient).length, bugRecs.length)} |`);
md.push(`| Bugs caught in at least 1 of ${run.runs} runs | ${perKind.reduce((a, k) => a + k.anyRun, 0)}/${perKind.reduce((a, k) => a + k.cases, 0)} |`);
md.push(`| Bugs caught in all ${run.runs} runs | ${perKind.reduce((a, k) => a + k.allRuns, 0)}/${perKind.reduce((a, k) => a + k.cases, 0)} |`);
md.push(`| Comments total | ${totalComments} (${(totalComments / (okRecs.length || 1)).toFixed(1)} per review) |`);
md.push(`| → hit planted bug | ${hits} (${pct(hits, totalComments)}) |`);
md.push(`| → duplicate of a hit | ${dup} (${pct(dup, totalComments)}) |`);
md.push(`| → valid other issue | ${valid} (${pct(valid, totalComments)}) |`);
md.push(`| → useless (nitpick / speculative / vague) | ${useless} (${pct(useless, totalComments)}) |`);
md.push(`| → false (wrong about the code) | ${falseC} (${pct(falseC, totalComments)}) |`);
if (unlabeled) md.push(`| → unlabeled | ${unlabeled} |`);
md.push(`| False + useless share | **${pct(falseC + useless, totalComments - unlabeled)}** |`);
md.push(`| Clean PRs: comments / high+critical | ${cleanComments.length} / ${cleanComments.filter((x) => x.c.severity === "high" || x.c.severity === "critical").length} over ${cleanRecs.length} reviews |`);
md.push(`| Failed reviews (bad JSON / API error) | ${run.records.length - okRecs.length}/${run.records.length} |`);
md.push(`| Latency p50 / p90 / max | ${quantile(lat, 0.5).toFixed(2)}s / ${quantile(lat, 0.9).toFixed(2)}s / ${Math.max(...lat).toFixed(2)}s |`);
md.push(`| Tokens per PR (in / out, mean) | ${mean(run.records.map((r) => r.promptTokens ?? 0)).toFixed(0)} / ${mean(run.records.map((r) => r.completionTokens ?? 0)).toFixed(0)} |`);
md.push(`| Cost per PR (mean) | $${mean(costs).toFixed(6)} (≈ $${(mean(costs) * 1000).toFixed(2)} per 1,000 PRs) |`);
md.push(`| Hits on the exact line / within ±1 | ${pct(hitLineOffsets.filter((d) => d === 0).length, hitLineOffsets.length)} / ${pct(hitLineOffsets.filter((d) => d <= 1).length, hitLineOffsets.length)} (of ${hitLineOffsets.length} same-file hits) |`);
md.push(`| Severity given to hits | ${["critical", "high", "medium", "low"].map((s) => `${s} ${hitSev.filter((x) => x === s).length}`).join(", ")} |`);
md.push("");
md.push("## By bug type");
md.push("");
md.push("| Type | Catch rate | ignoring line | ≥1 run | all runs |");
md.push("|---|---|---|---|---|");
for (const k of perKind) md.push(`| ${k.kind} | ${pct(k.caught, k.runs)} (${k.caught}/${k.runs}) | ${pct(k.lenient, k.runs)} | ${k.anyRun}/${k.cases} | ${k.allRuns}/${k.cases} |`);
md.push("");
md.push("## Per PR");
md.push("");
md.push("| Case | PR | Caught (runs) | Comments | False/useless | Latency mean | Cost mean |");
md.push("|---|---|---|---|---|---|---|");
for (const c of truth.cases) {
  const recs = run.records.filter((r) => r.caseId === c.id);
  const cl = classified.filter((x) => x.rec.caseId === c.id);
  md.push(
    `| ${c.id} | #${c.prNumber} | ${c.kind === "clean" ? "n/a" : `${recs.filter(caughtStrict).length}/${recs.length}`} | ${cl.length} | ` +
      `${cl.filter((x) => x.cls === "false" || x.cls === "useless").length} | ${mean(recs.map((r) => r.latencyMs / 1000)).toFixed(2)}s | $${mean(recs.map(cost)).toFixed(6)} |`,
  );
}
md.push("");
md.push("## Missed bugs (run 1)");
md.push("");
if (!bugRecs.some((r) => r.run === 1 && !caughtStrict(r))) md.push("None.");
for (const r of bugRecs.filter((r) => r.run === 1 && !caughtStrict(r))) {
  const c = caseById.get(r.caseId)!;
  md.push(`- **${c.id}** (#${c.prNumber}) — expected: ${c.expected}`);
  if (!r.ok) md.push(`  - review failed: ${r.error}`);
  for (const cm of r.comments) md.push(`  - got \`${cm.file}:${cm.line}\` [${cm.severity}/${cm.category}] ${cm.message}`);
}
md.push("");
md.push("## False and useless comments");
md.push("");
for (const x of classified.filter((x) => x.cls === "false" || x.cls === "useless")) {
  md.push(`- **${x.cls}** · ${x.rec.caseId} run ${x.rec.run} · \`${x.c.file}:${x.c.line}\` [${x.c.severity}] ${x.c.message}${labels[commentKey(x.rec, x.idx)]?.note ? ` — _${labels[commentKey(x.rec, x.idx)]!.note}_` : ""}`);
}
md.push("");
md.push("## Method");
md.push("");
md.push(`- A comment counts as catching the planted bug if it is on the right file, within ±${LINE_TOLERANCE} lines of the marked line, and its text matches the bug class (e.g. "inject"/"parameterize" for SQL injection). "Ignoring line" drops the line check.`);
md.push(`- Every other comment was labeled by hand in \`labels.json\` as valid / useless / false.`);
md.push(`- Latency is wall time of \`reviewCode()\` (one model call), measured from this machine; it excludes GitHub fetch, Inngest queueing and DB writes.`);
md.push(`- Cost uses $${PRICE.inputPerM}/1M input and $${PRICE.outputPerM}/1M output tokens (Gemini 3.1 Flash-Lite standard tier).`);

const reportPath = resolve(opt("--out") ?? join(HERE, "report.md"));
writeFileSync(reportPath, md.join("\n") + "\n");
console.log(md.slice(0, 40).join("\n"));
console.log(`\nWrote ${reportPath}`);
