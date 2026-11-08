// Portfolio performance from a list of values in time order. Pure functions.
// Used by the dashboard now, and by weekly scoring later (rule 6), so both agree on the numbers.

// Return from the first value to the last, in %. null when there is nothing to compare.
export function returnPct(values: number[]): number | null {
  if (values.length < 2 || values[0] <= 0) return null;
  return (values[values.length - 1] / values[0] - 1) * 100;
}

// Maximum drawdown: the largest % drop from a peak to a later low. 0 when the value never fell.
// Returned as a positive number: 1.8 means "fell 1.8% from its peak".
export function maxDrawdownPct(values: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, (1 - v / peak) * 100);
  }
  return worst;
}

// The 20% rule (rule 4) and the dashboard's "close to the cap" warning.
export const CAP_PCT = 20;
export const NEAR_CAP_PCT = 18;

export function weightPct(value: number, total: number): number | null {
  return total > 0 ? (value / total) * 100 : null;
}

export function isNearCap(weight: number | null): boolean {
  return weight !== null && weight >= NEAR_CAP_PCT;
}
