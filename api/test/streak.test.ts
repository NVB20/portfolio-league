// The daily streak's pure rules (D-039), with hand-checked examples. No database.
// Calendar used below: 2026-11-08 is a Sunday, 2026-11-11 a Wednesday, 2026-11-14 a Saturday, 2026-11-15 a Sunday.
// In November Israel is UTC+2.

import { describe, expect, it } from 'vitest';
import { countDay, NO_STREAK, type Streak, streakView, sundayOf } from '../src/game/streak.js';
import { ISRAEL, zonedParts } from '../src/game/time.js';

// Logs each day in turn, from no streak at all.
function logged(...days: string[]): Streak {
  let s = NO_STREAK;
  for (const d of days) s = countDay(s, d) ?? s;
  return s;
}

const israelDate = (iso: string) => zonedParts(new Date(iso), ISRAEL).date;

describe('countDay: days, not 24-hour timers', () => {
  it('in on 11.11 at 00:05 and on 12.11 at 22:30 is 46 hours apart, but two days in a row', () => {
    const first = israelDate('2026-11-10T22:05:00Z');    // Wednesday 11.11, 00:05 Israel
    const second = israelDate('2026-11-12T20:30:00Z');   // Thursday 12.11, 22:30 Israel
    expect([first, second]).toEqual(['2026-11-11', '2026-11-12']);
    expect(logged(first, second)).toMatchObject({ days: 2, best: 2, lastDay: '2026-11-12' });
  });

  it('in on 11.11 at 23:55 and on 12.11 at 00:05 (ten minutes apart) is also two days', () => {
    const first = israelDate('2026-11-11T21:55:00Z');
    const second = israelDate('2026-11-11T22:05:00Z');
    expect(logged(first, second)).toMatchObject({ days: 2 });
  });

  it('the first day ever starts a streak of 1', () => {
    expect(countDay(NO_STREAK, '2026-11-11')).toEqual({
      days: 1, best: 1, lastDay: '2026-11-11', weekStart: '2026-11-08', weekDays: 0b0001000,
    });
  });

  it('a second entry on the same day changes nothing (nothing to write)', () => {
    expect(countDay(logged('2026-11-11'), '2026-11-11')).toBeNull();
  });

  it('a whole date with no entry breaks it: the next day starts again at 1, the best stays', () => {
    const s = countDay(logged('2026-11-09', '2026-11-10', '2026-11-11'), '2026-11-13');
    expect(s).toMatchObject({ days: 1, best: 3, lastDay: '2026-11-13' });
  });

  it('a day before the last one counted changes nothing (a clock that stepped back)', () => {
    expect(countDay(logged('2026-11-12'), '2026-11-11')).toBeNull();
  });

  it('every day counts, the weekend too: Friday, Saturday, Sunday is 3 in a row', () => {
    expect(logged('2026-11-13', '2026-11-14', '2026-11-15')).toMatchObject({ days: 3 });
  });
});

describe('the week: Sunday to Saturday', () => {
  it('sundayOf gives the Sunday that starts the week, Sunday itself included', () => {
    expect(sundayOf('2026-11-08')).toBe('2026-11-08');
    expect(sundayOf('2026-11-11')).toBe('2026-11-08');
    expect(sundayOf('2026-11-14')).toBe('2026-11-08');
    expect(sundayOf('2026-11-15')).toBe('2026-11-15');
  });

  it('marks each day of the week the player was in, one bit per weekday', () => {
    expect(logged('2026-11-08', '2026-11-09', '2026-11-11')).toMatchObject({ weekStart: '2026-11-08', weekDays: 0b0001011 });
  });

  it('a new Sunday starts a new week, but the streak goes on', () => {
    expect(logged('2026-11-13', '2026-11-14', '2026-11-15')).toMatchObject({ days: 3, weekStart: '2026-11-15', weekDays: 0b0000001 });
  });

  it('days before a break stay marked: the week shows every day the player was in', () => {
    const s = logged('2026-11-08', '2026-11-09', '2026-11-11');   // missed Tuesday
    expect(streakView(s, '2026-11-11')).toMatchObject({
      days: 1,
      week: [true, true, false, true, false, false, false],
    });
  });
});

describe('streakView: what the card shows', () => {
  const s = logged('2026-11-09', '2026-11-10', '2026-11-11');   // Monday to Wednesday

  it('counted today: the streak, the best, this week, and today', () => {
    expect(streakView(s, '2026-11-11')).toEqual({
      days: 3,
      best: 3,
      countedToday: true,
      week: [false, true, true, true, false, false, false],
      weekday: 3,
    });
  });

  it('the next day before the first entry: still alive, today not counted yet', () => {
    expect(streakView(s, '2026-11-12')).toMatchObject({ days: 3, countedToday: false, weekday: 4 });
  });

  it('a whole day missed: shows 0, with no job at midnight; the best stays', () => {
    expect(streakView(s, '2026-11-13')).toMatchObject({ days: 0, best: 3, countedToday: false });
  });

  it('in a later week the dots start empty', () => {
    expect(streakView(s, '2026-11-15').week).toEqual([false, false, false, false, false, false, false]);
  });

  it('a player never seen: no streak, an empty week', () => {
    expect(streakView(NO_STREAK, '2026-11-11')).toEqual({
      days: 0, best: 0, countedToday: false, week: [false, false, false, false, false, false, false], weekday: 3,
    });
  });
});
