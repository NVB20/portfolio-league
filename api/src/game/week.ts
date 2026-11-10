// Marks, portfolio totals and the weekly running totals (D-019, D-024, D-025). Pure functions.
// At every open and close the runner re-marks the affected players' positions, works out their totals,
// and folds the new value into the week's peak and drawdown. Scoring reads those columns and never
// scans history.

import { bigMax, mulDiv, pct } from './fixed.js';
import { markPosition, type PositionState, rateFor } from './engine.js';
import type { Market } from './marketHours.js';
import { ISRAEL, mondayOf, zonedParts } from './time.js';

// Re-marks the positions of `market` that have a price in `prices`. A TASE event never touches US
// positions and the other way round, which is what lets an event update only the players it affects.
export function markPositions(
  positions: readonly PositionState[],
  market: Market,
  prices: Map<string, bigint>,
  rate: bigint,
  at: Date,
): PositionState[] {
  const effective = rateFor(market, rate);
  return positions.map((p) => {
    const price = p.market === market ? prices.get(p.symbol) : undefined;
    return price === undefined ? { ...p } : markPosition(p, price, effective, at);
  });
}

export type Totals = { holdingsValue: bigint; equity: bigint; unrealizedPnl: bigint };

// A position with no mark yet counts at its cost (no gain or loss until a price says otherwise).
export function totals(cash: bigint, positions: readonly PositionState[]): Totals {
  let holdingsValue = 0n;
  let unrealizedPnl = 0n;
  for (const p of positions) {
    const value = p.marketValue ?? p.costBasis;
    holdingsValue += value;
    unrealizedPnl += value - p.costBasis;
  }
  return { holdingsValue, equity: cash + holdingsValue, unrealizedPnl };
}

export type WeekState = {
  weekStart: string | null;      // Monday 'YYYY-MM-DD' (Israel) of the week the totals belong to
  weekStartValue: bigint | null; // ILS
  peakValue: bigint | null;      // ILS
  maxDrawdownPct: bigint;        // PCT, ≥ 0
  lastEventAt: Date | null;      // the retry guard (D-021)
};

// The competition week of an instant: the Monday of its Israel calendar date.
export function weekOf(at: Date): string {
  return mondayOf(zonedParts(at, ISRAEL).date);
}

// Lazy weekly reset: the first event of a new week starts the totals from the value before it, so nothing
// has to rewrite every row when a week begins (D-024). Same week = an unchanged copy, so calling it twice
// for one event is harmless. It never touches lastEventAt: the retry guard belongs to applyEvent.
// The order step calls it on its own before a trade, so a player who trades at the first event of a week
// starts the week from their value BEFORE the trade; the later applyEvent then only adds peak and drawdown.
export function startWeek(week: WeekState, eventAt: Date, valueBefore: bigint): WeekState {
  const eventWeek = weekOf(eventAt);
  if (week.weekStart === eventWeek) return { ...week };
  return {
    weekStart: eventWeek,
    weekStartValue: valueBefore,
    peakValue: valueBefore,
    maxDrawdownPct: 0n,
    lastEventAt: week.lastEventAt,
  };
}

// Folds one event into the week. valueBefore/valueAfter are the player's value just before and after it.
// null = this event (or a later one) was already applied, so a retried batch changes nothing (D-021).
export function applyEvent(week: WeekState, eventAt: Date, valueBefore: bigint, valueAfter: bigint): WeekState | null {
  if (week.lastEventAt !== null && week.lastEventAt.getTime() >= eventAt.getTime()) return null;
  const started = startWeek(week, eventAt, valueBefore);
  const peak = bigMax(started.peakValue ?? valueBefore, valueAfter);
  const drawdown = peak > 0n ? pct(peak - valueAfter, peak) : 0n;
  return {
    weekStart: started.weekStart,
    weekStartValue: started.weekStartValue ?? valueBefore,
    peakValue: peak,
    maxDrawdownPct: bigMax(started.maxDrawdownPct, drawdown),
    lastEventAt: eventAt,
  };
}

// The week's return so far, in PCT. A row untouched this week means the value hasn't changed: 0.
export function weekReturnPct(week: WeekState, value: bigint, currentWeek: string): bigint {
  if (week.weekStart !== currentWeek || week.weekStartValue === null || week.weekStartValue === 0n) return 0n;
  return pct(value - week.weekStartValue, week.weekStartValue);
}

// The median player line (D-024). An even count takes the mean of the two middle values, rounded half up
// (away from zero), in the values' own scale.
export function median(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : mulDiv(sorted[mid - 1] + sorted[mid], 1n, 2n, 'half_up');
}
