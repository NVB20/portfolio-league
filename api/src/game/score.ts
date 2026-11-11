// The weekly score (D-034), as pure functions: the rule written out, and the oracle the tests check the scoring
// step against. The production path is api/src/scoring.ts, which does the same in set-based SQL inside the
// runner's finish transaction. No database, no framework.
//
// The brief: score = 0.85 × return rank + 0.15 × stability rank. The return rank is the percentile of the
// player's weekly return among all ranked players (100 = the highest). The stability rank is the percentile of
// the week's max drawdown (100 = the smallest drop).
//
// The defaults chosen for the brief's gaps (D-034; the user can change any of them, and each lives in one place
// here, mirrored once in scoring.ts's SQL):
//   who is ranked    isRanked: the runner touched the player this week, or they hold a stock now
//   their numbers    weekNumbers: the week's return so far and its max drawdown; 0 / 0 for a row not touched
//                    this week
//   the percentiles  percentile: the share of the OTHER ranked players you did at least as well as, × 100,
//                    half away from zero to 2 decimals. Tied players share the higher percentile
//   the score        scoreOf: from the two rounded ranks, half away from zero to 2 decimals
//   the place        comparePlaces: score, then % return, then the smaller drawdown, then the earlier sign-up,
//                    then the uid. Unique, 1..N
//   the week's end   isLastEventOfWeek: no open or close is left before next Monday, or before the world ends

import { eventsBetween } from './clock.js';
import { mulDiv, pct } from './fixed.js';
import type { Calendar } from './marketHours.js';
import { addDays, ISRAEL, zonedToInstant } from './time.js';
import { weekOf } from './week.js';

// return_rank, stability_rank and score are NUMERIC(6,2): 2 decimals. 100.00 = 10000n.
export const RANK_SCALE = 2;
export const RANK_MAX = 10_000n;

// The brief's weights, out of 100: score = (85 × return rank + 15 × stability rank) / 100.
export const RETURN_WEIGHT = 85n;
export const STABILITY_WEIGHT = 15n;
const WEIGHTS = RETURN_WEIGHT + STABILITY_WEIGHT;

// ---------- who is ranked, with which numbers ----------

// One portfolio row as the runner left it (D-024). equity and weekStartValue are ₪ (SCALE.ILS); maxDrawdownPct
// is PCT.
export type WeekRow = {
  weekStart: string | null;        // the Monday the running totals belong to
  weekStartValue: bigint | null;
  equity: bigint;
  maxDrawdownPct: bigint;
  hasOpenPosition: boolean;        // holds at least one stock now
};

// Ranked at an event of `week` (its Monday, Israel date): the runner touched the player this week (they held a
// stock at an open or close of it, or an order of theirs ran at one), or they hold a stock now. A player who only
// holds cash and wasn't touched this week is not ranked: an idle sign-up isn't competing, and in a falling week a
// crowd of untouched cash accounts (return 0, drawdown 0) would fill the top. A player who sold everything
// earlier this week stays ranked, with the numbers they locked in. A player holding only US stocks is ranked from
// Monday's first event (the TASE open), with 0 / 0 until New York opens.
export function isRanked(row: Pick<WeekRow, 'weekStart' | 'hasOpenPosition'>, week: string): boolean {
  return row.weekStart === week || row.hasOpenPosition;
}

// The numbers a ranked player is scored on, in PCT. The return is the week's so far, rounded half away from
// zero to 4 decimals: the same number as weekReturnPct() (week.ts) and the median's SQL (runner.ts). A row whose
// totals belong to another week hasn't changed value this week: 0 and 0.
export function weekNumbers(row: Omit<WeekRow, 'hasOpenPosition'>, week: string): { returnPct: bigint; maxDrawdownPct: bigint } {
  if (row.weekStart !== week) return { returnPct: 0n, maxDrawdownPct: 0n };
  const start = row.weekStartValue;
  const returnPct = start !== null && start > 0n ? pct(row.equity - start, start) : 0n;
  return { returnPct, maxDrawdownPct: row.maxDrawdownPct };
}

// ---------- the percentiles and the score ----------

// The percentile of a player who did at least as well as `atLeast` of the OTHER `players − 1` ranked players:
// 100 × atLeast / (players − 1), half away from zero to 2 decimals, exact. Tied players count each other, so
// they share the higher percentile (like places 1, 2, 2, 4): the best always gets 100 and the worst, when alone
// at the bottom, 0. A board of one player gives 100.
export function percentile(atLeast: number, players: number): bigint {
  if (!Number.isInteger(players) || players < 1) throw new RangeError(`players must be a whole number ≥ 1, got ${players}`);
  if (!Number.isInteger(atLeast) || atLeast < 0 || atLeast > players - 1) {
    throw new RangeError(`atLeast must be 0..${players - 1}, got ${atLeast}`);
  }
  if (players === 1) return RANK_MAX;
  return mulDiv(BigInt(atLeast), RANK_MAX, BigInt(players - 1), 'half_up');
}

// 0.85 × return rank + 0.15 × stability rank, both at RANK_SCALE, half away from zero to 2 decimals. It takes
// the ranks already rounded (the stored ones), so anyone can check a row of the board by hand.
export function scoreOf(returnRank: bigint, stabilityRank: bigint): bigint {
  return mulDiv(RETURN_WEIGHT * returnRank + STABILITY_WEIGHT * stabilityRank, 1n, WEIGHTS, 'half_up');
}

// ---------- the board ----------

export type RankInput = {
  uid: string;
  createdAtUs: bigint;     // users.created_at in epoch microseconds: Postgres keeps microseconds, a JS Date only ms
  returnPct: bigint;       // PCT
  maxDrawdownPct: bigint;  // PCT, ≥ 0
};

export type Scored = RankInput & {
  returnRank: bigint;      // RANK_SCALE
  stabilityRank: bigint;   // RANK_SCALE
  score: bigint;           // RANK_SCALE
  place: number;           // 1..N, unique
};

// No shared places (D-032): equal scores go by % return (higher first), then the smaller drawdown, then the
// earlier sign-up, then the uid in byte order (Postgres COLLATE "C"). Only percentages decide, never ₪ amounts.
export function comparePlaces(
  a: RankInput & { score: bigint },
  b: RankInput & { score: bigint },
): number {
  return cmp(b.score, a.score)
    || cmp(b.returnPct, a.returnPct)
    || cmp(a.maxDrawdownPct, b.maxDrawdownPct)
    || cmp(a.createdAtUs, b.createdAtUs)
    || compareBytes(a.uid, b.uid);
}

// Scores the ranked players of one event and returns them in place order, places 1..N.
export function scorePlayers(players: readonly RankInput[]): Scored[] {
  const n = players.length;
  if (new Set(players.map((p) => p.uid)).size !== n) throw new Error('scorePlayers: a uid appears twice');
  const returns = players.map((p) => p.returnPct).sort(cmp);
  const drops = players.map((p) => p.maxDrawdownPct).sort(cmp);
  const scored = players.map((p) => {
    // The others with a return ≤ mine, and the others with a drawdown ≥ mine (−1: not myself).
    const returnRank = percentile(upperBound(returns, p.returnPct) - 1, n);
    const stabilityRank = percentile(n - lowerBound(drops, p.maxDrawdownPct) - 1, n);
    return { ...p, returnRank, stabilityRank, score: scoreOf(returnRank, stabilityRank), place: 0 };
  });
  scored.sort(comparePlaces);
  return scored.map((s, i) => ({ ...s, place: i + 1 }));
}

// ---------- the week's end ----------

// Is this the last open or close of its competition week (Monday to Friday)? True when no event is left after it
// before next Monday 00:00 Israel, or none at or before `endsAt` (the world's end: the runner never runs past it).
// At the same instant a close comes before an open, as in eventsBetween. The week's final board (weekly_scores)
// is written at this event.
export function isLastEventOfWeek(
  event: { kind: 'open' | 'close'; at: Date },
  calendar: Calendar,
  endsAt: Date | null,
): boolean {
  const weekEnd = new Date(zonedToInstant(addDays(weekOf(event.at), 7), 0, ISRAEL).getTime() - 1);
  const end = endsAt !== null && endsAt < weekEnd ? endsAt : weekEnd;
  const t = event.at.getTime();
  return !eventsBetween(new Date(t - 1), end, calendar).some(
    (e) => e.at.getTime() > t || (e.at.getTime() === t && e.kind === 'open' && event.kind === 'close'),
  );
}

// ---------- helpers ----------

function cmp(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The first index whose value is ≥ v (sorted ascending).
function lowerBound(sorted: readonly bigint[], v: bigint): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The first index whose value is > v (sorted ascending): the count of values ≤ v.
function upperBound(sorted: readonly bigint[], v: bigint): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Byte order of the UTF-8 strings, as Postgres compares text under COLLATE "C".
const utf8 = new TextEncoder();

export function compareBytes(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const len = Math.min(x.length, y.length);
  for (let i = 0; i < len; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
