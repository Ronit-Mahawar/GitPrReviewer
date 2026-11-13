# E2E paper notes

## What was tested and setup

The harness is designed to create pull requests from the cases in `eval/dataset/`, let the GitHub webhook trigger the deployed app, poll its sandbox Prisma database, and compare stored comments with ground truth. PR creation and branch cleanup are restricted to a hard-coded `eval/e2e/safety.ts` allowlist and `eval/*` branch names. Results are written as JSONL; the self-check records PASS/FAIL evidence and reproduction steps.

This run did **not** reach GitHub. The exact sandbox `OWNER/REPO` remains pending; the user said they will provide another target. The existing workspace origin, `Ronit-Mahawar/GitPrReviewer`, was not assumed to be the sandbox. `gh auth status` reported an invalid saved token, and neither `GITHUB_TOKEN` nor `GH_TOKEN` was set. The repository allowlist is therefore empty and fail-closed. No PRs or branches were created, no LLM calls were made, and no database was accessed.

## Real measured results

No `eval/results/e2e-*/results.jsonl` file exists for this run. The existing `smoke-*` results are explicitly synthetic dry-run fixtures and are excluded from paper measurements.

| Measure | Result |
| --- | --- |
| Real PRs created | N/A |
| Review success rate | N/A |
| PR-created to review-record latency (mean / median / p95) | N/A |
| Review processing latency | N/A |
| Duplicate or missing reviews | N/A |
| Precision / recall / F1 | N/A |
| Case failures | N/A |
| LLM retries | N/A; the Review model does not store attempt counts |
| Webhook receive timestamp | N/A; the app does not store it |

The eventual report uses PR-created to review-record-created latency as an observable proxy because the app does not persist webhook receive time. It records retries as N/A unless the app is instrumented to expose Inngest attempts.

## Discovered app issue

The mocked Inngest test retries an LLM failure through all configured attempts. The review status is updated to `PROCESSING` at the beginning of each attempt, but no failure handler writes a terminal status after retries are exhausted. The stored review remains `PROCESSING` instead of becoming `FAILED`.

Reproduction: run `npm test`; inspect the failed test `reviewPR failure state > retries LLM errors and ends the stored review in a terminal state`. The mock rejects `reviewCode` on every attempt and observes only `PROCESSING` updates.

## Test coverage summary

- Vitest: 16 tests discovered; 15 pass and 1 fails on the app issue above.
- Covered: valid/malformed/empty/timed-out mocked LLM responses; webhook valid/invalid signatures and unsupported events; tRPC auth, user scoping, trigger and fetch; mock Prisma review creation; diff reconstruction, line matching, repo allowlist and branch/path guards.
- The E2E self-check dry-run was executed. Its live PR checks remain unmeasured because the allowlisted sandbox target and authentication are not available.
- The self-check was also exercised against a temporary copy of synthetic smoke JSONL. The local bad-signature check passed; clean/secret/retrigger/large/docs-empty/line checks lacked real PR evidence, and the mocked failed-LLM check reproduced the `PROCESSING` issue. These are harness checks, not benchmark measurements.
- Coverage percentage: N/A; no coverage instrumentation was run.

## Limitations and next steps

Provide the exact sandbox `OWNER/REPO`, authenticate `gh` or set `GITHUB_TOKEN`, and set `EVAL_E2E_DATABASE_URL` only to the database used by the sandbox app webhook. Confirm the repository is connected and auto-review is enabled. Review the script's cost estimate and explicitly approve before any live run, since each PR may invoke the LLM.

The dataset still needs expansion toward 30–50 cases with about 10 clean cases. Human review of labels and classmates' ratings are also needed before paper analysis. The retry-state failure should be fixed only after reviewing the proposed change; the app source was not modified to hide this finding.
