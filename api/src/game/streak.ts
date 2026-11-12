// The daily streak (D-039): real Israel calendar days in a row on which the player was in the app.
// Days, not 24-hour timers: in on 11.11 at 00:05 and again on 12.11 at 22:30 is 46 hours apart, but two days in a
// row, so the streak lives. It breaks only when a whole date passes with no entry.
// Pure: no database, no clock. Every date is an Israel calendar date, 'YYYY-MM-DD', that Postgres worked out from
// its own now() (never the phone's clock, never the world clock).

import type { StreakView } from '../contract.js';
import { addDays, weekdayOf } from './time.js';

export type Streak = {
  days: number;               // days in a row, ending on lastDay
  best: number;               // the longest run so far
  lastDay: string | null;     // the last day counted; null = never
  weekStart: string | null;   // the Sunday of the week weekDays belongs to; null = never
  weekDays: number;           // bit d set = in the app on weekday d of that week (0 = Sunday ... 6 = Saturday)
};

export const NO_STREAK: Streak = { days: 0, best: 0, lastDay: null, weekStart: null, weekDays: 0 };

// The Sunday that starts the real week (Sunday to Saturday) holding `date`.
export function sundayOf(date: string): string {
  return addDays(date, -weekdayOf(date));
}

// The player is in the app on `today`. Returns the new streak, or null when there is nothing to write: today is
// already counted, or `today` is before the last day counted (a clock that stepped back changes nothing).
export function countDay(s: Streak, today: string): Streak | null {
  if (s.lastDay !== null && s.lastDay >= today) return null;
  const days = s.lastDay === addDays(today, -1) ? s.days + 1 : 1;
  const week = sundayOf(today);
  const bit = 1 << weekdayOf(today);
  return {
    days,
    best: Math.max(s.best, days),
    lastDay: today,
    weekStart: week,
    weekDays: s.weekStart === week ? s.weekDays | bit : bit,
  };
}

// What the card shows on `today`. A streak whose last day is before yesterday is over, so it shows 0; nothing has
// to run at midnight to break it. The week is this real week, Sunday to Saturday: any day the player was in the
// app, whether or not the streak broke since.
export function streakView(s: Streak, today: string): StreakView {
  const alive = s.lastDay === today || s.lastDay === addDays(today, -1);
  const mask = s.weekStart === sundayOf(today) ? s.weekDays : 0;
  return {
    days: alive ? s.days : 0,
    best: s.best,
    countedToday: s.lastDay === today,
    week: Array.from({ length: 7 }, (_, d) => (mask & (1 << d)) !== 0),
    weekday: weekdayOf(today),
  };
}
