/**
 * Rough token count for budgeting (D12). It only needs to be roughly right, and it avoids a network
 * call (countTokens) or a tokenizer dependency.
 */

/**
 * Characters per token for annotated diff text. Measured with Gemini's countTokens on the 26 eval
 * cases: 2.30–3.07 (2.68 overall). 2.5 errs on the side of overestimating, which is the safe side
 * for a budget; English prose is ~3.5–4, so prompts with lots of prose are overestimated more.
 */
export const CHARS_PER_TOKEN = 2.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
