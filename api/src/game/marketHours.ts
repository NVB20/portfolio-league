// Trading hours from the brief, as pure functions.
//   TASE: Monday to Thursday 10:00–17:30, Friday 10:00–13:50 (Israel time).
//   US:   Monday to Friday 9:30–16:00 (New York time).
// Saturdays and Sundays are closed by rule. Every other closed day (holidays, and TASE Fridays before
// 2026) comes from the `market_closures` table through a `Calendar` (D-016, D-022).

import { addDays, ISRAEL, NEW_YORK, weekdayOf, zonedParts, zonedToInstant } from './time.js';

export type Market = 'TASE' | 'US';
export const MARKETS: readonly Market[] = ['TASE', 'US'];
export type Session = { openMin: number; closeMin: number };   // Israel-time minutes since midnight

// Which weekdays a market is closed, and why. Built from the `market_closures` rows.
export type Calendar = { closedReason(market: Market, date: string): string | null };

export type Closure = { market: Market; day: string; reason: string };

export function makeCalendar(rows: readonly Closure[]): Calendar {
  const reasons = new Map(rows.map((r) => [`${r.market}|${r.day}`, r.reason]));
  return { closedReason: (market, date) => reasons.get(`${market}|${date}`) ?? null };
}

// No holidays: only the weekend rule. For tests and for callers that have not loaded the calendar.
export const NO_CLOSURES: Calendar = { closedReason: () => null };

// Long enough for any real holiday run (Sukkot + a weekend), short enough to stop a bad calendar looping forever.
const MAX_CLOSED_RUN = 30;

const TASE_OPEN = 10 * 60;
const TASE_CLOSE = 17 * 60 + 30;
const TASE_FRIDAY_CLOSE = 13 * 60 + 50;
const US_OPEN_NY = 9 * 60 + 30;
const US_CLOSE_NY = 16 * 60;

function isWeekend(date: string): boolean {
  const weekday = weekdayOf(date);
  return weekday === 0 || weekday === 6;
}

// The session of `market` on an Israel calendar date, in Israel time. null = closed all day.
export function sessionOn(market: Market, israelDate: string, calendar: Calendar = NO_CLOSURES): Session | null {
  if (isWeekend(israelDate) || calendar.closedReason(market, israelDate) !== null) return null;
  if (market === 'TASE') {
    return { openMin: TASE_OPEN, closeMin: weekdayOf(israelDate) === 5 ? TASE_FRIDAY_CLOSE : TASE_CLOSE };
  }
  // The New York session of the same calendar date ends before midnight in Israel (23:00, or 22:00/23:00
  // in the weeks when only one country is on daylight saving), so the dates line up.
  const toIsrael = (nyMinutes: number) =>
    zonedParts(zonedToInstant(israelDate, nyMinutes, NEW_YORK), ISRAEL).minutes;
  return { openMin: toIsrael(US_OPEN_NY), closeMin: toIsrael(US_CLOSE_NY) };
}

// Is `market` open at this instant? Open includes the opening minute, not the closing one.
export function isMarketOpen(market: Market, instant: Date, calendar: Calendar = NO_CLOSURES): boolean {
  const { date, minutes } = zonedParts(instant, ISRAEL);
  const s = sessionOn(market, date, calendar);
  return s !== null && minutes >= s.openMin && minutes < s.closeMin;
}

// The latest trading-day date whose CLOSE has already happened at this instant: today after the close,
// otherwise the day before. Prices on or before this date are known; later ones are the future and must not leak.
// Closed days need no special case: they have no price rows, so "on or before" finds the last trading day.
export function lastClosedDay(market: Market, instant: Date, calendar: Calendar = NO_CLOSURES): string {
  const { date, minutes } = zonedParts(instant, ISRAEL);
  const s = sessionOn(market, date, calendar);
  return s !== null && minutes >= s.closeMin ? date : addDays(date, -1);
}

export type MarketEvent = {
  market: Market;
  kind: 'open' | 'close';
  day: string;   // Israel calendar date of the session
  at: Date;
};

function eventAt(market: Market, kind: 'open' | 'close', day: string, s: Session): MarketEvent {
  return { market, kind, day, at: zonedToInstant(day, kind === 'open' ? s.openMin : s.closeMin, ISRAEL) };
}

// The first open of `market` strictly after `instant` (later today if it hasn't opened yet).
export function nextOpen(market: Market, instant: Date, calendar: Calendar = NO_CLOSURES): MarketEvent {
  const { date, minutes } = zonedParts(instant, ISRAEL);
  const today = sessionOn(market, date, calendar);
  if (today && minutes < today.openMin) return eventAt(market, 'open', date, today);
  for (let i = 1; i <= MAX_CLOSED_RUN; i++) {
    const day = addDays(date, i);
    const s = sessionOn(market, day, calendar);
    if (s) return eventAt(market, 'open', day, s);
  }
  throw new Error(`no ${market} session in the ${MAX_CLOSED_RUN} days after ${date}`);
}

export type Execution = {
  priceType: 'open' | 'close';
  day: string;   // the trading day whose open/close is used (Israel calendar date)
  at: Date;      // the instant that price happens
};

// When an order sent at `instant` runs (brief, rule 3):
//   market open now   -> today's close
//   market closed now -> the next trading day's open (later today, if the market hasn't opened yet)
export function executionFor(market: Market, instant: Date, calendar: Calendar = NO_CLOSURES): Execution {
  const { date, minutes } = zonedParts(instant, ISRAEL);
  const today = sessionOn(market, date, calendar);
  if (today && minutes >= today.openMin && minutes < today.closeMin) {
    return { priceType: 'close', day: date, at: zonedToInstant(date, today.closeMin, ISRAEL) };
  }
  const open = nextOpen(market, instant, calendar);
  return { priceType: 'open', day: open.day, at: open.at };
}

export type MarketState = 'open' | 'pre_open' | 'after_close' | 'weekend' | 'holiday';

export type MarketStatus = {
  market: Market;
  state: MarketState;
  reason: string | null;   // why it is closed today: the holiday name, or null
  session: Session | null; // today's hours, null when closed all day
  nextOpenAt: Date | null; // null while open
};

// What the screens show for one market at this instant (D-022).
export function marketStatus(market: Market, instant: Date, calendar: Calendar = NO_CLOSURES): MarketStatus {
  const { date, minutes } = zonedParts(instant, ISRAEL);
  const session = sessionOn(market, date, calendar);
  let state: MarketState;
  let reason: string | null = null;
  if (session === null) {
    reason = isWeekend(date) ? null : calendar.closedReason(market, date);
    state = isWeekend(date) ? 'weekend' : 'holiday';
  } else if (minutes < session.openMin) state = 'pre_open';
  else if (minutes < session.closeMin) state = 'open';
  else state = 'after_close';
  return {
    market,
    state,
    reason,
    session,
    nextOpenAt: state === 'open' ? null : nextOpen(market, instant, calendar).at,
  };
}
