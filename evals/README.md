# Evals

Measures the reviewer on PRs with known answers: does it catch the planted bug, how much noise does it add, does it raise false alarms on clean PRs, and what does it cost in time and tokens.

```
evals/
  fixture-repo/        the "repository" every case's diff applies to (never run, only read)
  cases/<id>/
    case.json          what the PR is and where the bug is
    pr.diff            unified diff against fixture-repo
  lib/                 pure helpers (diff parser, case loader, scoring) + their unit tests
  run.ts               reviews every case → results/<timestamp>-<label>.json
  score.ts             location filter + LLM judge → results/<...>.score.md and .score.json
  results/             committed: README/GUIDE numbers must come from here
  planted-bugs/        older harness (GitHub test repo + hand labels); its 23 cases were ported into cases/
```

## Running

```bash
npm run eval -- --label my-change            # 3 runs per case, temperature 0
npm run eval -- --runs 1 --only sqli-,ob-01  # quick subset (id prefixes)
npm run eval -- --no-context --label diff-only  # same, without repo context (Phase 3 prompts)
npm run eval:score                           # scores the newest run (or pass a results/*.json path)
```

Needs `GEMINI_API_KEY` in `.env`. Optional: `REVIEW_MODEL` (reviewer), `JUDGE_MODEL` (default `gemini-3-flash-preview`), `JUDGE_API_KEY` (a key from another Google project, so the judge has its own quota; the free tier allows 20 requests per model per day per project).

With context on (the default), the runner rebuilds each case's changed files as they are after the PR (`applyPatch()`), lays them over `fixture-repo/`, and passes that as the context provider, so the reviewer sees the same full files, signatures and call sites it would get from GitHub at the PR's head commit.

The runner calls `reviewPullRequest()` directly, the same function the Inngest job uses. There's no GitHub, Inngest or DB involved. `pr.diff` is parsed into the same per-file `{ filename, status, additions, deletions, patch }` list that GitHub's "list PR files" API returns.

## How a comment is scored

1. **Location:** the comment's `file` equals `bug.file` and `|line - bug.line| <= 3`.
2. **Judge:** for each comment that passes the location check, `JUDGE_MODEL` is asked *"Does this comment identify this bug: `<description>`?"* and must answer YES.

A bug is **caught** in a review if at least one comment passes both checks. A failed review counts as a miss. **Noise** is every comment that doesn't match a bug, averaged per review. On a clean PR, a **false alarm** is a review with any `high` or `critical` comment. The `.score.md` lists 10 judge decisions to check by hand; if you disagree with more than 1 in 10, the judge needs fixing (see DECISIONS D2).

## Adding a case

1. Make a working copy of the fixture repo and commit it as the base:
   ```bash
   cp -R evals/fixture-repo /tmp/fx && cd /tmp/fx && git init -q && git add -A && git commit -qm base
   ```
2. Make the change the PR should contain (plant the bug), then save the diff:
   ```bash
   mkdir -p <repo>/evals/cases/<id> && git diff > <repo>/evals/cases/<id>/pr.diff
   ```
   For new files run `git add -N .` first, or commit and use `git diff HEAD~1`, so they appear in the diff.
3. Write `evals/cases/<id>/case.json`:
   ```json
   {
     "id": "<id>",
     "title": "PR title the reviewer sees",
     "kind": "bug",
     "bug": {
       "file": "src/users.ts",
       "line": 31,
       "category": "null-check",
       "description": "What is wrong and what goes wrong because of it, in one or two sentences."
     }
   }
   ```
   - `id`: lowercase letters, digits and dashes; must equal the folder name.
   - `kind`: `bug` (one planted bug), `clean` (no bug, no `bug` field), `context` (a bug you can only see with other files of the repo, e.g. a caller that doesn't handle a new `null` return), or `large` (a big PR; `bug` optional).
   - `bug.line`: the line number **in the new file**, and it must be an added (`+`) line. The loader checks this.
   - `bug.category`: free text, used to group results (existing ones: `off-by-one`, `sql-injection`, `null-check`, `race-condition`, `leaked-secret`, `broken-access-control`, and for `context` cases `argument-order`, `missing-await`, `unit-change`).
   - For a `context` case, the broken code must be in a file the PR doesn't change, and it must use the changed function **by name** (that's how call sites are found). Put the caller in `fixture-repo/` as a **new** file; see the `ctx-*` cases and their callers (`src/routes/stock.ts`, `src/checkout.ts`, `src/routes/beta.ts`, `src/receipts.ts`).
   - `bug.description`: the judge compares comments against this, so describe the bug itself, not just the fix.
4. Check it loads: `npm run test` (the `loadCases` test validates every case), then try it with `npm run eval -- --runs 1 --only <id>`.

Adding new files to `fixture-repo/` is safe. Don't edit existing files in it. That would shift line numbers under the existing diffs. If you must, regenerate the affected `pr.diff` files.
