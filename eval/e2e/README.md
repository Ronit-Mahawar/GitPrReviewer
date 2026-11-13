# GitHub E2E self-check

This runner creates real pull requests and can trigger the app's configured LLM through its GitHub webhook. It is fail-closed: `eval/e2e/safety.ts` hard-codes the owner-confirmed `Ronit-Mahawar/Learning-Rag` sandbox repo. The runner refuses every target outside that set.

The environment currently has an invalid `gh` login and no `GITHUB_TOKEN`/`GH_TOKEN`; restore authentication locally with `gh auth login` or a token environment variable before live use. Never put tokens in source or result files. The runner redacts common token formats and credential-bearing URLs, and local results are ignored by git.

Set `EVAL_E2E_DATABASE_URL` locally to the same **sandbox** database used by the app webhook. The runner does not fall back to `DATABASE_URL`, and it only reads Review rows. The server webhook must already be deployed/reachable, the sandbox repo must be connected, and auto-review must be enabled. Current app storage has no retry-attempt field and no webhook-received timestamp, so retry count is N/A and PR-created-to-review-created is reported as the observable latency proxy.

First inspect the action plan without network calls:

```sh
npm run eval:e2e -- --repo OWNER/REPO --case 01-null-deref --dry-run
```

The script estimates a conservative upper bound using three LLM attempts per case. Before any live run, review the estimate and explicitly pass that amount as `--approve-cost <USD>`:

```sh
npm run eval:e2e -- --repo OWNER/REPO --limit 2 --approve-cost 0.01
```

The numeric amount above is only an example; use the value printed by the script. Do not run the live command until you have approved the estimate. Results go to a new `eval/results/e2e-<timestamp>/` directory. By default, the runner closes each PR and deletes only its own `eval/*` branch. `--keep` preserves both. `--timeout` changes the review polling timeout in milliseconds.

For self-check cases, run `--selfcheck-scenarios` to add a docs-only PR, a 600-line PR, and an empty-file PR. Add `--retrigger-twice` to push two no-content commits after opening each PR and observe duplicate review records. These actions also trigger the app's review model and are included in the cost estimate. Then run:

```sh
npm run eval:selfcheck -- --run-dir eval/results/e2e-<timestamp>
```

The self-check prints PASS/FAIL for the clean and secret cases, duplicate handling, large and docs/empty PR outcomes, bad webhook signatures, failed-LLM terminal status, and line mapping. Failures are written with reproduction steps to `selfcheck-report.md`. A missing scenario is reported as not verified, not silently counted as a pass.
