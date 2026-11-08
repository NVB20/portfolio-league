// The pure game functions, with hand-checked examples. No database.
// Calendar used below: 2026-11-09 is a Monday, 2026-11-11 a Wednesday, 2026-11-13 a Friday.
// In November Israel is UTC+2 and New York UTC-5 (7 hours apart).

import { describe, expect, it } from 'vitest';
import { isMarketOpen, sessionOn } from '../src/game/marketHours.js';
import { isNearCap, maxDrawdownPct, returnPct, weightPct } from '../src/game/performance.js';
import { ISRAEL, isoWeek, mondayOf, zonedParts, zonedToInstant } from '../src/game/time.js';

describe('time', () => {
  it('reads the Israel wall clock from a UTC instant', () => {
    expect(zonedParts(new Date('2026-11-11T10:40:00Z'), ISRAEL)).toEqual({
      date: '2026-11-11',
      weekday: 3,
      minutes: 12 * 60 + 40,
    });
  });

  it('rolls the date over at Israel midnight, not UTC midnight', () => {
    expect(zonedParts(new Date('2026-11-11T22:30:00Z'), ISRAEL).date).toBe('2026-11-12');
  });

  it('turns an Israel wall clock back into an instant', () => {
    expect(zonedToInstant('2026-11-11', 10 * 60, ISRAEL).toISOString()).toBe('2026-11-11T08:00:00.000Z');
    // Summer time (UTC+3)
    expect(zonedToInstant('2026-07-15', 10 * 60, ISRAEL).toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });

  it('gives the ISO week and the Monday of the week', () => {
    expect(isoWeek('2026-11-11')).toBe(46);
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(mondayOf('2026-11-11')).toBe('2026-11-09');
    expect(mondayOf('2026-11-09')).toBe('2026-11-09');
    expect(mondayOf('2026-11-15')).toBe('2026-11-09');   // Sunday belongs to the week that started Monday
  });
});

describe('market hours', () => {
  it('TASE: 10:00-17:30 Monday to Thursday, 13:50 on Friday, closed on the weekend', () => {
    expect(sessionOn('TASE', '2026-11-11')).toEqual({ openMin: 600, closeMin: 1050 });
    expect(sessionOn('TASE', '2026-11-13')).toEqual({ openMin: 600, closeMin: 830 });
    expect(sessionOn('TASE', '2026-11-14')).toBeNull();   // Saturday
    expect(sessionOn('TASE', '2026-11-15')).toBeNull();   // Sunday (TASE moved to Mon-Fri in 2026)
  });

  it('US: 9:30-16:00 New York is 16:30-23:00 in Israel in November', () => {
    expect(sessionOn('US', '2026-11-11')).toEqual({ openMin: 16 * 60 + 30, closeMin: 23 * 60 });
    expect(sessionOn('US', '2026-11-14')).toBeNull();
  });

  it('US: 15:30-22:00 in Israel when only New York is on summer time (March)', () => {
    expect(sessionOn('US', '2026-03-10')).toEqual({ openMin: 15 * 60 + 30, closeMin: 22 * 60 });
  });

  it('knows whether a market is open at a moment', () => {
    expect(isMarketOpen('TASE', new Date('2026-11-11T10:40:00Z'))).toBe(true);    // 12:40 Israel
    expect(isMarketOpen('US', new Date('2026-11-11T10:40:00Z'))).toBe(false);
    expect(isMarketOpen('TASE', new Date('2026-11-11T08:00:00Z'))).toBe(true);    // 10:00, the opening minute
    expect(isMarketOpen('TASE', new Date('2026-11-11T15:30:00Z'))).toBe(false);   // 17:30, the close
    expect(isMarketOpen('TASE', new Date('2026-11-13T12:00:00Z'))).toBe(false);   // Friday 14:00
    expect(isMarketOpen('US', new Date('2026-11-11T15:00:00Z'))).toBe(true);      // 17:00 Israel
  });
});

describe('performance', () => {
  it('weekly return from first to last value', () => {
    expect(returnPct([1_000_000, 1_023_500])).toBeCloseTo(2.35);
    expect(returnPct([1_000_000])).toBeNull();
    expect(returnPct([])).toBeNull();
  });

  it('max drawdown is the biggest peak-to-later-low drop', () => {
    expect(maxDrawdownPct([100, 120, 90, 130, 117])).toBeCloseTo(25);   // 120 -> 90
    expect(maxDrawdownPct([100, 101, 102])).toBe(0);                     // never fell
    expect(maxDrawdownPct([])).toBe(0);
  });

  it('a low BEFORE the peak is not a drawdown', () => {
    expect(maxDrawdownPct([100, 80, 150])).toBeCloseTo(20);   // 100 -> 80, not 150 -> 80
  });

  it('weight and the near-cap warning', () => {
    expect(weightPct(194_000, 1_000_000)).toBeCloseTo(19.4);
    expect(weightPct(10, 0)).toBeNull();
    expect(isNearCap(19.4)).toBe(true);
    expect(isNearCap(12.8)).toBe(false);
    expect(isNearCap(null)).toBe(false);
  });
});
