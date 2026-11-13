// Gemini standard paid-tier prices checked 2026-11-03. Edit to match your tier/provider.
// Source: https://ai.google.dev/gemini-api/docs/pricing
export const MODEL_PRICING: Record<string, { input_per_million: number; output_per_million: number }> = {
  "gemini-3.1-flash-lite": { input_per_million: 0.25, output_per_million: 1.5 },
};
export function estimateCost(model: string, promptTokens: number | null, completionTokens: number | null): number | null {
  const price = MODEL_PRICING[model];
  if (!price || promptTokens === null || completionTokens === null) return null;
  return (promptTokens * price.input_per_million + completionTokens * price.output_per_million) / 1_000_000;
}
