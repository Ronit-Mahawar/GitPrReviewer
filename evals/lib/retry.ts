/**
 * Wraps an `llm` so provider errors (429 rate limit, 503 overloaded, timeouts) are retried with backoff.
 * Evals need this to match production, where Inngest retries a failed step (retries: 2); without it a
 * rate limit would show up as a "failed chunk" and lower the score for reasons unrelated to the reviewer.
 */
import type { Llm } from "../../src/server/review/review-pull-request";

export const EVAL_RETRY_DELAYS_MS = [5_000, 20_000];

export function withRetries(
  llm: Llm,
  delaysMs: number[] = EVAL_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry: (error: unknown, delayMs: number) => void = () => {},
): Llm {
  return async (messages) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await llm(messages);
      } catch (error) {
        const delay = delaysMs[attempt];
        if (delay === undefined) throw error;
        onRetry(error, delay);
        await sleep(delay);
      }
    }
  };
}
