# DECISIONS.md — Design decisions and tradeoffs

Each entry covers: the problem, the options considered, what was chosen and why, what it costs, and when to revisit it.
Status: **Proposed** (agreed in planning, not built yet) → **Accepted** (built and checked) → **Revised** (changed later; the old reasoning is kept below the new one).

---

## D1. Build the eval harness before any improvement
**Status:** Accepted (Phase 1). `evals/run.ts` + `evals/score.ts`; v1 baseline recorded in GUIDE.md.
**Problem:** Without measurement, "v2 is better" is just a claim.
**Options:**
- A. Improve first, test by hand on a few PRs
- B. **Build evals first, record a v1 baseline, measure every change** ✅
**Why B:** Every later decision (chunk size, context, comment limit) needs before-and-after numbers. A baseline is also the only honest source for resume metrics.
**Tradeoff:** About 1.5 days spent before any visible feature. The fixture set is small (~25 cases), so results are noisy. Mitigated by running 3 times and averaging.
**Revisit when:** The dataset grows past ~100 cases; then consider real public PRs with known fix commits.

## D2. Scoring: location match + LLM judge
**Status:** Accepted (Phase 1). `locationCandidates()` (±3 lines) then `JUDGE_MODEL` YES/NO, in `evals/lib/scoring.ts`; 10 decisions per run listed for a hand spot-check in `<run>.score.md`.
**Options:**
- A. Manual labelling of every comment: accurate, but too slow to run after every change
- B. Location only (same file, ±3 lines): fast, but counts unrelated comments near the bug
- C. **Location filter, then LLM judge yes/no on content, with a manual spot-check of ~10 decisions per run** ✅
**Why C:** Cheap enough to run every time, and the location filter keeps the judge from approving vague comments.
**Tradeoff:** The judge can be wrong. A separate `JUDGE_MODEL` setting lets the judge be stronger than the reviewer; the spot-check catches it drifting.
**Revisit when:** The spot-check disagrees with the judge on more than 10% of decisions.
**Notes (Phase 1):**
- "Noise" means every comment that matches no planted bug. That includes real issues the reviewer found that we didn't plant, so noise is an upper bound on junk, not a count of wrong comments. The older `evals/planted-bugs/` harness split these by hand (valid / useless / false); that is too slow to repeat for every change, so the automated number is used for before/after comparisons and the hand labels stay as a one-off quality check.
- **Found in Phase 4: the ±3-line window can reject a correct comment.** In the with-context run, all 3 reviews of `race-04-wallet-debit` describe the race correctly but put the comment on the `UPDATE` (line 11), while the bug is marked on the `SELECT` (line 6). They count as misses before the judge sees them. I kept the strict result rather than changing the scorer after seeing it. Revisit: let a case mark a line *range* for the bug, or widen the window for multi-line bugs, and re-score all runs with the same rule.
- A judge call that fails (after one retry) stops the scoring. Counting it as NO would quietly lower the catch rate. This happened on the first smoke run: every call returned 404 and the catch rate showed 0%.

## D3. Split the diff into chunks by token budget
**Status:** Accepted (Phase 2: `chunkFiles()` in `src/server/review/chunk.ts`; used for every review since Phase 3). Measured (Phase 3): the large eval PR went from 40,141 to 9,840 prompt tokens per review (2 chunks, lockfile skipped), and its buried bug was still caught 3/3. No cross-chunk miss has shown up in the evals yet, but the large-PR cases are few.
**Problem:** One prompt per PR loses quality on big PRs and makes a single failure fatal.
**Options:**
- A. One prompt for the whole PR (v1): simplest; Gemini's context is large enough. But quality drops for content buried in a long prompt, and the 5-comment limit is shared across the whole PR.
- B. One call per file: simple, but 40 small files means 40 calls (cost, rate limits), and each call sees very little.
- C. **Pack files into chunks under a token budget (~7k); split oversized files at hunk boundaries** ✅
**Why C:** Each call stays small enough for focused attention, and the number of calls grows with diff size, not file count. Splitting at hunk boundaries never cuts a change in half.
**Tradeoff:** A bug that spans two files in different chunks can be missed (partly fixed by repo context, D8). More calls means more latency in total, but they run in parallel (D5).
**Revisit when:** The eval shows cross-chunk misses; then try grouping files by directory or by import relationships.

## D4. Line numbers are computed in code, not guessed by the model
**Status:** Accepted (Phase 2: `annotatePatch()` returns the `+ 45 | code` text and `validLines`; Phase 3: `mergeComments()` drops comments on lines that aren't valid added lines). Measured: 0 comments dropped for an invalid line in all v2 runs (the v1 line-numbering fix already got lines right on these small cases).
**Options:**
- A. Let the model work out line numbers from `@@` headers (v1)
- B. **Parse the hunks, put the new-file line number in front of every line, and drop comments on lines that aren't valid added lines** ✅
**Why B:** Counting is something code does perfectly and LLMs do badly. Checking comments against valid lines also removes comments the model invented for lines that don't exist.
**Tradeoff:** More prompt tokens (about 6 extra characters per line). A real issue on an unchanged context line gets dropped. That's acceptable, since we only review what the PR changed.
**Revisit when:** Never, really. Maybe let comments on context lines through as a "note" severity.
**Note (Phase 0):** Half of this is already in the v1 baseline (D18): `numberPatch()` prefixes lines as `L42 +code`. Still to do in Phase 2: the `+ 45 | code` format in `annotate.ts`, the valid-line set, and dropping comments on invalid lines.

## D5. One Inngest step per chunk, run in parallel
**Status:** Accepted (Phase 3). `review-chunk-<i>` steps via the `runStep` hook (D25), plus `concurrency: { key: "event.data.userId", limit: 3 }`. Inngest's concurrency limit counts steps executing at once, per key value, so one user's big PR runs at most 3 model calls at a time.
**Options:**
- A. `Promise.all` inside one `step.run`: simple, but one failure retries every chunk
- B. **One `step.run` per chunk, run in parallel, plus a concurrency limit keyed by user** ✅
- C. A separate Inngest function per chunk (fan-out with events): most scalable, harder to follow
**Why B:** Retries happen per chunk, results are saved per chunk (a successful chunk is never recomputed), and each step is visible in the Inngest dashboard. The concurrency limit protects against Gemini rate limits.
**Tradeoff:** Each step's output is stored by Inngest; fine at this size. Total latency is set by the slowest chunk.
**Revisit when:** PRs regularly produce 20+ chunks; then consider option C.

## D6. Never let one chunk fail the whole review
**Status:** Accepted (Phase 3). `reviewChunk()` asks once more after an invalid reply, then marks the chunk failed; a provider error that survives Inngest's step retries is caught around the step and also marks only that chunk failed. `zodValid` is now "no chunk failed".
**Choice:** Wrap the JSON parse in try/catch, retry once on invalid JSON, and if that fails, mark only that chunk as failed. The review completes, and coverage is shown in `meta` and the UI.
**Why:** A partial review that says it's partial is more useful than a FAILED status. v1 failed completely on one cut-off response.
**Tradeoff:** Users might miss the coverage warning. Mitigated by showing it in the UI, not just storing it.

## D7. Summary pass gets comments only, not the diff
**Status:** Accepted (Phase 3). `summarizeReview()` + `SUMMARY_SYSTEM_PROMPT`. If the call fails, a summary and risk score are built in code (`fallbackRiskScore()`), and `meta.summaryFallback` is set.
**Options:**
- A. Combine chunk summaries in code
- B. Send the whole diff again for the summary: expensive, and the same large-prompt problem as v1
- C. **One small call with the merged comments, the file list and the skipped list** ✅
**Why C:** Cheap, always fits in context, and the risk score is based on the problems actually found.
**Tradeoff:** The summary can't describe what the PR does beyond what the comments and file names show. Fix if needed: add each chunk's one-line summary.

## D8. Repo context, in priority order, under a budget
**Status:** Accepted (Phase 4). `buildChunkContext()` in `src/server/review/context.ts`, run inside each chunk's step. "Full changed file" means the file **after** the PR (at the head commit). Blocks are added in priority order while they fit `CONTEXT_TOKEN_BUDGET`; a block that doesn't fit is dropped, and a smaller lower-priority block may still fit after it. Only relative imports are followed; path aliases such as `@/` are not resolved yet.
**Options:**
- A. Diff only (v1)
- B. Full contents of every related file: too many tokens, and it buries the changes
- C. Embeddings and retrieval (vector DB over the repo): powerful, but needs indexing, storage and keeping the index in sync. Too much for the time available.
- D. **Fixed priority order: full changed file → exported signatures of imported files (one level deep) → call sites of changed exports; cut from the bottom when over `CONTEXT_TOKEN_BUDGET`** ✅
**Why D:** Most bugs between files are about contracts (types, return values, parameters), and signatures carry those in very few tokens. It's predictable, fits a budget, and is easy to explain.
**Tradeoff:** Only one level of imports, so deeper effects are missed. Non-relative imports (path aliases like `@/`) need handling for the alias. Non-TS files only get the full changed file.
**Revisit when:** The eval shows context-bug misses that need deeper call chains.

## D9. Extracting signatures: TypeScript compiler API
**Status:** Accepted (Phase 4). `src/server/review/signatures.ts` (`ts.createSourceFile`, parse only, no type checking). JSDoc is kept with each signature, because it often carries the contract ("null until onboarding").
**Note (Phase 4):** `typescript` was a *devDependency*, not a dependency as this entry assumed. Since the review now imports it at runtime, it moved to `dependencies` (same package and version, nothing new installed; `@prisma/client` already listed it as a peer). `next.config.ts` marks it as a server-external package, so Next loads it from `node_modules` instead of bundling the ~9 MB compiler (checked: the build links it as an external).
**Options:**
- A. Regex: fast to write, breaks on multi-line signatures and generics
- B. tree-sitter: works for many languages, but a new native dependency
- C. **TypeScript compiler API (`ts.createSourceFile`)** ✅
**Why C:** `typescript` is already a dependency, it parses TS and JS correctly, and there's nothing new to install.
**Tradeoff:** Only TS and JS. Other languages get no signature context.

## D10. Finding callers: GitHub code search vs. a shallow clone
**Status:** Accepted (Phase 4): option A, code search. Checked on the private test repo: works with the existing `repo` OAuth scope, rate limit 10 requests/minute. As expected, a function added in the PR itself has no callers on the default branch. A search failure (e.g. rate limit) only drops that call-site block; it never fails the chunk.
**Options:**
- A. **GitHub code search API**: no disk or git needed in the container. But it only searches the default branch, has its own strict rate limit, and doesn't search very large files.
- B. Shallow clone (`git clone --depth 1` at the head SHA) + grep: exact and searches the PR's branch. But it needs git in the Docker image, disk space, and takes several seconds per review.
**Leaning:** A for v2, limited to 5 call sites, behind the `ContextProvider` interface so B can replace it later without touching the pipeline.
**Tradeoff:** Default-branch search misses callers added in the PR itself (they're in the diff anyway) and can show outdated call sites.

## D11. Caching by blob SHA
**Status:** Accepted (Phase 4). Prisma model `ContextCache` with primary key `(repo, blobSha, kind)`, where `kind` is `"file"` or `"signatures"` (so both can be cached for one blob). Migration `20261122130000_add_context_cache`. The cache is passed into the GitHub provider, and cache errors only cost a refetch.
**Choice:** Cache file contents and extracted signatures in Postgres, keyed by `(repo, blobSha)`.
**Why:** A blob SHA identifies the exact contents, so the cache never goes stale and needs no invalidation. On `synchronize` events most files haven't changed, so they come from the cache. We already use Postgres, so there's no Redis to run.
**Tradeoff:** The table grows over time. Add a cleanup job (delete entries older than 30 days) if it matters.

## D12. Estimating tokens with a heuristic
**Status:** Revised (Phase 2): the method stays, the ratio changed from 3.5 to **2.5 characters per token**. The original reasoning is kept below.

**Revision (Phase 2):** I measured instead of assuming. On the annotated diff text of all 26 eval cases, Gemini's `countTokens` gave 2.30–3.07 characters per token (2.68 overall). Diffs are denser than prose: symbols, short identifiers, and now the line-number column. At 3.5 the estimate was as low as 66% of the real count, much more than the planned ~15% safety margin. At 2.5 the worst case is 92%, and typical diffs are overestimated by a few percent (the safe side). Whole v1 prompts had measured ~3.7 only because the English system prompt diluted the diff. Tradeoff: chunks hold about 30% less text than they would at 3.5; with a 7,000 budget that's still ~17k characters of diff per chunk. Revisit when: other languages or file types dominate real PRs; re-measure with the same script against `countTokens`.

**Original (superseded ratio):**
**Options:**
- A. Gemini `countTokens` API: exact, but an extra network call per chunk
- B. `js-tiktoken`: that's OpenAI's tokenizer, so it's an approximation for Gemini anyway, plus a dependency
- C. **`Math.ceil(chars / 3.5)`, with budgets set ~15% below the real limit** ✅
**Why C:** The budget only needs to be roughly right. No dependency, no network call, and easy to explain.
**Tradeoff:** Code with many symbols uses more tokens than the estimate suggests; the safety margin covers that.
**Revisit when:** Requests start failing for being too long, or chunks are clearly much smaller than needed.

## D13. Keep Gemini Flash-Lite, but make the model configurable
**Status:** Accepted for `REVIEW_MODEL` (Phase 0: `options.model || REVIEW_MODEL || "gemini-3.1-flash-lite"`; `||` so an empty value in `.env` falls back). `JUDGE_MODEL` comes in Phase 1.
**Choice:** `REVIEW_MODEL` env var, default `gemini-3.1-flash-lite`; a separate `JUDGE_MODEL` for evals.
**Why:** It's cheap and fast, and with chunking a small model sees small, focused prompts. Making it configurable lets the eval compare models instead of guessing.
**Tradeoff:** A small model catches fewer subtle bugs. Use the eval to decide whether a bigger model is worth the cost.
**Note:** The resume must say Gemini, not GPT-4o-mini. The code uses Gemini.

## D14. Comment limits: 5 per chunk, 15 total, highest severity first
**Status:** Accepted (Phase 3). 5 per chunk in the prompt; `mergeComments()` drops comments not on an added line, removes duplicates (same file and category, lines within 2; the most severe copy is kept), sorts by severity and keeps `MAX_COMMENTS` (default 15).
**Why:** Too many comments and nobody reads them. Ranking by severity keeps the important ones.
**Tradeoff:** On a very large PR, low-severity issues get dropped. That's on purpose.
**Revisit when:** The eval shows real bugs being cut by the limit.

## D15. Keep the review core pure (dependency injection)
**Status:** Accepted (Phase 0). `reviewPullRequest(input, { llm })` in `src/server/review/review-pull-request.ts`; the only SDK code is `createGeminiLlm()` in `src/server/services/ai.ts`. See D17 for the shape of `llm`.
**Choice:** `src/server/review/*` takes data, a `ContextProvider` and an `llm` function. It never imports Prisma, Inngest or `fetch`.
**Why:** The same code runs in production (GitHub provider) and in evals (local provider), and unit tests need no network calls.
**Tradeoff:** A bit more wiring in `review-pr.ts`.

## D16. A tiny hand-written logger instead of a logging library
**Status:** Accepted (Phase 0)
**Problem:** v1 printed the raw model response with `console.log` on every review. That's noisy, and the output can contain the user's code.
**Options:**
- A. Delete the logging: quietest, but nothing to look at when a review goes wrong
- B. A library (pino, winston): structured logs and transports, but a new dependency and config for a few log lines
- C. **`src/server/lib/logger.ts`: four functions (`debug/info/warn/error`), a level order, and a check against `LOG_LEVEL` (default `info`)** ✅
**Why C:** About 30 lines, no dependency, easy to explain. Raw output is still available for debugging with `LOG_LEVEL=debug`.
**Tradeoff:** Plain text lines with JSON fields appended, not structured JSON logs; no log shipping.
**Revisit when:** Logs need to go to a log service or be queried; then swap the four functions for pino.

## D17. The `llm` dependency is a plain function, not the SDK client
**Status:** Accepted (Phase 0)
**Problem:** D15 says the core gets the model passed in. What exactly gets passed?
**Options:**
- A. Pass the OpenAI client object: tests must fake the SDK's nested shape (`chat.completions.create`) and the core learns provider details (`response_format`, `max_tokens`, `choices[0].message`)
- B. An interface with a class per provider: more structure than one provider needs
- C. **`type Llm = (messages) => Promise<{ content, model, promptTokens, completionTokens, finishReason }>`** ✅
**Why C:** The core only needs "send messages, get text and token counts back". A fake for tests is a one-line `async` function. Provider settings (JSON mode, `max_tokens: 3000`, temperature) stay in `createGeminiLlm()`, next to the SDK.
**Tradeoff:** Temperature and model are fixed when the function is created, not per call. That's fine, since one review uses one setting. Adding the Phase 3 retry-on-bad-JSON goes in the core, not in `llm`.
**Revisit when:** A call needs per-request options (e.g. a different `max_tokens` for the summary pass in Phase 3); then add an optional second argument.

## D18. Which code counts as "v1" for the baseline
**Status:** Accepted (Phase 0, chosen by the owner)
**Problem:** Commit `7adbfbb` (made before v2 planning) already changed the reviewer: line-numbered diffs (`numberPatch`), a stricter prompt that allows zero comments, and JSON recovery when the model adds stray text. GUIDE's v1 description was written about the older code.
**Options:**
- A. Revert `ai.ts` to the older code and baseline that: the cleanest before/after story, and Phases 2–3 rebuild those fixes as proper modules
- B. **Keep the current `ai.ts` as v1** ✅
**Why B:** Owner's call: less churn, and the current code is what actually runs. The earlier planted-bug eval (`evals/planted-bugs/report-baseline.md` vs `report.md`) already records what those changes bought on that dataset.
**Tradeoff:** The Phase 1 baseline already includes part of D4 and D6, so the gain measured in Phase 3 will be smaller than "v2 vs. the original code". Be clear about this in the README and resume: compare against the Phase 1 baseline only.
**Revisit when:** If a before/after against the original code is ever needed, check out the commit before `7adbfbb` and run the Phase 1 harness on it.

## D19. Eval cases: one fixture repo + `pr.diff` per case, reusing the 23 planted-bug PRs
**Status:** Accepted (Phase 1)
**Problem:** The brief asked for 3 example cases, but a baseline on 3 cases is mostly noise. `evals/planted-bugs/` already had 23 PRs with known bugs on a GitHub test repo.
**Options:**
- A. Only the 3 examples; add more later
- B. **3 new examples (bug, clean, large) + port the 23 planted-bug PRs to the new format** ✅ (owner's choice)
- C. Keep running the planted-bug harness against GitHub
**Why B:** 26 cases from day one, no GitHub needed. The fixture repo is the planted-bug base code, unchanged, plus one API route (`src/routes/users.ts`), so the 23 diffs apply exactly. The parsed diffs were checked against the real GitHub API responses for those PRs: identical on 23/23.
**Tradeoff:** 13 source files instead of "about 8–10". The 23 ported cases are short, single-purpose PRs, so they are easier than real PRs. Only one `large` case so far. `bug.line` is a single line, so for bugs that span two lines (e.g. read then write in a race) the first line is used and comments on the second line only count if they're within ±3.
**Revisit when:** The owner adds harder cases (context bugs, more large PRs) and the catch rate stops being near 100%.

## D20. Judge model: `gemini-3-flash-preview`
**Status:** Revised twice in Phase 1. Current: `gemini-3-flash-preview`. The older reasoning is kept below.

**Revision 2 (current):** With the owner's new API key, `gemini-3.5-flash` didn't respond at all (requests hung past 60s, then 868s), and on the free tier it allows only 20 requests/day per project. `gemini-3-flash-preview` answered in ~2s. Chosen because it keeps the same intent (Flash tier, stronger than the reviewer, not the reviewer itself). Tradeoff: it's a preview model, so Google may change or retire it; the model name is part of the judge cache key, so a new judge starts with an empty cache, and results scored by different judges shouldn't be compared directly. Revisit when a stable Flash model works on this key.

**Revision 1 (superseded):**
**Problem:** `gemini-2.5-flash` and `gemini-2.5-pro` return 404 "no longer available to new users" on this API key.
**Options:** A. `gemini-3.5-flash` ✅ / B. `gemini-3.1-pro-preview` (stronger, a preview, slower) / C. `gemini-3.1-flash-lite` (the reviewer itself)
**Why A:** Same intent as the original pick: a stable Flash-tier model a step stronger than the reviewer, cheap and fast. Not the same model as the reviewer, so it isn't grading its own output (D2).
**Tradeoff:** Judge calls cost a bit more than Flash-Lite; there are only a few per run because the location filter runs first.
**Revisit when:** The spot-check shows the judge disagreeing with a human on more than 1 in 10 decisions; try a Pro model.

## D22. Free-tier judge limits: cache verdicts on disk + a separate `JUDGE_API_KEY`
**Status:** Accepted (Phase 1)
**Problem:** The free Gemini tier allows 20 requests per model per day per Google project. Scoring the baseline needed 23 judge calls, and every later phase needs more. The first scoring attempts died on 429 errors, and an aborted run lost every verdict it had already received.
**Options:**
- A. Enable billing: simplest, but the owner wants to stay on the free tier
- B. Use the reviewer model as judge: higher limits, but it grades its own work (D2)
- C. **Cache verdicts on disk (`evals/results/judge-cache.json`) and allow a second key (`JUDGE_API_KEY`) from another project** ✅
**Why C:** A verdict depends only on the judge model, the bug and the comment text (`judgeCacheKey()`), so caching it is safe. At temperature 0 the reviewer repeats itself, so most comments are already judged: the baseline needed 23 calls for 69 judgements, and re-scoring it costs 0 calls. The cache is written after every call, so an aborted run keeps its progress. A separate key gives the judge its own daily quota without touching the reviewer's.
**Tradeoff:** One more env var. The cache is committed, so it grows with every new comment text (a few KB per run). Changing a case's `description` invalidates its cached verdicts, which is correct, since the question changed.
**Revisit when:** On a paid tier, the cache is still worth keeping (speed, repeatability); the second key isn't needed.

## D21. Evals parse `pr.diff` into GitHub's file shape
**Status:** Accepted (Phase 1)
**Problem:** Production gets files from GitHub's "list PR files" API; evals have a `git diff`. If the two differ, the eval measures a different input than production.
**Choice:** `parseUnifiedDiff()` (`evals/lib/diff.ts`) splits the diff per file and produces `{ filename, status, additions, deletions, patch }`, where `patch` starts at the first `@@` like GitHub's. Binary files and pure renames get no `patch`, as on GitHub.
**Why:** The reviewer gets exactly what it would get in production. Verified identical to the GitHub API on the 23 ported PRs.
**Tradeoff:** A hand-written parser to maintain (about 50 lines, unit-tested: new, deleted, renamed, binary, no-newline marker).

## D23. Packing order: next-fit in PR order
**Status:** Accepted (Phase 2)
**Problem:** D3 says "pack files into chunks under a budget", but not in what order.
**Options:**
- A. **Next-fit in PR order: add sections to the current chunk; when the next one doesn't fit, start a new chunk** ✅
- B. First-fit decreasing (sort by size, put each into the first chunk with room): fewer chunks in theory
- C. Group by directory or by imports, then pack
**Why A:** Simplest to explain and test. Files stay in the order GitHub lists them (alphabetical by path), so related files in the same folder usually land together, and a split file's parts stay next to each other. On the eval cases it gives the minimum possible number of chunks anyway (1 for small PRs, 2 for the large one).
**Tradeoff:** Can use a few more chunks than B when sizes are very uneven, and a chunk may be closed early with room to spare. Cross-folder relationships are ignored (that's what D3's "revisit" and D8's repo context are for).
**Revisit when:** Real PRs regularly produce many half-empty chunks (compare `sum(tokens) / (chunks × budget)`), or the eval shows misses where related files ended up in different chunks.

## D24. File filter rules and their limits
**Status:** Accepted (Phase 2)
**Choice:** `filterFiles()` skips removed files, files with no patch, lockfiles, files under `dist/`, `build/`, `.next/`, `node_modules/` or `vendor/` (any folder level), `*.min.js`/`*.min.css`, `*.map`, images, fonts, and files with `@generated` in their first 5 lines. Every skip has a reason.
**Why:** These files cost tokens and never get a useful review. In the large eval PR, the lockfile alone was two thirds of the v1 prompt (26,938 of 40,141 tokens).
**Tradeoffs:**
- `@generated` can only be seen when the patch includes the top of the file (new files, or edits near line 1). A generated file edited only further down is still reviewed.
- Folder names are matched exactly, so `src/build.ts` and `docs/distribution.md` are kept, but a hand-written folder that happens to be called `build/` or `vendor/` is skipped.
- Removed files are skipped, so a deletion that breaks callers isn't reviewed here; Phase 4's call sites partly cover that.
**Revisit when:** Users see real code listed under "skipped", or generated files keep getting reviewed; then add a repo config (e.g. a `.prreviewignore` list).

## D25. Inngest steps through a `runStep` hook, not inside the core
**Status:** Accepted (Phase 3)
**Problem:** D5 wants each chunk to be an Inngest step, but D15 says the core must not import Inngest, and evals must run the same code without Inngest.
**Options:**
- A. Put the chunk loop in `review-pr.ts` and call the pieces (`filterFiles`, `chunkFiles`, `reviewChunk`, …) from there: evals would need a copy of that loop
- B. **`reviewPullRequest(input, { llm, runStep? })`: the core calls `runStep("review-chunk-<i>", fn)`; the job passes `step.run`, evals and tests pass nothing (it just calls `fn`)** ✅
**Why B:** One code path for production and evals, and the core stays pure: `runStep` is just a function parameter, like `llm`. The planning work (filter, chunk) is deterministic, so Inngest re-running the function body between steps recomputes exactly the same chunks.
**Tradeoff:** Step results must be plain JSON (Inngest stores them), so chunk results use arrays, not `Set`s. Time measured with `Date.now()` around the whole function is meaningless under Inngest replays, hence D26.
**Revisit when:** The pipeline needs steps with different retry or timeout settings; then the hook would need options.

## D26. `meta.latencyMs` = slowest chunk + summary
**Status:** Accepted (Phase 3)
**Problem:** Under Inngest, the function body re-runs after every step, so a timer around `reviewPullRequest` measures one replay, not the review.
**Choice:** Each step measures its own model time; `meta.latencyMs` is the slowest chunk plus the summary call, which is the model time on the critical path when chunks run in parallel. End-to-end time (webhook to saved review) is still `completedAt - receivedAt` in the DB. The eval runner reports wall time around `reviewPullRequest()` separately.
**Tradeoff:** It leaves out queueing and the 3-steps-per-user concurrency limit, so on a PR with more than 3 chunks the real wait is longer.

## D27. Evals retry provider errors, like Inngest does
**Status:** Accepted (Phase 3)
**Problem:** In production a 429/503 from Gemini fails the step and Inngest retries it (`retries: 2`). In evals nothing retried, so a rate limit would be scored as a failed chunk, a reviewer failure that has nothing to do with review quality. v2 makes more calls (chunks + summary), so it hits rate limits more often than v1.
**Choice:** `withRetries(llm)` (`evals/lib/retry.ts`) retries a thrown provider error after 5s and 20s, then gives up, which is the same number of attempts as Inngest. Invalid output is not retried here; that's D6's job inside the core.
**Tradeoff:** Retries make eval latency numbers include backoff waits when they happen; they're logged during the run.

## D28. GitHub provider: one tree call, then blobs by SHA
**Status:** Accepted (Phase 4)
**Problem:** The cache is keyed by blob SHA, but the contents API returns the SHA only *after* downloading the file, so it can't be checked first. Resolving an import (`./db` → `src/db.ts`? `src/db/index.ts`?) would also cost a request per candidate path.
**Options:** A. Contents API per file / B. **Read the head commit's tree once (`git/trees/<sha>?recursive=1`, every path → blob SHA), then fetch `git/blobs/<sha>` only on a cache miss** ✅
**Why B:** One request answers "does this path exist?" for every import candidate, and every file read can check the cache before downloading anything. On a `synchronize` push, unchanged files are cache hits.
**Tradeoff:** For very large repos GitHub truncates the recursive tree (over 100,000 entries); files missing from a truncated tree are treated as absent, so they get no context. Files over 512 KB are skipped as context.
**Revisit when:** Reviews on large monorepos show missing context; then fall back to the contents API for paths not in a truncated tree.

## D29. Context changes the prompt only when there is context
**Status:** Accepted (Phase 4)
**Choice:** With context, the diff goes under `## CHANGED CODE` and a `## REFERENCE ONLY` section follows, and the system prompt gains three "Repository context" rules (use it to check callers and contracts; never comment on it). Without context, both prompts are exactly the Phase 3 text.
**Why:** The `--no-context` eval then measures Phase 3 exactly, so "with vs. without context" isolates the effect of context instead of mixing in prompt wording changes. Comments on reference code are dropped anyway by `mergeComments()` (D4), because only added lines are valid.
**Tradeoff:** Two prompt variants to maintain.

## D30. Evals read context from "the repo after the PR"
**Status:** Accepted (Phase 4)
**Problem:** The fixture repo is the code *before* each PR, but production context is read at the PR's head commit.
**Choice:** For each case, `applyPatch()` (`evals/lib/apply-patch.ts`) rebuilds its changed files from the fixture plus `pr.diff`, and `createLocalContextProvider(fixture, overrides)` lays them over the fixture (deleted files hidden). Checked: `applyPatch()` reproduces all 50 changed files of the 26 cases exactly as on their real git branches.
**Tradeoff:** Local `findCallers` searches the post-PR files, so it *can* find callers added in the same PR, which GitHub code search (default branch only) can't. Evals may therefore show slightly more call sites than production would.

---

## Template for new entries

```md
## DN. <title>
**Status:** Proposed | Accepted | Revised
**Problem:** …
**Options:** A … / B … / C …
**Choice + why:** …
**Tradeoff:** …
**Revisit when:** …
```