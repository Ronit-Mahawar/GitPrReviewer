# shop-api (eval fixture)

A small order/inventory service used as the "repository" for eval cases. It is never run or installed; the reviewer only reads it.

- `src/http.ts`: request/response types
- `src/routes/users.ts`: an API route
- `src/users.ts`, `src/orders.ts`, `src/inventory.ts`: services
- `src/db.ts`: database layer (`query`, `withTransaction`)
- `src/auth.ts`, `src/passwords.ts`, `src/config.ts`, `src/redis.ts`, `src/logger.ts`, `src/errors.ts`, `src/utils.ts`: helpers
- `src/pricing.ts`, `src/checkout.ts`, `src/receipts.ts`, `src/flags.ts`, `src/routes/stock.ts`, `src/routes/beta.ts`: added for the `ctx-*` cases; they call functions that those PRs change, so the bug only shows with repo context

Each case in `../cases/<id>/pr.diff` is a unified diff against this tree. Don't edit existing files here without regenerating the case diffs, or their line numbers will drift.
