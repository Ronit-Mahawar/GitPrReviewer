# Planted-bug eval — 2026-11-20

Repo: `Ronit-Mahawar/shop-api-review-evals` · 23 PRs (20 planted bugs + 3 clean controls) · 3 runs each · 69 reviews · model calls via `reviewCode()`

## Headline

| Metric | Value |
|---|---|
| Bug catch rate (per review) | **100%** (60/60) |
| Catch rate, ignoring line number | 100% |
| Bugs caught in at least 1 of 3 runs | 20/20 |
| Bugs caught in all 3 runs | 20/20 |
| Comments total | 164 (2.4 per review) |
| → hit planted bug | 60 (37%) |
| → duplicate of a hit | 8 (5%) |
| → valid other issue | 35 (21%) |
| → useless (nitpick / speculative / vague) | 53 (32%) |
| → false (wrong about the code) | 8 (5%) |
| False + useless share | **37%** |
| Clean PRs: comments / high+critical | 13 / 0 over 9 reviews |
| Failed reviews (bad JSON / API error) | 1/69 |
| Latency p50 / p90 / max | 1.83s / 2.18s / 2.49s |
| Tokens per PR (in / out, mean) | 659 / 290 |
| Cost per PR (mean) | $0.000600 (≈ $0.60 per 1,000 PRs) |
| Hits on the exact line / within ±1 | 37% / 83% (of 60 same-file hits) |
| Severity given to hits | critical 24, high 26, medium 10, low 0 |

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
| ob-01-pagination | #1 | 3/3 | 6 | 1 | 1.75s | $0.000520 |
| ob-02-chunk | #2 | 3/3 | 9 | 6 | 1.88s | $0.000727 |
| ob-03-recent-orders | #3 | 3/3 | 6 | 3 | 1.76s | $0.000544 |
| ob-04-retry | #4 | 3/3 | 6 | 3 | 1.66s | $0.000545 |
| sqli-01-user-search | #5 | 3/3 | 7 | 3 | 1.99s | $0.000625 |
| sqli-02-order-sort | #6 | 3/3 | 6 | 0 | 1.65s | $0.000564 |
| sqli-03-cancel-reason | #7 | 3/3 | 9 | 3 | 1.91s | $0.000689 |
| sqli-04-sales-report | #8 | 3/3 | 8 | 2 | 1.71s | $0.000646 |
| null-01-display-name | #9 | 3/3 | 3 | 0 | 1.42s | $0.000361 |
| null-02-shipping-label | #10 | 3/3 | 6 | 3 | 1.55s | $0.000520 |
| null-03-price-lookup | #11 | 3/3 | 6 | 3 | 1.63s | $0.000539 |
| null-04-auth-header | #12 | 3/3 | 9 | 4 | 2.05s | $0.000669 |
| race-01-reserve-stock | #13 | 3/3 | 4 | 0 | 2.07s | $0.000457 |
| race-02-rate-limit | #14 | 3/3 | 9 | 1 | 1.94s | $0.000743 |
| race-03-webhook-idempotency | #15 | 3/3 | 9 | 2 | 1.92s | $0.000704 |
| race-04-wallet-debit | #16 | 3/3 | 9 | 4 | 2.13s | $0.000697 |
| secret-01-payments-key | #17 | 3/3 | 12 | 3 | 2.14s | $0.000832 |
| secret-02-jwt-fallback | #18 | 3/3 | 6 | 2 | 1.75s | $0.000523 |
| secret-03-aws-backup | #19 | 3/3 | 12 | 3 | 1.98s | $0.000784 |
| secret-04-request-logging | #20 | 3/3 | 9 | 2 | 2.02s | $0.000651 |
| clean-01-find-users-by-ids | #21 | n/a | 3 | 3 | 1.57s | $0.000370 |
| clean-02-format-cents | #22 | n/a | 4 | 4 | 1.75s | $0.000568 |
| clean-03-atomic-reserve | #23 | n/a | 6 | 6 | 2.00s | $0.000522 |

## Missed bugs (run 1)

None.

## False and useless comments

- **useless** · ob-01-pagination run 3 · `src/orders.ts:41` [low] The pageSize parameter lacks validation. — _pageSize<=0 can't cause an infinite loop here_
- **useless** · ob-02-chunk run 1 · `src/notifications.ts:16` [medium] The notifyAll function processes batches sequentially using 'await' inside a loop, which is inefficient for high volumes. — _sequential sends are intentional for a rate-limited provider_
- **useless** · ob-02-chunk run 1 · `src/notifications.ts:10` [low] The fetch call lacks error handling for network timeouts or connection failures. — _non-ok already throws; network errors propagate to the caller, which is fine_
- **useless** · ob-02-chunk run 2 · `src/notifications.ts:16` [low] The loop uses 'await' inside a 'for...of' block, which processes batches sequentially. This may be slow for large lists. — _sequential sends are intentional for a rate-limited provider_
- **useless** · ob-02-chunk run 2 · `src/notifications.ts:11` [medium] The fetch call lacks error handling for network failures or timeouts, which will cause the entire process to crash. — _non-ok already throws; network errors propagate to the caller, which is fine_
- **useless** · ob-02-chunk run 3 · `src/notifications.ts:16` [medium] The loop uses 'await' inside a 'for...of' block, causing sequential execution. This will be slow for large user lists. — _sequential sends are intentional for a rate-limited provider_
- **useless** · ob-02-chunk run 3 · `src/notifications.ts:10` [low] The fetch call lacks error handling for network failures or timeout scenarios. — _non-ok already throws; network errors propagate to the caller, which is fine_
- **false** · ob-03-recent-orders run 1 · `src/orders.ts:38` [medium] The sort order is ascending (oldest to newest), but the function name 'mostRecent' implies descending order or that the slice should take from the end. — _JSDoc says 'oldest first'; ascending sort is correct_
- **false** · ob-03-recent-orders run 2 · `src/orders.ts:38` [medium] The sort order is ascending (oldest to newest), but the function name 'mostRecent' implies the result should likely be descending or the logic is counter-intuitive. — _JSDoc says 'oldest first'; ascending sort is correct_
- **false** · ob-03-recent-orders run 3 · `src/orders.ts:38` [medium] The sort order is ascending (oldest first), but the function name 'mostRecent' and typical dashboard requirements usually imply descending order (newest first). — _JSDoc says 'oldest first'; ascending sort is correct_
- **useless** · ob-04-retry run 1 · `src/utils.ts:12` [medium] The backoff calculation '2 ** attempt * 100' grows exponentially without a cap, which could lead to excessively long wait times on high attempt counts. — _with default 3 attempts the delay is at most 800ms_
- **useless** · ob-04-retry run 2 · `src/utils.ts:12` [medium] Exponential backoff without jitter can cause 'thundering herd' problems if multiple instances fail simultaneously. — _jitter nitpick for a 3-attempt helper_
- **useless** · ob-04-retry run 3 · `src/utils.ts:12` [medium] The backoff calculation '2 ** attempt * 100' grows very quickly, which might lead to excessively long wait times for higher attempt counts. — _with default 3 attempts the delay is at most 800ms_
- **useless** · sqli-01-user-search run 2 · `src/users.ts:26` [medium] Using ILIKE with leading wildcards ('%term%') prevents the database from utilizing standard B-tree indexes on the email column, which will cause full table scans as the user base grows. — _leading-wildcard perf on an internal admin search_
- **useless** · sqli-01-user-search run 3 · `src/users.ts:26` [high] The 'limit' parameter is directly injected into the SQL string, which could lead to SQL injection if not strictly validated. — _limit is a server-side default, not request input_
- **useless** · sqli-01-user-search run 3 · `src/routes/admin.ts:6` [medium] The query length validation is good, but consider adding a maximum length limit to prevent excessive database load. — _max length nitpick_
- **useless** · sqli-03-cancel-reason run 1 · `src/routes/orders.ts:7` [medium] The reason field is not validated for presence or content, only truncated. — _empty-reason validation is a product choice_
- **useless** · sqli-03-cancel-reason run 2 · `src/routes/orders.ts:6` [low] Input validation is minimal. — _empty-reason validation is a product choice_
- **useless** · sqli-03-cancel-reason run 3 · `src/routes/orders.ts:6` [low] Input validation is minimal. While the string is truncated, it does not check if the reason is empty or contains only whitespace. — _empty-reason validation is a product choice_
- **useless** · sqli-04-sales-report run 1 · `src/reports.ts:11` [low] The SQL query string is constructed using multiple concatenated strings, which is hard to read. — _suggests template literals for the injectable query; makes the real problem worse_
- **useless** · sqli-04-sales-report run 2 · `src/routes/reports.ts:5` [low] Lack of type safety for req.query. — _req.query is already typed_
- **useless** · null-02-shipping-label run 1 · `src/orders.ts:42` [low] The function 'printLabelsForPaidOrders' is marked as 'async' but does not perform any asynchronous operations. — _unneeded async; harmless, mislabeled as performance/medium_
- **useless** · null-02-shipping-label run 2 · `src/orders.ts:42` [medium] printLabelsForPaidOrders is marked as async but performs no asynchronous operations. — _unneeded async; harmless, mislabeled as performance/medium_
- **useless** · null-02-shipping-label run 3 · `src/orders.ts:42` [medium] The function printLabelsForPaidOrders is marked as async but does not perform any asynchronous operations. — _unneeded async; harmless, mislabeled as performance/medium_
- **useless** · null-03-price-lookup run 1 · `src/cart.ts:12` [medium] The priceFor function performs an O(n) lookup on every call, leading to O(n*m) complexity for the cart total calculation. — _O(N*M) on cart-sized inputs; premature optimization_
- **useless** · null-03-price-lookup run 2 · `src/cart.ts:18` [medium] The cartTotal function performs an O(N*M) operation where M is the catalog size, as it calls find() inside a reduce(). — _O(N*M) on cart-sized inputs; premature optimization_
- **useless** · null-03-price-lookup run 3 · `src/cart.ts:13` [medium] Using .find() inside a .reduce() loop results in O(N*M) complexity. — _O(N*M) on cart-sized inputs; premature optimization_
- **false** · null-04-auth-header run 1 · `src/middleware/auth.ts:6` [medium] verifySession might throw an exception if the token is malformed or signature is invalid. — _verifySession checks the HMAC before parsing; an attacker can't make it throw_
- **useless** · null-04-auth-header run 2 · `src/middleware/auth.ts:8` [low] The code assumes verifySession is synchronous. If it involves database or network calls, this should be async. — _speculative; verifySession is synchronous_
- **useless** · null-04-auth-header run 3 · `src/middleware/auth.ts:5` [medium] The regex replace assumes the header always starts with 'Bearer '. If the format is different, the token will be incorrectly parsed. — _non-Bearer header just fails verification -> 401_
- **false** · null-04-auth-header run 3 · `src/middleware/auth.ts:6` [medium] verifySession is called without a try-catch block. If the function throws an error (e.g., invalid token format), the server may crash or leak stack traces. — _verifySession checks the HMAC before parsing; an attacker can't make it throw_
- **useless** · race-02-rate-limit run 1 · `src/routes/login.ts:10` [medium] Rate limiting is applied before password verification, which is good, but the key is based on user-provided input without sanitization. — _email used as a Redis key is not an injection risk_
- **useless** · race-03-webhook-idempotency run 2 · `src/webhooks.ts:22` [low] The 'processed_events' table will grow indefinitely, potentially degrading performance over time. — _table growth is not a review concern for this PR_
- **useless** · race-03-webhook-idempotency run 3 · `src/webhooks.ts:23` [low] The processed_events table will grow indefinitely. — _table growth is not a review concern for this PR_
- **useless** · race-04-wallet-debit run 1 · `src/wallet.ts:7` [medium] The code assumes the existence of a wallet record. If a user has no record, it defaults to 0, which might be incorrect if the business logic requires an explicit wallet creation. — _missing wallet -> balance 0 -> InsufficientFunds, which is correct_
- **useless** · race-04-wallet-debit run 2 · `src/wallet.ts:7` [medium] Potential for unhandled errors if the database query fails. — _generic 'errors may be unhandled'_
- **useless** · race-04-wallet-debit run 3 · `src/wallet.ts:7` [medium] The code assumes the existence of a wallet record. If a user does not have a wallet entry, it defaults to 0, which might be incorrect if the business logic requires an explicit wallet creation. — _missing wallet -> balance 0 -> InsufficientFunds, which is correct_
- **useless** · race-04-wallet-debit run 3 · `src/wallet.ts:12` [medium] Executing three separate queries increases latency and risk of partial failure. — _latency of three queries is not an issue_
- **useless** · secret-01-payments-key run 1 · `src/payments-http.ts:3` [high] The retry logic does not handle potential errors or wait between attempts, and it only retries once. — _rated high/bug for a deliberate single retry; overstated_
- **useless** · secret-01-payments-key run 2 · `src/payments-http.ts:3` [high] The retry logic only retries once and does not handle network errors or non-500 status codes that might require retries. — _rated high/bug for a deliberate single retry; overstated_
- **useless** · secret-01-payments-key run 3 · `src/payments-http.ts:3` [high] The retry logic does not handle potential failures or rate limits correctly and could lead to unexpected behavior. — _rated high/bug for a deliberate single retry; overstated_
- **useless** · secret-02-jwt-fallback run 1 · `src/config.ts:13` [low] Exporting 'required' after the config object is fine, but ensure it is still used for critical production variables. — _says the export 'is fine'; no action_
- **useless** · secret-02-jwt-fallback run 2 · `src/config.ts:13` [low] Exporting 'required' helper after it was removed from usage in the config object. — _dead-export nitpick_
- **false** · secret-03-aws-backup run 1 · `scripts/backup.ts:16` [high] Potential shell injection vulnerability via $DATABASE_URL. — _DATABASE_URL is the operator's env var, not attacker input; rated high/security_
- **false** · secret-03-aws-backup run 2 · `scripts/backup.ts:15` [high] Potential shell injection vulnerability via DATABASE_URL. — _DATABASE_URL is the operator's env var, not attacker input; rated high/security_
- **false** · secret-03-aws-backup run 3 · `scripts/backup.ts:15` [high] Potential shell injection vulnerability via $DATABASE_URL. — _DATABASE_URL is the operator's env var, not attacker input; rated high/security_
- **useless** · secret-04-request-logging run 1 · `src/middleware/logging.ts:7` [low] JSON.stringify on req.body can be expensive for large payloads and may throw if the body contains circular references. — _stringify cost nitpick; misses that the body holds passwords_
- **useless** · secret-04-request-logging run 2 · `src/middleware/logging.ts:7` [medium] JSON.stringify on req.body can be expensive for large payloads and may block the event loop. — _stringify cost nitpick; misses that the body holds passwords_
- **useless** · clean-01-find-users-by-ids run 1 · `src/users.ts:28` [low] The query returns all columns using SELECT *. If the users table has many columns or large fields, this could be inefficient. — _SELECT * / duplicate ids / Map ordering nitpicks on a correct function_
- **useless** · clean-01-find-users-by-ids run 2 · `src/users.ts:28` [low] The function returns a Map, but if the input array contains duplicate IDs, the Map will only contain the last occurrence. — _SELECT * / duplicate ids / Map ordering nitpicks on a correct function_
- **useless** · clean-01-find-users-by-ids run 3 · `src/users.ts:27` [low] The function returns a Map, but the order of results from the database is not guaranteed to match the input array order. — _SELECT * / duplicate ids / Map ordering nitpicks on a correct function_
- **useless** · clean-02-format-cents run 1 · `src/money.ts:1` [medium] The global Map 'formatters' will grow indefinitely if many different locale/currency combinations are used. — _cache is bounded by locale x currency; calling it a memory leak is a stretch_
- **useless** · clean-02-format-cents run 1 · `src/money.ts:12` [low] The function assumes the input is always in cents. While the JSDoc mentions this, consider adding a check or renaming to clarify the unit. — _says 'implementation is correct'; no action_
- **useless** · clean-02-format-cents run 2 · `src/money.ts:1` [medium] The global formatters Map is unbounded, which could lead to a memory leak if many different locale/currency combinations are used. — _cache is bounded by locale x currency; calling it a memory leak is a stretch_
- **useless** · clean-02-format-cents run 2 · `src/money.ts:4` [low] The function signature uses default parameters, but the cache key generation assumes these defaults are always used. — _says 'implementation is correct'; no action_
- **useless** · clean-03-atomic-reserve run 1 · `src/inventory.ts:13` [medium] The query does not explicitly handle database connection errors or potential deadlocks. — _generic 'add try/catch'_
- **useless** · clean-03-atomic-reserve run 1 · `src/inventory.ts:10` [low] The function assumes the existence of a 'query' helper. Ensure this helper properly handles transaction contexts if this function is called within a larger transaction. — _speculative transaction/limit advice_
- **useless** · clean-03-atomic-reserve run 2 · `src/inventory.ts:13` [medium] The query returns the updated quantity, but the value is unused. — _RETURNING overhead nitpick_
- **useless** · clean-03-atomic-reserve run 2 · `src/inventory.ts:8` [low] Input validation is good, but consider if qty should be validated against a maximum threshold to prevent potential overflow or abuse. — _speculative transaction/limit advice_
- **useless** · clean-03-atomic-reserve run 3 · `src/inventory.ts:13` [medium] The query does not explicitly check if the SKU exists, only if the quantity is sufficient. — _unknown SKU -> false is acceptable_
- **useless** · clean-03-atomic-reserve run 3 · `src/inventory.ts:8` [low] The function assumes the database connection handles transactions or that this single statement is sufficient for atomicity. — _speculative transaction/limit advice_

## Method

- A comment counts as catching the planted bug if it is on the right file, within ±6 lines of the marked line, and its text matches the bug class (e.g. "inject"/"parameterize" for SQL injection). "Ignoring line" drops the line check.
- Every other comment was labeled by hand in `labels.json` as valid / useless / false.
- Latency is wall time of `reviewCode()` (one model call), measured from this machine; it excludes GitHub fetch, Inngest queueing and DB writes.
- Cost uses $0.25/1M input and $1.5/1M output tokens (Gemini 3.1 Flash-Lite standard tier).
