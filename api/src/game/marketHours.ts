// Trading hours from the brief, as pure functions.
//   TASE: Monday to Thursday 10:00–17:30, Friday 10:00–13:50 (Israel time).
//   US:   Monday to Friday 9:30–16:00 (New York time).
// Holidays are not modelled here: a day with no row in `prices` simply has no price.

import { addDays, ISRAEL, NEW_YORK, weekdayOf, zonedParts, zonedToInstant } from './time.js';

export type Market = 'TASE' | 'US';
export type Session = { openMin: number; closeMin: number };   // Israel-time minutes since midnight

const TASE_OPEN = 10 * 60;
const TASE_CLOSE = 17 * 60 + 30;
const TASE_FRIDAY_CLOSE = 13 * 60 + 50;
const US_OPEN_NY = 9 * 60 + 30;
const US_CLOSE_NY = 16 * 60;

// The session of `market` on an Israel calendar date, in Israel time. null = closed all day.
export function sessionOn(market: Market, israelDate: string): Session | null {
  const weekday = weekdayOf(israelDate);
  if (market === 'TASE') {
    if (weekday >= 1 && weekday <= 4) return { openMin: TASE_OPEN, closeMin: TASE_CLOSE };
    if (weekday === 5) return { openMin: TASE_OPEN, closeMin: TASE_FRIDAY_CLOSE };
    return null;
  }
  // The New York session of the same calendar date ends before midnight in Israel (23:00, or 22:00/23:00
  // in the weeks when only one country is on daylight saving), so the dates line up.
  if (weekday === 0 || weekday === 6) return null;
  const toIsrael = (nyMinutes: number) =>
    zonedParts(zonedToInstant(israelDate, nyMinutes, NEW_YORK), ISRAEL).minutes;
  return { openMin: toIsrael(US_OPEN_NY), closeMin: toIsrael(US_CLOSE_NY) };
}

// The latest trading-day date whose CLOSE has already happened at this instant: today after the close,
// otherwise yesterday. Prices on or before this date are known; later ones are the future and must not leak.
// Weekends need no special case: there are no price rows for them, so "on or before" finds the last trading day.
export function lastClosedDay(market: Market, instant: Date): string {
  const { date, minutes } = zonedParts(instant, ISRAEL);
  const s = sessionOn(market, date);
  return s !== null && minutes >= s.closeMin ? date : addDays(date, -1);
}

// Is `market` open at this instant? Open includes the opening minute, not the closing one.
export function isMarketOpen(market: Market, instant: Date): boolean {
  const { date, minutes } = zonedParts(instant, ISRAEL);
  const s = sessionOn(market, date);
  return s !== null && minutes >= s.openMin && minutes < s.closeMin;
}
