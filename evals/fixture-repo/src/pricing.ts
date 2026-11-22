/** Price after a percentage discount, in integer cents. percent is 0–100. */
export function applyDiscount(priceCents: number, percent: number): number {
  if (percent < 0 || percent > 100) throw new RangeError("percent must be between 0 and 100");
  return Math.round(priceCents * (1 - percent / 100));
}
