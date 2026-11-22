/**
 * Reads a numeric setting such as CHUNK_TOKEN_BUDGET or MAX_COMMENTS.
 * Callers pass process.env values in, so this module stays pure.
 * Missing, empty or invalid values fall back to the default instead of breaking a review.
 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
