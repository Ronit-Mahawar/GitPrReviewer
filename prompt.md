# Prompt for Claude Code — GitPrReviewer v2

> Paste everything below the line into Claude Code, run from the repo root.
> Put `CLAUDE.md`, `GUIDE.md` and `DECISIONS.md` in the repo root first.

---

Read `CLAUDE.md`, `GUIDE.md` and `DECISIONS.md` first. They describe the project, the rules, and the design decisions already made for v2.

## Goal

Build v2 of GitPrReviewer. It should review **large PRs** accurately and say what it skipped. It should use **context from the rest of the repo**, not just the diff. And every change should be **measured** by an eval harness, so I can quote real numbers.

I'm a student preparing for placement interviews and I have to be able to explain every line of this project. So:

- Work **one phase at a time**. At the end of each phase, **stop**. Tell me what changed, which files changed, and how to test it, then wait for me to say "next".
- Keep the code simple and readable. Don't add clever abstractions, new frameworks or dependencies unless `DECISIONS.md` allows them. If you think one is needed, ask first.
- After each phase, add a section to `GUIDE.md`: what was built, how it works (in plain language), and how to run or test it. Also add 3 interview questions someone could ask about that phase, with short answers.
- When you make a design choice that isn't already in `DECISIONS.md`, add a new entry in the same format: options, choice, why, tradeoff, when to revisit. If you change your mind about an existing decision, update that entry and explain why. Don't delete the old reasoning.
- Run `npm run lint`, `npx tsc --noEmit` and the tests before saying a phase is done.

## Phase 0: Cleanup and testability

1. Remove the commented-out debugging code and the `console.log` calls of raw model responses in `src/server/services/ai.ts`. Add a tiny logger (`src/server/lib/logger.ts`) that only logs debug output when `LOG_LEVEL=debug`.
2. Make the model configurable: `REVIEW_MODEL` env var, defaulting to the current `gemini-3.1-flash-lite`. Add it to `.env.example`.
3. Separate the review logic from Inngest, GitHub and the DB. The core should be a pure function that takes PR files and returns a review:
   `reviewPullRequest(input: { title, files, contextProvider? }, deps: { llm }) => ReviewResult & { meta }`
   The Inngest function and the eval runner both call it.
4. Add **Vitest** and a `test` script. Write unit tests for every pure helper from now on.
5. Don't change behaviour in this phase. v1 output must stay the same.

## Phase 1: Eval harness (build this BEFORE the improvements)

1. Create `evals/` with:
   - `evals/fixture-repo/`: a small realistic TS codebase (about 8–10 files: an API route, a users service, a DB layer, utils, types).
   - `evals/cases/<id>/`: each case has a `pr.diff` (a unified diff against the fixture repo) and a `case.json`: `{ id, title, kind: "bug" | "clean" | "context" | "large", bug?: { file, line, category, description } }`.
   - **Only make 3 example cases** (one bug, one clean, one large), so the format is clear. I'll write the remaining planted bugs myself. Add a `evals/README.md` explaining how to add a case.
2. `evals/run.ts` (run with `npm run eval`):
   - Calls `reviewPullRequest` directly. No GitHub, no Inngest.
   - Uses a `LocalContextProvider` that reads files from `evals/fixture-repo/`.
   - `--runs 3` (default 3); temperature 0.
   - Saves raw output to `evals/results/<timestamp>-<label>.json`.
3. Scoring (`evals/score.ts`):
   - A comment **matches** a bug if it's in the same file, within ±3 lines, and an LLM judge (model set by `JUDGE_MODEL`) answers YES to "Does this comment identify this bug: <description>?"
   - Metrics: catch rate (overall and by `kind`/category), noise comments per PR, false alarms on clean PRs (any critical/high comment), failed reviews, average and p95 latency, tokens per PR.
   - Print a markdown table, and save it next to the raw results.
4. Run it on the current (v1) pipeline and record the **baseline** in `GUIDE.md`.

## Phase 2: Diff pipeline (filter, line numbers, chunking)

Create `src/server/review/` with small pure modules:

1. `filter.ts`: skip lockfiles, `dist/`, `build/`, `.next/`, `node_modules/`, `vendor/`, minified files, source maps, images and fonts, files with an `@generated` header, removed files, and files without a `patch`. Return `{ kept, skipped: [{ file, reason }] }`.
2. `annotate.ts`: parse the `@@ -a,b +c,d @@` hunk headers and put the **new-file line number** in front of each added or context line, e.g. `+ 45 | code`. Deleted lines get a `-    |` marker and no number. Also return the set of valid commentable lines for each file (the added lines).
3. `tokens.ts`: token estimation as described in `DECISIONS.md`.
4. `chunk.ts`: pack files into chunks under `CHUNK_TOKEN_BUDGET` (default 7000). Put small files together. Split oversized files at hunk boundaries. Skip a single hunk that's bigger than the budget, with reason `"hunk too large"`.
5. Unit tests for all four modules, including edge cases: an empty patch, a single giant hunk, a new file, renames, and a "\ No newline at end of file" line.

## Phase 3: Parallel review, merge, summary

1. In `review-pr.ts`, replace the single `generate-review` step with one `step.run("review-chunk-<i>")` per chunk, run in parallel. Add Inngest concurrency limiting (key by user) so a big PR doesn't hit Gemini rate limits.
2. Each chunk gets the existing prompt, changed to: use the annotated line numbers, at most 5 comments per chunk, and comment only on `+` lines.
3. Make JSON handling robust. Wrap the parse in try/catch, retry once on bad JSON, and if that also fails, mark only that chunk as failed. The review still completes.
4. `merge.ts`: drop comments whose line isn't in that file's valid-line set, remove duplicates (same file, lines within 2 of each other, same category), sort by severity, keep the top `MAX_COMMENTS` (default 15).
5. Summary pass: one small model call that gets only the merged comments, the file list and the skipped list (not the diff). It returns the `summary` and `riskScore`.
6. Save `meta` to the review (you can add a `meta Json?` column with a Prisma migration): files reviewed, files skipped with reasons, number of chunks, failed chunks, tokens, latency. Show the skipped files and the failed-chunk count in the review summary and in the UI (a small "Coverage" line in `review-result.tsx` is enough).
7. Re-run the eval and record the results compared with the baseline in `GUIDE.md`.

## Phase 4: Repo context

1. Define a `ContextProvider` interface: `getFile(path, ref)` and `findCallers(symbol, ref)`. Implement it as `GitHubContextProvider` (contents API at the **head SHA**) and `LocalContextProvider` (for evals).
2. For each changed file, gather context in this priority order, and cut from the bottom when over budget (`CONTEXT_TOKEN_BUDGET`, default 4000 per chunk):
   1. the full changed file (if under 400 lines; otherwise the changed functions plus 20 lines around them)
   2. **exported signatures** from relative imports, one level deep (function and type declarations only, no function bodies). Use the TypeScript compiler API to extract them, since `typescript` is already a dependency.
   3. call sites of exported symbols the diff changed: at most 5, each with 3 lines of surrounding code. Follow `DECISIONS.md` for how to find callers.
3. Prompt layout: the `CHANGED CODE` section is for review; `FULL FILE`, `RELATED SIGNATURES` and `CALL SITES` are clearly marked "reference only". Rule: comment only on changed lines.
4. Cache fetched files and extracted signatures in a new Prisma model keyed by `(repo, blobSha)`.
5. Ask me to add context-dependent eval cases at this point (for example, a function now returns null and a caller doesn't check), then compare the eval with context and without context (`--no-context` flag).

## Phase 5: Finish

1. Rewrite `README.md`: what it does, architecture diagram (Mermaid), how large-PR handling and repo context work, eval results table, how to run the evals, limitations.
2. Final pass on `GUIDE.md` and `DECISIONS.md`.
3. Give me 3 resume bullet points based **only on the measured numbers**. Don't invent any metrics.

Start with Phase 0. Before writing code, give me a 10-line plan for that phase and wait for my OK.