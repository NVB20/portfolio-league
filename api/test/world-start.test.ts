// When the world clock starts (D-013). Pure, no database.

import { describe, expect, it } from 'vitest';
import { HISTORY_DAYS, worldStartAt, worldStartDay } from '../src/game/worldStart.js';

describe('worldStartDay', () => {
  it('starts on the first Monday at least 20 days after the history begins', () => {
    // 2023-11-06 + 20 = Sunday 2023-11-26 → Monday 2023-11-27
    expect(HISTORY_DAYS).toBe(20);
    expect(worldStartDay('2023-11-06')).toBe('2023-11-27');
  });

  it('keeps the day when 20 days later is already a Monday', () => {
    // 2023-11-14 + 20 = Monday 2023-12-04
    expect(worldStartDay('2023-11-14')).toBe('2023-12-04');
  });

  it('moves forward up to 6 days, never back', () => {
    // Every weekday of one week as the first day of history: always a Monday, 20 to 26 days later.
    for (let i = 0; i < 7; i++) {
      const start = `2023-11-${String(6 + i).padStart(2, '0')}`;
      const day = worldStartDay(start);
      const gap = (Date.parse(day) - Date.parse(start)) / 86_400_000;
      expect(new Date(`${day}T12:00:00Z`).getUTCDay()).toBe(1);
      expect(gap).toBeGreaterThanOrEqual(20);
      expect(gap).toBeLessThan(27);
    }
  });

  it('crosses a month and a year', () => {
    expect(worldStartDay('2023-12-20')).toBe('2024-01-15');   // + 20 = Tue 2024-01-09 → Mon 2024-01-15
  });
});

describe('worldStartAt', () => {
  it('is 09:00 Israel time: 07:00 UTC in winter', () => {
    expect(worldStartAt('2023-11-06').toISOString()).toBe('2023-11-27T07:00:00.000Z');
  });

  it('is 06:00 UTC in Israel summer time', () => {
    // 2024-06-01 + 20 = Fri 2024-06-21 → Mon 2024-06-24, Israel UTC+3
    expect(worldStartAt('2024-06-01').toISOString()).toBe('2024-06-24T06:00:00.000Z');
  });
});
