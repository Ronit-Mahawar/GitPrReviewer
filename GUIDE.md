# GUIDE.md — What was built, how it works, how to test it

This file is updated after every phase of v2. Read it top to bottom before an interview.

---

## v1: Where we started

**Flow:** PR event → webhook (HMAC verified, duplicate deliveries ignored) → `Review` row created (PENDING) → Inngest `review-pr` job → fetch all PR files (paginated) → **join every patch into one prompt** → one Gemini call (`max_tokens: 3000`, at most 5 comments) → `JSON.parse` + Zod → saved to DB → dashboard.

**Known weaknesses (the reasons for v2):**

| Weakness | Effect |
|---|---|
| All patches in one prompt, no filtering | Lockfiles and generated code waste tokens; bugs deep in large PRs get missed |
| At most 5 comments for the whole PR | A 40-file PR gets the same 5 comments as a 1-file PR |
| `max_tokens: 3000` + plain `JSON.parse` | Cut-off output leads to a parse error, retries, and finally a FAILED review |
| Model guesses line numbers from `@@` headers | Comments land on the wrong lines |
| Files with no `patch` dropped silently | The user doesn't know what wasn't reviewed |
| Diff only, no repo context | Can't catch broken contracts (e.g. a caller not handling a new `null` return) |
| No evals | No evidence of quality; every number is a guess |

**Note (decided in Phase 0, see D18):** the "v1" we baseline is the code as of commit `7adbfbb`, which already numbers diff lines (`L42 +code`), has a tighter prompt and recovers JSON with stray characters around it. So the "model guesses line numbers" and "plain `JSON.parse`" rows above are partly fixed in v1. What v1 still lacks: checking comment lines against valid added lines, chunking, a per-chunk retry, file filtering and repo context.

**Baseline eval results** (Phase 1; source: `evals/results/2026-11-21T14-11-55-195Z-v1-baseline.score.md`, reviewer `gemini-3.1-flash-lite` at temperature 0, judge `gemini-3-flash-preview`, 26 cases × 3 runs = 78 reviews):

| Metric | v1 baseline |
|---|---|
| Catch rate | **100% (66/66)** |
| … kind `bug` / `large` | 100% (63/63) / 100% (3/3) |
| Noise comments per PR | 0.23 |
| False alarms on clean PRs (any high/critical) | 0/12 reviews |
| Failed reviews | 0/78 |
| Latency avg / median / p95 | 9.27s / 2.94s / 36.62s |
| Tokens per PR (prompt / completion) | 2,562 / 174 (1,059 prompt without the large case; the large case alone is 40,141) |

How to read this: v1 already catches every planted bug in this set, so **catch rate can't show any v2 gain on these cases**. They're short, single-purpose PRs (~1k tokens). The large case is one PR and the model still found its bug. Improvements will have to show up in harder cases (more large PRs with bugs deep inside, several bugs per PR, context bugs), in noise, and in tokens and latency. The latency average and p95 are inflated by the provider that evening: one call took 222s and the same 1,122-token prompt took 4.1s, 35.6s and 3.9s on three runs. Use the median, and compare versions only on runs made close together.

---

## Phase 0: Cleanup and testability
**What was built:** The review logic was pulled out of the Inngest job into one pure function, `reviewPullRequest()`, that takes PR files and returns a review. The model is passed in as a plain function (`llm`), so production, the eval runner and unit tests all run the same code. Raw model output is no longer printed on every review; a tiny logger prints it only at `LOG_LEVEL=debug`. The model name is now configurable with `REVIEW_MODEL`. Behaviour did not change: on all 23 eval PRs the request sent to Gemini is byte-for-byte the same as before.

**How it works:**
1. `src/server/inngest/functions/review-pr.ts` fetches the PR and its files (unchanged), then calls `reviewPullRequest({ title, files }, { llm: createGeminiLlm() })` inside the `generate-review` step and saves the result.
2. `src/server/review/review-pull-request.ts` → `reviewPullRequest()`:
   - builds the diff text with `buildDiffText()` (`prompt.ts`): one Markdown block per file that has a `patch`, each line prefixed with its new-file line number by `numberPatch()`;
   - if there's nothing to review, returns a zero-risk review without calling the model;
   - otherwise calls `deps.llm([system, user])`, times the call, and parses the reply with `parseReview()` (`parse.ts`): `parseJsonObject()` (`JSON.parse`, falling back to the first balanced `{...}`), then Zod `ReviewResultSchema` (`schema.ts`);
   - returns `{ summary, riskScore, comments, meta: { model, promptTokens, completionTokens, latencyMs, finishReason } }`.
   - On bad output it throws `ReviewOutputValidationError`, which carries the token usage so the job can still save it (`zodValid: false`).
3. `src/server/services/ai.ts` → `createGeminiLlm({ model?, temperature? })` is now the only code that knows about the OpenAI SDK/Gemini. It returns the `llm` function. The model comes from `options.model`, else `REVIEW_MODEL`, else `gemini-3.1-flash-lite`. Temperature defaults to 0.3 (production); the Phase 1 eval will pass 0.
4. `src/server/lib/logger.ts` → `logger.debug/info/warn/error`. Messages below `LOG_LEVEL` (default `info`) are dropped. The job's old numbered `console.log("4. …")` … `("8. …")` lines became two `logger.info` lines with only the review ID, comment count and latency.
5. `ContextProvider` is declared in `review-pull-request.ts` (`getFile`, `findCallers`) but not used until Phase 4.

**Also cleaned up so `lint`, `tsc` and tests pass:** removed unused imports in six UI files; `diff-viewer.tsx` now works out line numbers in a helper (`numberDiffLines`) before rendering instead of reassigning variables inside JSX (same output, fixes a React-hooks lint error); replaced `any` in three test files; fixed the webhook test's DB mock (it was missing `review.update`, which the route already calls; the route itself was not touched); removed `package.json` scripts that pointed at the deleted `eval/` folder; excluded the deliberately buggy eval fixtures from lint; `.env.example` now lists `GEMINI_API_KEY` (it said `OPENAI_API_KEY`, which the code never reads), `REVIEW_MODEL` and `LOG_LEVEL`.

**Files changed:**
- New: `src/server/review/review-pull-request.ts`, `prompt.ts`, `parse.ts`, `schema.ts` (+ `*.test.ts` for each), `src/server/lib/logger.ts` (+ test)
- Changed: `src/server/services/ai.ts` (+ test), `src/server/inngest/functions/review-pr.ts` (+ test), `evals/planted-bugs/run.ts`, `evals/planted-bugs/score.ts`, `.env.example`, `package.json`, `eslint.config.mjs`, `CLAUDE.md` (file map)
- Lint-only: `src/components/diff-viewer.tsx`, `header.tsx`, `user-menu.tsx`, `connect-github.tsx`, `src/app/(auth)/sign-up/page.tsx`, `src/app/(dashboard)/repos/page.tsx`, `src/app/(dashboard)/repos/[id]/pr/[prNumber]/page.tsx`, `src/app/api/webhooks/github/route.test.ts`, `src/server/api/routers/review.test.ts`
- Renamed: `claude.md` → `CLAUDE.md`, `guide.md` → `GUIDE.md`, `decison.md` → `DECISIONS.md`

**How to test:**
```bash
npm run lint          # no errors, no warnings
npx tsc --noEmit      # no output
npm run test          # 8 files, 41 tests pass
```
- See the logger gate: run any review with `LOG_LEVEL=debug` and the raw model output is printed; without it, only the `review-pr started` / `completed` lines appear.
- Behaviour check (done once, not committed): a script ran every eval PR through the old `ai.ts` and the new code with `fetch` stubbed out, and compared the HTTP body sent to Gemini plus the returned review and token counts. Result: identical on 23/23 PRs.
- Live check: `npm run evals:bugs:run -- --runs 1 --only sqli-01` still runs end to end against Gemini.

**Interview Q&A:**
1. **Q: Why pass the model in as a function instead of calling the OpenAI SDK inside the review code?**
   A: So the review logic doesn't depend on a network service. In production I pass `createGeminiLlm()`, in the eval runner I pass the same thing with temperature 0, and in unit tests I pass a fake that returns a fixed string. All three run the exact same `reviewPullRequest` code, and the tests need no API key or network. It's dependency injection with a plain function, no framework.
2. **Q: The prompt says "don't change behaviour" — how do you know you didn't?**
   A: I didn't rely on reading the diff. I kept a copy of the old `ai.ts`, stubbed out `fetch`, and sent all 23 eval PRs through both versions. The JSON body sent to Gemini was byte-for-byte identical, and the parsed review and token counts matched, including a reply with stray backticks after the JSON. Unit tests also pin the exact request parameters (model, `temperature: 0.3`, `max_tokens: 3000`, JSON mode).
3. **Q: Why not just delete the logging, or use a real logging library like pino?**
   A: The raw model output is useful when debugging a bad review, so I kept it but behind `LOG_LEVEL=debug`; by default it's never printed, because it can contain the user's code. A library would add a dependency and configuration for what is about 30 lines: a level order, a check, and `console.log/warn/error`. If we later need structured JSON logs shipped somewhere, swapping the four functions for pino is a small change.

## Phase 1: Eval harness
**What was built:** A harness that reviews 26 known PRs with the production `reviewPullRequest()` and measures how many planted bugs it catches, how much noise it adds, false alarms on clean PRs, failures, latency and tokens. A second step scores each run: a comment counts only if it is on the bug's file within ±3 lines **and** an LLM judge says it identifies that bug. Everything runs locally; no GitHub, Inngest or database.

**How it works:**
1. **Cases** (`evals/cases/<id>/`): `pr.diff` is a unified diff against `evals/fixture-repo/` (a 13-file TypeScript shop API: route, services, DB layer, utils, types). `case.json` says `{ id, title, kind, bug? }`. 26 cases: 3 new examples (`example-bug-delete-user-idor`, `example-clean-page-param`, `example-large-reports`: 16 files, ~1,400 lines plus a lockfile, one off-by-one buried in `revenue-by-month.ts`) and the 23 earlier planted-bug PRs, ported (D19).
2. **Loading** (`evals/lib/cases.ts` → `loadCases()`): validates `case.json` with Zod (e.g. a `clean` case can't have a bug) and checks that `bug.line` is an added line in its own diff (`addedLines()`).
3. **Diff → files** (`evals/lib/diff.ts` → `parseUnifiedDiff()`): turns the diff into GitHub's file shape `{ filename, status, additions, deletions, patch }`. Checked against the real GitHub API for the 23 ported PRs: identical (D21).
4. **Run** (`evals/run.ts`, `npm run eval`): for each case × run, calls `reviewPullRequest({ title, files, contextProvider }, { llm: createGeminiLlm({ temperature: 0 }) })`, times it, and saves every review to `evals/results/<timestamp>-<label>.json` with the model, temperature and git commit. `contextProvider` is `createLocalContextProvider()` (`evals/lib/local-context-provider.ts`), which reads the fixture repo; v1 doesn't use it yet (Phase 4 will).
5. **Score** (`evals/score.ts`, `npm run eval:score`): `locationCandidates()` keeps comments on the bug's file within ±3 lines; each one goes to the judge with `buildJudgeMessages()` ("Does this comment identify this bug: <description>?"), and `parseJudgeReply()` reads YES/NO. `computeMetrics()` builds the numbers and `renderMarkdown()` writes `<run>.score.md` next to the raw file, plus `<run>.score.json` with every judge decision. All of these are pure functions in `evals/lib/scoring.ts`.
6. **Judge plumbing** (learned the hard way, see D20 and D22): verdicts are cached in `evals/results/judge-cache.json` (`judgeCacheKey()`), so a comment is judged once per judge model; calls time out after 60s and retry after 5s, 15s and 30s; if they still fail, scoring stops instead of counting a NO; `JUDGE_API_KEY` lets the judge use another Google project's free-tier quota.

**Also changed:** `createGeminiLlm()` gained `timeoutMs` and `apiKey` options (unset in production, so production behaviour is unchanged); the numbered `console.log` debug lines in `src/server/api/routers/review.ts` became one `logger.info` (missed in Phase 0).

**Files changed:**
- New: `evals/run.ts`, `evals/score.ts`, `evals/README.md`, `evals/lib/{diff,cases,local-context-provider,scoring}.ts` (+ a `.test.ts` for each), `evals/fixture-repo/**`, `evals/cases/**` (26 cases), `evals/results/` (baseline run, scores, judge cache)
- Changed: `src/server/services/ai.ts` (+ test), `src/server/api/routers/review.ts`, `package.json` (`eval`, `eval:score`), `vitest.config.mts` (runs `evals/lib` tests), `tsconfig.json` and `eslint.config.mjs` (ignore the fixture repo), `.env.example` (`JUDGE_MODEL`, `JUDGE_API_KEY`), `CLAUDE.md`, `DECISIONS.md`

**How to test:**
```bash
npm run test                                            # 83 tests, incl. every case loading
npm run eval -- --runs 1 --only example- --label try    # 3 reviews, ~10s
npm run eval:score                                      # scores the newest run; judged comments come from the cache
```
You should see a table like the one below and a `.score.md` next to the run in `evals/results/`.

**Results (v1 baseline):** see the table under "v1: Where we started". Source: `evals/results/2026-11-21T14-11-55-195Z-v1-baseline.score.md`. Spot-check (D2): I checked the 10 sampled judge decisions by hand and agreed with all 10. Of all 69 judge calls, 66 were YES and 3 were NO; the 3 NO are the same comment about `JSON.stringify` performance on the logging PR, which doesn't mention that the body contains passwords.

**Interview Q&A:**
1. **Q: Why use an LLM as a judge? Isn't that circular?**
   A: Two filters. First, code checks the location: the comment must be on the bug's file within ±3 lines, so a vague comment somewhere else can never count. Only then does a different, stronger model (`gemini-3-flash-preview`, not the reviewer's Flash-Lite) answer one narrow YES/NO question against a written bug description. Every decision is saved with its reason, and each run's report lists 10 for a human to check; if a human disagrees with more than 1 in 10, the judge gets revisited. Hand-labelling every comment is more accurate, but too slow to repeat after every change.
2. **Q: Your baseline is already 100%. What's the point?**
   A: It tells me these cases are too easy to show improvement in catch rate, which is a finding in itself. Short single-bug diffs are what v1 handles well. v2 is about large PRs and cross-file bugs, so the comparison has to come from harder cases (large PRs with buried bugs, context bugs), plus noise, tokens and latency, which this harness already measures. Without the baseline I'd have claimed "better catch rate" without evidence.
3. **Q: How do you make sure the eval tests what production actually runs?**
   A: The runner calls the same `reviewPullRequest()` the Inngest job calls, with the same Gemini client; only temperature is 0, for repeatability. Input is the same shape too: `parseUnifiedDiff()` turns each `pr.diff` into GitHub's file list, and for the 23 PRs that also exist on GitHub, the parsed result was identical to the real API response. The only gap is the webhook → Inngest → DB path, which latency here doesn't include.

## Phase 2: Diff pipeline (filter, line numbers, chunking)
**What was built:** Four small pure modules in `src/server/review/` that prepare a PR for review: drop files not worth reviewing (with a reason for each), put a line number in front of every line, estimate tokens, and pack the files into chunks under a token budget. **Nothing uses them yet:** the review still runs the v1 path; Phase 3 switches it to these modules.

**How it works:**
1. **`filter.ts` → `filterFiles(files)`** returns `{ kept, skipped: [{ file, reason }] }`. It skips: removed files; files with no `patch` (binary, too big for GitHub, or a rename with no edits); lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `go.sum`, …); anything inside a `dist/`, `build/`, `.next/`, `node_modules/` or `vendor/` folder; `*.min.js`/`*.min.css`; `*.map`; images; fonts; and files whose first 5 lines contain `@generated`. `pathSkipReason()` checks the path; `hasGeneratedHeader()` checks the patch.
2. **`annotate.ts` → `annotatePatch(patch)`** reads each `@@ -a,b +c,d @@` header to learn the starting line `c`, then counts: an added line gets `+ 45 | code`, a context line `  46 | code`, a deleted line `-    | code` (no number, since it doesn't exist in the new file). Numbers are padded so the `|` column lines up. It returns the annotated hunks and `validLines`, the set of added line numbers: the only lines a comment may point at.
3. **`tokens.ts` → `estimateTokens(text)`** is `Math.ceil(text.length / 2.5)`. The 2.5 is measured, not guessed (see Results below and D12).
4. **`chunk.ts` → `chunkFiles(files, budget = 7000)`**:
   - each file becomes a Markdown section (`renderFileSection()`: `### path (status)` plus a diff block with the annotated hunks);
   - if a section is over budget, the file is split at hunk boundaries into parts (`### path (modified, part 2 of 3)`), never in the middle of a hunk;
   - a single hunk bigger than the whole budget is skipped with reason `"hunk too large"` (the header goes in `detail`), and the file's other hunks are still reviewed;
   - sections are packed in PR order: keep adding to the current chunk, and start a new one when the next section doesn't fit ("next-fit", D23). Each chunk records its `tokens` and, per file, its `validLines`.

**Results (measured on the 26 eval cases, not a review run):**
- Filtering skips exactly one file across all cases: `package-lock.json` in the large PR. Every planted bug line still lands in a chunk.
- Chunking at the default 7,000 budget: 25 cases → 1 chunk each; the large PR → 2 chunks (8,223 estimated tokens after the lockfile is dropped).
- Token estimate vs Gemini's `countTokens` on each case's annotated diff text: 2.30–3.07 characters per token, 2.68 overall. With D12's original 3.5 the estimate was as low as 66% of the real count; with 2.5 the worst case is 92%, and typical diffs are slightly overestimated.
- For comparison, the v1 prompt for the large PR was 40,141 real tokens; 26,938 of those (two thirds) were the lockfile, which is now filtered out.

**Files changed:**
- New: `src/server/review/filter.ts`, `annotate.ts`, `tokens.ts`, `chunk.ts`, each with a `.test.ts` (54 tests in total)
- Changed: `GUIDE.md`, `DECISIONS.md`
- Not changed: `prompt.ts` still has v1's `numberPatch()` (format `L42 +code`), because the review still uses it; Phase 3 replaces it with `annotatePatch()`.

**How to test:**
```bash
npm run test          # 16 files, 137 tests
npx vitest run src/server/review/chunk src/server/review/annotate src/server/review/filter src/server/review/tokens
```
Edge cases covered by the tests: an empty patch, a single giant hunk (skipped, rest of file kept), a file that is one giant hunk (no chunk), a new file (`@@ -0,0 +1 @@`), renames (with and without edits), the `\ No newline at end of file` marker, delete-only hunks, number padding (98 → 100), and "every chunk stays within budget" on 30 mixed files.

**Interview Q&A:**
1. **Q: Why not let the model work out line numbers itself?**
   A: Counting is something code does perfectly and LLMs do badly. The model would have to add the `@@` start line to its position in the hunk while skipping deleted lines; in v1's original version, comments were often one line off. Now every line carries its number, and `validLines` lets Phase 3 drop any comment that points at a line the PR didn't add, which also removes comments on lines the model invented.
2. **Q: How did you choose 2.5 characters per token?**
   A: I measured it. The plan said 3.5, a common rule of thumb for English. I ran Gemini's free `countTokens` endpoint on the annotated diff of all 26 eval cases: code with line-number columns came out at 2.30–3.07 characters per token. At 3.5 the estimate was a third too low in the worst case. At 2.5 the worst case is 8% low, and it usually overestimates, which is the safe side for a budget. The whole-prompt numbers had looked fine (~3.7) only because the English system prompt diluted the dense diff text.
3. **Q: Why split big files at hunk boundaries, and what happens to a hunk that's too big on its own?**
   A: A hunk is one contiguous change; cutting it in half would show the model half a function and invite wrong comments. So a big file is split between hunks, and each part is labelled "part 2 of 3" so the model knows it's seeing part of a file. A single hunk bigger than the whole budget (usually a generated or pasted file) is skipped with the reason "hunk too large", and that skip is reported to the user instead of silently dropped.

## Phase 3: Parallel review, merge, summary
**What was built:** Reviews now use the Phase 2 pipeline. The PR is filtered and chunked, each chunk is reviewed by its own model call (in parallel, each one a separate Inngest step), the comments are checked against the real added lines, de-duplicated and capped, and one small extra call writes the summary and risk score from the comments alone. A bad model reply affects only its own chunk, and what wasn't reviewed is saved in `Review.meta` and shown in the UI.

**How it works:**
1. `reviewPullRequest(input, { llm, runStep? }, { chunkTokenBudget, maxComments })` in `src/server/review/review-pull-request.ts`:
   - `filterFiles()` then `chunkFiles()` (Phase 2) give the chunks and the skipped list;
   - for every chunk, in parallel: `runStep("review-chunk-<i>", () => reviewChunk(...))`. `reviewChunk()` sends `CHUNK_SYSTEM_PROMPT` (the v1 rules, plus: line numbers come from the `+ 45 | code` prefix, comment only on `+` lines, at most 5 comments) and parses the reply with `ChunkReplySchema`. If the reply isn't valid JSON or doesn't match the schema, it asks **once** more; if that fails too, the chunk is marked failed. A provider error thrown out of the step (after Inngest's retries) is caught and also marks only that chunk failed;
   - `mergeComments()` (`merge.ts`) drops comments whose line isn't an added line of that file, sorts by severity, removes duplicates (same file and category, lines within 2), and keeps the top `MAX_COMMENTS` (15);
   - `runStep("summarize", () => summarizeReview(...))` sends only the title, file list, skipped list and merged comments (never the diff) and gets `{ summary, riskScore }`. If that fails, a summary is written in code (`fallbackRiskScore()`);
   - `coverageNote()` appends "Not reviewed: …" and "N of M parts could not be reviewed" to the summary when needed.
2. `review-pr.ts` passes `runStep = step.run`, so each chunk is a retryable, memoized Inngest step, and sets `concurrency: { key: "event.data.userId", limit: 3 }` (at most 3 steps per user at once). It reads `CHUNK_TOKEN_BUDGET` and `MAX_COMMENTS` with `parsePositiveInt()` (`config.ts`) and saves `meta` (files reviewed, skipped with reasons, chunks, failed chunks and their errors, dropped-comment counts, tokens, latency) into the new `Review.meta` column. `zodValid` now means "no chunk failed".
3. `prisma/migrations/20261122120000_add_review_meta/migration.sql` adds `meta JSONB` (generated with `prisma migrate diff`).
4. `review-result.tsx` shows a **Coverage** line under the summary ("15 files reviewed in 2 parts · 1 skipped", plus the skipped files with reasons, and failed parts in red). Reviews from before v2 have no `meta` and show nothing extra.
5. Evals: `evals/run.ts` passes the same options as the job, records chunk counts per review, and wraps the model in `withRetries()` (`evals/lib/retry.ts`) so a 429 is retried like Inngest would, instead of being scored as a reviewer failure (D27).

**Files changed:**
- New: `src/server/review/merge.ts`, `config.ts` (+ tests), `evals/lib/retry.ts` (+ test), `src/components/review-result.test.ts`, `prisma/migrations/20261122120000_add_review_meta/`
- Rewritten: `src/server/review/review-pull-request.ts`, `prompt.ts` (chunk + summary prompts; v1's `numberPatch` and single prompt removed) and their tests
- Changed: `schema.ts` (`ChunkReplySchema`, `SummaryReplySchema`), `parse.ts` (`parseReply(schema, …)`), `src/server/inngest/functions/review-pr.ts` (+ test), `prisma/schema.prisma`, `src/components/review-result.tsx`, `evals/run.ts`, `evals/score.ts`, `evals/lib/scoring.ts` (+ test), `.env.example`, `CLAUDE.md`, `DECISIONS.md`

**How to test:**
```bash
npm run test                                   # 20 files, 169 tests
npx prisma migrate deploy                      # adds Review.meta to your database (run once)
npm run eval -- --label my-run && npm run eval:score
```
In the app: open a PR review; under "AI Summary" you should see the Coverage line.

**Results compared with the baseline** (26 cases × 3 runs each, reviewer `gemini-3.1-flash-lite` at temperature 0, judge `gemini-3-flash-preview`; sources: `evals/results/2026-11-21T14-11-55-195Z-v1-baseline.score.md` and `evals/results/2026-11-21T16-48-04-208Z-v2-phase3.score.md`):

| Metric | v1 baseline | v2 (Phase 3) |
|---|---|---|
| Catch rate | 100% (66/66) | **95% (63/66)** |
| … kind `bug` / `large` | 63/63 / 3/3 | 60/63 / 3/3 |
| … `race-condition` | 12/12 | 9/12 (`race-03` missed in all 3 runs) |
| Noise comments per PR | 0.23 | 0.27 |
| False alarms on clean PRs | 0/12 | 0/12 |
| Failed reviews | 0/78 | 0/78 (and 0 of 81 chunks failed) |
| Latency avg / median / p95 | 9.27s / 2.94s / 36.62s | 12.89s / 3.14s / 54.65s |
| Tokens per PR (prompt / completion) | 2,562 / 174 | **1,693** / 186 |
| Large PR: prompt tokens per review | 40,141 | **9,840** (−75%), 2 chunks, lockfile skipped |
| Comments dropped for pointing at a non-added line | n/a (not checked in v1) | 0 |

What this shows, honestly:
- **Catch rate went down by one case, not up.** v2 misses `race-03-webhook-idempotency` in every run (temperature 0 repeats the same answer). Its comment is now about a missing transaction ("partial updates if the process crashes"), a real but different issue, instead of the planted bug (two concurrent deliveries of the same event both passing the "already processed?" check). The judge said NO, and I agree. The data doesn't tell why the model's answer changed (the prompt text around the rules changed: new line format, no summary task); one case flipping isn't proof of a trend, but it is a miss.
- **The big win is on the large PR:** 75% fewer prompt tokens (the lockfile alone was two thirds of v1's prompt), the buried bug is still caught 3/3, and the review says what it skipped. The large PR also got one more comment that is noise (2 per review vs 1).
- **Small PRs got slightly more expensive and slower:** each review is now two calls (one chunk + the summary), so a typical small PR uses ~30% more prompt tokens (e.g. 1,330 vs 1,025) and the median latency rose from 2.94s to 3.14s. The p95 rose too, but that number includes 10 rate-limit retries (5–20s waits) during the v2 run and provider slowness that evening, so compare medians.
- **Robustness can't show up here:** neither version had a failed review on these cases, and v2 dropped 0 comments for invalid lines (the line-number fix from `7adbfbb` already got lines right). The value of chunk-level retries and line checks will show on larger, messier PRs. That needs harder cases.
- The v2 run was recorded at commit `83ff74f+dirty`, meaning the Phase 3 code before it was committed.
- Spot-check: I checked the 10 sampled judge decisions by hand and agreed with all 10 (8 YES, 2 NO).

**Interview Q&A:**
1. **Q: Why one Inngest step per chunk instead of `Promise.all` inside a single step?**
   A: Inngest remembers each finished step. If chunk 3 of 4 hits a rate limit, only that step is retried; the other three results are reused instead of paid for again. Each chunk also shows up separately in the Inngest dashboard. The steps still run in parallel (I start them all and `await Promise.all`), and a per-user concurrency limit of 3 stops one large PR from flooding Gemini. The review code itself doesn't import Inngest: it calls a `runStep` function that the job sets to `step.run`, and evals leave it out.
2. **Q: What happens when the model returns broken JSON?**
   A: v1's whole review failed. Now the parser first tries to recover the JSON object from stray text, then validates it with Zod. If either fails, that chunk is asked once more; if it fails again, only that chunk is marked failed, the rest of the review completes, and the summary and UI say "1 of 3 parts could not be reviewed". `zodValid` on the review is false in that case, so it's also visible in the data.
3. **Q: Why does the summary call not get the diff?**
   A: It would be the same large-prompt problem v2 is trying to fix, and it costs a lot of tokens on big PRs. The summary only needs the problems that were found and which files were (and weren't) reviewed, so the risk score is based on actual findings. The cost: it can't describe what the PR does beyond what the file names and comments show.

## Phase 4: Repo context
**What was built:** Each chunk can now see code from the rest of the repository, not just the diff: the changed file as it is after the PR, the exported signatures of files it imports, and places that call the functions it changed. This goes into the prompt as "reference only", under a token budget, so the model can catch bugs that only show up across files (a caller that now gets `null`, arguments in the wrong order, a missing `await`, dollars vs. cents). Context is best-effort: if anything fails, that piece is skipped and counted, and the review goes on.

**How it works:**
1. `buildChunkContext({ files, provider, ref, budget })` in `src/server/review/context.ts` builds the context for one chunk, in priority order (D8):
   1. the full changed file after the PR if it's under 400 lines, otherwise only the changed declarations ±20 lines;
   2. exported signatures (no bodies, JSDoc kept) of files it imports with a relative path, one level deep;
   3. call sites of exported symbols the diff changed: at most 5, 3 lines either side.

   Blocks are added while they fit `CONTEXT_TOKEN_BUDGET` (4,000); one that doesn't fit is dropped and counted, and a smaller later block may still fit. Errors from the provider are caught per block.
2. `signatures.ts` uses the TypeScript compiler API (`ts.createSourceFile`, parse only) for `exportedDeclarations`, `extractSignatures` and `relativeImports` (D9). `typescript` moved from devDependencies to dependencies, and `next.config.ts` keeps it out of the bundle.
3. The core only knows the `ContextProvider` interface (`getFile`, `findCallers`, optional `getSignatures`), so it stays pure. `reviewPullRequest()` takes an optional `contextProvider` and `ref`; `reviewChunk()` builds the context inside the chunk's step. With context, the prompt gets a `## REFERENCE ONLY` section and three extra rules; without it, the prompts are exactly the Phase 3 text (D29). Comments on reference code are dropped by `mergeComments()` anyway, since only added lines are valid.
4. Production provider: `createGitHubContextProvider()` in `src/server/services/github-context-provider.ts` reads the head commit's tree once (every path → blob SHA), fetches blobs by SHA only on a cache miss (D28), and finds callers with GitHub code search, which only covers the default branch (D10). `prismaContextCache` (`context-cache.ts`) stores file contents and signatures in the new `ContextCache` table, keyed by `(repo, blobSha, kind)`; a blob SHA names exact contents, so nothing goes stale (D11). Cache errors only cost a refetch.
5. `review-pr.ts` builds the provider with the user's GitHub token and passes `ref: pr.head.sha`. `meta.context` records whether context was on, its tokens, blocks used, blocks dropped and errors.
6. Evals: `evals/lib/apply-patch.ts` rebuilds each case's files after the PR, and `createLocalContextProvider(fixture, overrides)` serves the fixture repo with those files laid on top (D30). `npm run eval -- --no-context` turns context off for the comparison. Four new cases (`ctx-01` … `ctx-04`, kind `context`) plant bugs that can't be seen from the diff alone, with callers added to the fixture repo (`stock.ts`, `pricing.ts`, `checkout.ts`, `flags.ts`, `routes/beta.ts`, `receipts.ts`).

**Files changed:**
- New: `src/server/review/context.ts`, `signatures.ts` (+ tests), `src/server/services/github-context-provider.ts` (+ test), `context-cache.ts`, `evals/lib/apply-patch.ts` (+ test), `prisma/migrations/20261122130000_add_context_cache/`, `evals/cases/ctx-01` … `ctx-04`, six fixture files listed above
- Changed: `src/server/review/review-pull-request.ts`, `prompt.ts` (+ tests), `src/server/inngest/functions/review-pr.ts` (+ test), `prisma/schema.prisma`, `evals/run.ts`, `evals/lib/local-context-provider.ts` (+ test), `package.json`, `next.config.ts`, `.env.example`, `CLAUDE.md`, `DECISIONS.md` (D8–D11 accepted, D28–D30 new)

**How to test:**
```bash
npm run test
npx prisma migrate deploy                      # adds the ContextCache table (run once)
npm run eval -- --runs 3 --label p4-context
npm run eval -- --runs 3 --label p4-no-context --no-context
npm run eval:score -- evals/results/<file>.json   # once per run
```
In the app: open a PR review; the stored `meta.context` shows tokens and blocks used. A second push to the same PR should hit the cache for unchanged files.

**With context vs. without** (30 cases × 3 runs each, same code, only `--no-context` differs; reviewer `gemini-3.1-flash-lite` at temperature 0, judge `gemini-3-flash-preview`; sources: `evals/results/2026-11-21T18-10-51-971Z-p4-context.score.md` and `evals/results/2026-11-22T13-02-33-642Z-p4-no-context.score.md`):

| Metric | Without context | With context |
|---|---|---|
| Catch rate, all | 81% (63/78) | **88% (69/78)** |
| … kind `context` (4 new cases) | 0% (0/12) | **75% (9/12)** |
| … `argument-order` / `missing-await` / `unit-change` | 0/3 / 0/3 / 0/3 | 3/3 / 3/3 / 3/3 |
| … `ctx-01-null-stock` (new `null` return) | 0/3 | 0/3 (no comment at all) |
| … kind `bug` (the 21 Phase 3 cases) | 95% (60/63) | 90% (57/63), see `race-04` below |
| … kind `large` | 3/3 | 3/3 |
| Noise comments per PR | 0.30 | 0.30 |
| Comments on clean PRs (4 cases × 3 runs) | 0 | 6 (all medium) |
| False alarms on clean PRs (high/critical) | 0/12 | 0/12 |
| Failed reviews / failed chunks | 0/90 / 0 of 93 | 0/90 / 0 of 93 |
| Prompt / completion tokens per PR | 1,634 / 178 | **2,572** (+57%) / 192 |
| Latency median | 7.04s | 3.01s |

What this shows, honestly:
- **Context does what it was built for:** three of the four cross-file bugs go from never caught to caught in every run. Without context the model either says nothing or comments on something else (for `ctx-03`, "a DB query on every call"; for `ctx-04`, floating-point precision, not the 100× unit change).
- **`ctx-01` is missed both ways:** the reviewer posts no comment on the new `return null`, even with the caller that dereferences it in the reference section. One case doesn't say why.
- **The `race-04` drop is a scoring artifact, not a worse review.** With context, all 3 reviews flag the race correctly ("not atomic … concurrent requests could result in a negative balance"), but on the `UPDATE` line (11), while the planted bug is marked on the `SELECT` (line 6). That's 5 lines away, outside the ±3 window, so it counts as a miss before the judge sees it. I'm reporting the strict number; counted by hand it would be 60/63, the same as without context. Without context, the comment lands on line 6.
- **Cost:** 57% more prompt tokens per PR, and context makes the model a little chattier on clean PRs: 6 medium comments vs 0 (still no high/critical false alarm). Overall noise per PR is unchanged at 0.30.
- **Latency can't be compared here.** The two runs were 19 hours apart. The no-context run (smaller prompts, the same prompts as Phase 3, which had a 3.14s median) logged 13 rate-limit retries and was slower throughout, so that difference is provider-side, not context.
- The no-context run matches Phase 3 on the 21 original bug cases (60/63, `race-03` missed in all runs), as expected since D29 keeps its prompts identical.
- Spot-check: I checked the sampled judge decisions in both reports by hand and agreed with all of them.

**Interview Q&A:**
1. **Q: Why not embeddings and a vector database for repo context?**
   A: Most bugs between files are about contracts: what a function returns, what order its parameters are in, whether it's async. Signatures and call sites carry exactly that in very few tokens, and finding them is deterministic: parse the imports, search for the symbol. Retrieval would need indexing, storage and keeping the index in sync on every push, and it's harder to explain why a given snippet was chosen. The fixed priority order fits a budget and is predictable. The cost is that it only follows one level of relative imports.
2. **Q: How do you avoid downloading the same files on every push?**
   A: I read the head commit's tree once, which gives every path's blob SHA in one request. A blob SHA is a hash of the contents, so I cache contents and extracted signatures by `(repo, blobSha)` in Postgres. On a `synchronize` push most files are unchanged, so their SHAs are the same and they come from the cache. The cache never needs invalidating, because a changed file has a new SHA. If the cache fails, the provider just downloads the file.
3. **Q: What if context makes the model comment on code the PR didn't touch?**
   A: Two guards. The prompt marks it as reference only and says never to comment on it. And independently of what the model does, `mergeComments()` keeps only comments on lines the PR added, so a comment on reference code is dropped in code. The real risk is different: more text can make the model more talkative on the changed lines too, which is why the comparison measures noise and clean-PR false alarms, not just catch rate.

## Phase 5: Final state
**What was done:** No code changes. `README.md` was rewritten (what it does, a Mermaid diagram of the flow, how large PRs and repo context are handled, the results table across all four measured versions, how to run the app and the evals, limitations). This guide and `DECISIONS.md` got a final pass: statuses that still said "comes in Phase 3" were updated, and the scoring-window issue found in Phase 4 was recorded under D2.

**Architecture in one paragraph:** A PR webhook (HMAC-verified, duplicate deliveries ignored) creates a `Review` and sends an Inngest event. The job fetches the PR files and calls `reviewPullRequest()`, a pure function that filters files (skipped ones listed with a reason), annotates each patch with line numbers from code, packs files into chunks under a token budget and reviews each chunk in its own Inngest step, in parallel, with repo context from GitHub at the head commit (cached by blob SHA). Comments are kept only on real added lines, de-duplicated, sorted and capped; one more call writes the summary and risk score from the comments. A failure stays inside its chunk, and everything not reviewed is recorded in `Review.meta` and shown in the UI.

**Final results** (sources in `evals/results/`; full tables in the Phase 1, 3 and 4 sections above):

| | v1 | v2 Phase 3 | v2 no context | v2 with context |
|---|---|---|---|---|
| Catch rate | 100% (66/66) | 95% (63/66) | 81% (63/78) | **88% (69/78)** |
| Cross-file bugs | – | – | 0/12 | **9/12** |
| Large PR prompt tokens | 40,141 | **9,840** | – | – |
| Noise per PR | 0.23 | 0.27 | 0.30 | 0.30 |
| High/critical false alarms on clean PRs | 0/12 | 0/12 | 0/12 | 0/12 |
| Failed reviews | 0/78 | 0/78 | 0/90 | 0/90 |
| Prompt tokens per PR | 2,562 | 1,693 | 1,634 | 2,572 |

The first two columns ran 26 cases, the last two 30 (the 4 context cases were added in Phase 4), so compare catch rates within a pair.

**Known limitations:** listed in `README.md`. The main ones: a small eval set with one reviewer model, a judge checked only by sample, TypeScript-only signatures with one level of relative imports, code search limited to the default branch, `race-03` missed by every v2 run, `ctx-01` (new `null` return) missed with and without context, and deploy files that still reference pnpm and `OPENAI_API_KEY`.

**How to test:** `npm run lint`, `npx tsc --noEmit`, `npm run test` (24 files, 219 tests). Render `README.md` on GitHub to check the Mermaid diagram.

**Interview Q&A:**
1. **Q: Your catch rate went from 100% in v1 to 88%. Didn't v2 make it worse?**
   A: Those are different test sets. v1's 100% is on 26 single-bug PRs; the 88% includes 4 cross-file bugs added in Phase 4, which a diff-only reviewer can't see (0/12 without context). On the original cases v2 misses one race condition in every run, which I report as a real miss. The wins are elsewhere: 75% fewer tokens on a large PR with the bug still caught, failures contained to one chunk, coverage reported, and 9 of 12 cross-file bugs caught. The honest summary: on easy PRs v1 was already good, and v2 is about large PRs, robustness and context.
2. **Q: How do you know your eval numbers mean anything?**
   A: Partly they don't, and I say so: 30 cases, one model, so one case flipping moves the rate by about 4 points. What makes them usable: every bug has a known file and line, a comment must be near it *and* a judge must agree on the content, I hand-check a sample of judge decisions every run, judge failures abort the scoring instead of counting as misses, and the with/without-context comparison changes exactly one flag with identical prompts otherwise. I also found and documented a scoring artifact (a correct comment 5 lines from the marked line) instead of tuning it away after seeing the result.
3. **Q: What would you do next?**
   A: Fix the deploy files, then grow the eval set with real PRs from open-source repos, since the hand-written cases are too easy to show differences. Then look at the two consistent misses (`race-03`, `ctx-01`), resolve path-alias imports for context, and measure whether a stronger reviewer model is worth its cost on the context cases. I'd also judge comments by the code range they mention rather than a fixed ±3-line window.

---

## Section template (use this for every phase)

```md
## Phase N: <name>
**What was built:** 2–4 sentences, plain language.
**How it works:** step by step, naming the files and functions.
**Files changed:** list.
**How to test:** exact commands + what you should see.
**Results:** (if evals were run) table.
**Interview Q&A:**
1. Q: … A: …
2. Q: … A: …
3. Q: … A: …
```