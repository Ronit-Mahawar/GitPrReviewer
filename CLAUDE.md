# CLAUDE.md — GitPrReviewer

AI-powered GitHub PR reviewer. A user connects a repo, a webhook fires on PR `opened` / `reopened` / `synchronize`, an Inngest job fetches the PR files, an LLM reviews the diff, and the result (summary, risk score, comments) is saved to Postgres and shown in the dashboard.

## Stack
- Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, shadcn/ui
- tRPC v11 + TanStack Query, Zod v4
- Prisma 6 + PostgreSQL
- better-auth (GitHub OAuth; the access token is stored in `Account`)
- Inngest v3 for background jobs
- LLM: Gemini (`gemini-3.1-flash-lite`) via the **OpenAI SDK** pointed at Google's OpenAI-compatible endpoint (`GEMINI_API_KEY`)
- Deploy: Docker + Caddy on a VPS (`.github/workflows/deploy-vps.yml`)

## Commands
- `npm run dev`: start the dev server (run the Inngest dev server separately: `npx inngest-cli@latest dev`)
- `npm run lint`, `npx tsc --noEmit`: must pass before any phase is done
- `npm run test`: Vitest (added in v2 Phase 0)
- `npm run eval`: eval harness (added in v2 Phase 1)
- `npm run db:generate`, `npx prisma migrate dev --name <name>`: schema changes. Always use a migration, never `db push`, for v2 changes.

## Where things are
- `src/app/api/webhooks/github/route.ts`: webhook. Verifies the HMAC signature and ignores duplicate deliveries via the unique `WebhookDelivery.deliveryId`. **Don't change this logic.**
- `src/server/inngest/functions/review-pr.ts`: the review job (steps: status, repo, token, files, PR, `review-chunk-<i>` per chunk in parallel, `summarize`, save). Concurrency: 3 steps per user
- `src/server/services/github.ts`: GitHub REST helpers (paginated PR files)
- `src/server/services/ai.ts`: the only provider code: `createGeminiLlm()` returns the `llm` function (OpenAI SDK → Gemini), model from `REVIEW_MODEL`
- `src/server/review/`: **(v2)** pure pipeline modules. `review-pull-request.ts` (core: `reviewPullRequest` → `reviewChunk` per chunk → `mergeComments` → `summarizeReview`; optional `runStep` hook for Inngest), `filter.ts`, `annotate.ts`, `tokens.ts`, `chunk.ts`, `merge.ts`, `prompt.ts` (chunk + summary prompts), `parse.ts`, `schema.ts`, `config.ts`, `context.ts` + `signatures.ts` (Phase 4 repo context). The GitHub-backed `ContextProvider` and its blob-SHA cache are in `src/server/services/github-context-provider.ts` and `context-cache.ts`
- `src/server/lib/logger.ts`: tiny logger; debug output only at `LOG_LEVEL=debug`
- `src/components/review-result.tsx`, `diff-viewer.tsx`: review UI
- `prisma/schema.prisma`: `Review.comments` and `Review.meta` (v2 coverage: files reviewed/skipped, chunks, failed chunks, tokens, latency) are `Json`
- `evals/`: **(v2)** fixture repo, cases, runner, scorer, results

## Rules
1. **Work in phases** (see the v2 prompt). Stop after each phase, summarise it, and wait for approval.
2. **Keep things simple and easy to explain.** The owner must be able to explain every line in an interview. Use plain functions, not class hierarchies. No new framework or dependency without an entry in `DECISIONS.md`.
3. **Keep the core pure.** Review logic in `src/server/review/` takes data in and returns data. It never imports Prisma, Inngest or `fetch` directly. Pass GitHub and the LLM in as parameters (`ContextProvider`, `llm`).
4. **Never fail the whole review because of one chunk.** Errors stay inside the chunk, and coverage is reported in `meta`.
5. **Never skip files silently.** Every skipped file goes in `meta.skipped` with a reason.
6. **Line numbers come from code, not the model.** Comments on lines that aren't valid added lines are dropped.
7. **Don't log** full diffs or model responses, except at `LOG_LEVEL=debug`. Never log tokens or secrets.
8. **Don't invent metrics.** Numbers in the README, GUIDE or resume bullets must come from `evals/results/`.
9. After each phase, update `GUIDE.md` (what, how, how to test, 3 interview Q&As) and `DECISIONS.md` (any new or changed decision).
10. Every new pure module gets unit tests. Cover edge cases, not just the happy path.

## Env vars
`DATABASE_URL`, `GEMINI_API_KEY`, `GITHUB_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL`, better-auth vars, Inngest keys.
v2 adds: `REVIEW_MODEL`, `JUDGE_MODEL`, `JUDGE_API_KEY` (evals only: a key from another Google project for the judge), `CHUNK_TOKEN_BUDGET`, `CONTEXT_TOKEN_BUDGET`, `MAX_COMMENTS`, `LOG_LEVEL`. Keep `.env.example` up to date.