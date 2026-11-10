// When the world clock starts (D-013). Pure, no database.
// Players arrive with history behind them: the dollar card, last prices and the 10-day charts only use
// closes that already happened in world time (D-009), so starting on the first day of data shows nothing.

import { addDays, ISRAEL, weekdayOf, zonedToInstant } from './time.js';

export const HISTORY_DAYS = 20;          // days of price history already behind the world when it starts
const START_MINUTES = 9 * 60;            // 09:00 Israel time, one hour before TASE opens
const MONDAY = 1;

// The first Monday at least `historyDays` after the history begins, so the first game week is a full week
// (the leaderboard is weekly). `historyStart` is the first day every series (TASE, US, USD/ILS) has data.
export function worldStartDay(historyStart: string, historyDays: number = HISTORY_DAYS): string {
  let day = addDays(historyStart, historyDays);
  while (weekdayOf(day) !== MONDAY) day = addDays(day, 1);
  return day;
}

// The clock's first instant: that Monday at 09:00 Israel time (summer time handled by the time zone).
export function worldStartAt(historyStart: string, historyDays: number = HISTORY_DAYS): Date {
  return zonedToInstant(worldStartDay(historyStart, historyDays), START_MINUTES, ISRAEL);
}
