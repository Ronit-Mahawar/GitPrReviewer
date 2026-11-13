# Isolated benchmark run

Run this only against a disposable Postgres database and a dedicated GitHub test repository. The generator requires `DATABASE_URL` and `BENCH_DATABASE_URL` to match, checks that the database name includes `bench`, `benchmark`, or `test`, and requires an explicit isolation acknowledgement. It creates 40 open PRs, then pushes follow-up commits to the first five and closes/reopens the first three. PRs remain in the test repository afterward.

## Required environment

- `DATABASE_URL`: the isolated app database URL.
- `BENCH_DATABASE_URL`: the exact same isolated database URL, for report polling.
- `TESTBED_REPO`: dedicated GitHub repository in `owner/name` format; connect it to this app and enable automatic reviews first.
- `GITHUB_TOKEN`: token with Contents read/write and Pull requests read/write for that repository.
- `BENCH_CONFIRM_ISOLATED_DB=I_ACKNOWLEDGE_THIS_IS_AN_ISOLATED_TEST_DATABASE`: explicit safety guard.
- App runtime settings: `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`, `GEMINI_API_KEY` (the OpenAI compatible provider key used by `ai.ts`), plus the Inngest event/signing keys if using hosted Inngest.

Optional: `BENCH_REVIEW_TIMEOUT_MS` (default 600000), `BENCH_REQUEST_GAP_MS` (default 1500), and `BENCH_FORCE_RETRY_PR_NUMBER` / `BENCH_ENABLE_RETRY_TEST=true` for the forced retry check. Set the retry PR number before opening that PR; on its first Inngest execution it throws once and should succeed on retry. Check the Inngest run timeline for the failed first attempt and successful retry.

## Commands

From `aicodereviewer/`, after exporting the variables above and confirming the test repo is connected to this app:

```sh
npm ci
npx prisma migrate deploy
npx prisma generate
npm run dev
```

Run the configured Inngest dev server or hosted Inngest endpoint against `http://localhost:3000/api/inngest` in a second terminal. Ensure GitHub's `pull_request` webhook (`opened`, `synchronize`, and `reopened`) points at the app's `/api/webhooks/github` endpoint and uses the same `GITHUB_WEBHOOK_SECRET`.

With the app, webhook tunnel, and Inngest worker running, from another terminal:

```sh
npm run bench:generate
```

Fill `inputUsdPerMillionTokens` and `outputUsdPerMillionTokens` in `scripts/bench/config.ts` with the provider's applicable published pricing before reporting, then run:

```sh
npm run bench:report
```

The report prints measurements derived from the database and writes raw review rows to `results.csv`. `npx prisma migrate deploy` uses `DATABASE_URL`; confirm it is the benchmark database before running it. Never reuse production credentials for this run.
