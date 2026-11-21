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
_(filled by Claude Code)_

**Results compared with the baseline:** _(table)_

## Phase 4: Repo context
_(filled by Claude Code)_

**With context vs. without:** _(table)_

## Phase 5: Final state
_(architecture summary, final results, known limitations)_

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