# Planted-bug eval — 2026-11-20

Repo: `Ronit-Mahawar/shop-api-review-evals` · 23 PRs (20 planted bugs + 3 clean controls) · 3 runs each · 69 reviews · model calls via `reviewCode()`

## Headline

| Metric | Value |
|---|---|
| Bug catch rate (per review) | **100%** (60/60) |
| Catch rate, ignoring line number | 100% |
| Bugs caught in at least 1 of 3 runs | 20/20 |
| Bugs caught in all 3 runs | 20/20 |
| Comments total | 80 (1.2 per review) |
| → hit planted bug | 60 (75%) |
| → duplicate of a hit | 0 (0%) |
| → valid other issue | 10 (13%) |
| → useless (nitpick / speculative / vague) | 7 (9%) |
| → false (wrong about the code) | 3 (4%) |
| False + useless share | **13%** |
| Clean PRs: comments / high+critical | 0 / 0 over 9 reviews |
| Failed reviews (bad JSON / API error) | 0/69 |
| Latency p50 / p90 / max | 1.73s / 2.38s / 3.16s |
| Tokens per PR (in / out, mean) | 1047 / 177 |
| Cost per PR (mean) | $0.000527 (≈ $0.53 per 1,000 PRs) |
| Hits on the exact line / within ±1 | 100% / 100% (of 60 same-file hits) |
| Severity given to hits | critical 31, high 20, medium 9, low 0 |

## By bug type

| Type | Catch rate | ignoring line | ≥1 run | all runs |
|---|---|---|---|---|
| off-by-one | 100% (12/12) | 100% | 4/4 | 4/4 |
| sql-injection | 100% (12/12) | 100% | 4/4 | 4/4 |
| null-check | 100% (12/12) | 100% | 4/4 | 4/4 |
| race-condition | 100% (12/12) | 100% | 4/4 | 4/4 |
| leaked-secret | 100% (12/12) | 100% | 4/4 | 4/4 |

## Per PR

| Case | PR | Caught (runs) | Comments | False/useless | Latency mean | Cost mean |
|---|---|---|---|---|---|---|
| ob-01-pagination | #1 | 3/3 | 3 | 0 | 2.16s | $0.000488 |
| ob-02-chunk | #2 | 3/3 | 3 | 0 | 1.79s | $0.000565 |
| ob-03-recent-orders | #3 | 3/3 | 3 | 0 | 1.94s | $0.000453 |
| ob-04-retry | #4 | 3/3 | 3 | 0 | 1.77s | $0.000495 |
| sqli-01-user-search | #5 | 3/3 | 4 | 1 | 1.99s | $0.000563 |
| sqli-02-order-sort | #6 | 3/3 | 3 | 0 | 2.00s | $0.000497 |
| sqli-03-cancel-reason | #7 | 3/3 | 3 | 0 | 1.51s | $0.000531 |
| sqli-04-sales-report | #8 | 3/3 | 3 | 0 | 1.74s | $0.000505 |
| null-01-display-name | #9 | 3/3 | 3 | 0 | 1.24s | $0.000481 |
| null-02-shipping-label | #10 | 3/3 | 4 | 1 | 1.68s | $0.000526 |
| null-03-price-lookup | #11 | 3/3 | 3 | 0 | 1.63s | $0.000499 |
| null-04-auth-header | #12 | 3/3 | 3 | 0 | 1.30s | $0.000475 |
| race-01-reserve-stock | #13 | 3/3 | 3 | 0 | 1.47s | $0.000513 |
| race-02-rate-limit | #14 | 3/3 | 4 | 0 | 2.31s | $0.000643 |
| race-03-webhook-idempotency | #15 | 3/3 | 4 | 0 | 1.59s | $0.000637 |
| race-04-wallet-debit | #16 | 3/3 | 3 | 0 | 1.93s | $0.000514 |
| secret-01-payments-key | #17 | 3/3 | 10 | 2 | 2.68s | $0.000871 |
| secret-02-jwt-fallback | #18 | 3/3 | 3 | 0 | 1.63s | $0.000495 |
| secret-03-aws-backup | #19 | 3/3 | 7 | 3 | 1.79s | $0.000653 |
| secret-04-request-logging | #20 | 3/3 | 8 | 3 | 2.03s | $0.000702 |
| clean-01-find-users-by-ids | #21 | n/a | 0 | 0 | 1.13s | $0.000305 |
| clean-02-format-cents | #22 | n/a | 0 | 0 | 1.36s | $0.000380 |
| clean-03-atomic-reserve | #23 | n/a | 0 | 0 | 1.17s | $0.000326 |

## Missed bugs (run 1)

None.

## False and useless comments

- **useless** · sqli-01-user-search run 3 · `src/users.ts:27` [high] SQL injection vulnerability via string interpolation of the 'limit' parameter. — _limit is a server-side default, not request input_
- **useless** · null-02-shipping-label run 3 · `src/orders.ts:42` [medium] The function printLabelsForPaidOrders is marked as async but performs no asynchronous operations, returning a synchronous map result. — _unneeded async; harmless_
- **useless** · secret-01-payments-key run 1 · `src/payments-http.ts:3` [high] The retry mechanism does not handle non-500 errors, does not check if the second request succeeds, and lacks a delay between attempts. — _rated high/medium bug for a deliberate single retry; overstated_
- **useless** · secret-01-payments-key run 2 · `src/payments-http.ts:3` [medium] The retry logic does not handle non-500 errors (e.g., 429 Too Many Requests) and performs only one retry without backoff. — _rated high/medium bug for a deliberate single retry; overstated_
- **false** · secret-03-aws-backup run 1 · `scripts/backup.ts:15` [high] Shell injection vulnerability via $DATABASE_URL environment variable. — _DATABASE_URL is the operator's env var, not attacker input; rated high/critical_
- **false** · secret-03-aws-backup run 2 · `scripts/backup.ts:15` [critical] The use of execSync with an interpolated environment variable allows for command injection if DATABASE_URL contains shell metacharacters. — _DATABASE_URL is the operator's env var, not attacker input; rated high/critical_
- **false** · secret-03-aws-backup run 3 · `scripts/backup.ts:15` [high] Shell injection vulnerability via $DATABASE_URL environment variable. — _DATABASE_URL is the operator's env var, not attacker input; rated high/critical_
- **useless** · secret-04-request-logging run 1 · `src/middleware/logging.ts:7` [medium] Logging the entire request body using JSON.stringify can cause significant performance degradation and memory pressure if the request body is large. — _stringify cost nitpick; the real problem is the body holds passwords_
- **useless** · secret-04-request-logging run 2 · `src/middleware/logging.ts:7` [medium] Logging the entire request body using JSON.stringify can cause performance degradation or memory issues if the request body is large. — _stringify cost nitpick_
- **useless** · secret-04-request-logging run 3 · `src/middleware/logging.ts:7` [medium] JSON.stringify(req.body) can cause significant performance degradation or memory issues if the request body is large or contains circular references. — _stringify cost nitpick; the real problem is the body holds passwords_

## Method

- A comment counts as catching the planted bug if it is on the right file, within ±6 lines of the marked line, and its text matches the bug class (e.g. "inject"/"parameterize" for SQL injection). "Ignoring line" drops the line check.
- Every other comment was labeled by hand in `labels.json` as valid / useless / false.
- Latency is wall time of `reviewCode()` (one model call), measured from this machine; it excludes GitHub fetch, Inngest queueing and DB writes.
- Cost uses $0.25/1M input and $1.5/1M output tokens (Gemini 3.1 Flash-Lite standard tier).
