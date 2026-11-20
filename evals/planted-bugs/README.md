# Planted-bug eval

Measures how well the PR reviewer (`reviewCode` in `src/server/services/ai.ts`) catches known bugs, how noisy it is, and what it costs.

- `fixtures/base/` – a small TypeScript order/inventory service (the test repo's `main`).
- `cases.ts` – 23 PRs: 4 each of off-by-one, SQL injection, missing null check, race condition, leaked secret, plus 3 clean controls. Bug lines are marked `// @bug` (the marker is stripped before commit).
- `setup-testbed.ts` – builds the repo, pushes it to a **private** GitHub repo, opens one PR per case, writes `ground-truth.json`.
- `run.ts` – fetches each PR's files from the GitHub API (same payload as the Inngest job) and calls `reviewCode()` N times; records comments, latency and token usage to `results/`.
- `score.ts` – matches comments to planted bugs, applies hand labels from `labels.json`, writes `report.md`.

```bash
npm run evals:bugs:setup -- --repo <owner>/shop-api-review-evals
npm run evals:bugs:run -- --runs 3
npm run evals:bugs:score -- --export-unlabeled   # then label results/unlabeled.json into labels.json
npm run evals:bugs:score
```

Saved runs: `baseline-run.json` + `labels-baseline.json` → `report-baseline.md` (original prompt), and `latest-run.json` + `labels.json` → `report.md` (line-numbered diff + tightened prompt). Re-score either with `npm run evals:bugs:score -- <run.json> --labels <labels.json> --out <report.md>`. A hand label overrides the keyword matcher for that comment.

`labels.json` keys are `<caseId>#<run>#<commentIndex>` → `{ "label": "valid" | "useless" | "false", "note": "..." }`. Labels are tied to a specific run file; re-label after a new run.

Not covered: webhook → Inngest → DB path (latency here is the model call only), and posting comments back to GitHub.
