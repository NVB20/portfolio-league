// Pure functions behind the trading screen. No database, no network.
// Calendar: 2026-11-09 Monday, 2026-11-11 Wednesday, 2026-11-13 Friday, 2026-11-14 Saturday.
// In November Israel is UTC+2 and New York UTC-5.

import { describe, expect, it } from 'vitest';
import { executionFor } from '../src/game/marketHours.js';
import { barsUpTo, parseYahooDaily, toWeekly } from '../src/game/bars.js';
import { DEFAULT_CHART_SETTINGS, pickChartSettings, withDefaults } from '../src/chartSettings.js';

const at = (iso: string) => new Date(iso);
const run = (market: 'TASE' | 'US', iso: string) => {
  const e = executionFor(market, at(iso));
  return { priceType: e.priceType, day: e.day, at: e.at.toISOString() };
};

describe('executionFor (rule 3)', () => {
  it('TASE open: today at the close, 17:30 Israel', () => {
    expect(run('TASE', '2026-11-11T10:40:00Z')).toEqual({ priceType: 'close', day: '2026-11-11', at: '2026-11-11T15:30:00.000Z' });
  });

  it('TASE before the open: today at the open', () => {
    expect(run('TASE', '2026-11-11T06:00:00Z')).toEqual({ priceType: 'open', day: '2026-11-11', at: '2026-11-11T08:00:00.000Z' });
  });

  it('TASE after the close: the next day at the open', () => {
    expect(run('TASE', '2026-11-11T16:00:00Z')).toEqual({ priceType: 'open', day: '2026-11-12', at: '2026-11-12T08:00:00.000Z' });
  });

  it('TASE open on Friday: the short Friday close, 13:50', () => {
    expect(run('TASE', '2026-11-13T09:00:00Z')).toEqual({ priceType: 'close', day: '2026-11-13', at: '2026-11-13T11:50:00.000Z' });
  });

  it('TASE Friday afternoon and Saturday: Monday at the open', () => {
    expect(run('TASE', '2026-11-13T12:00:00Z').day).toBe('2026-11-16');
    expect(run('TASE', '2026-11-14T12:00:00Z')).toEqual({ priceType: 'open', day: '2026-11-16', at: '2026-11-16T08:00:00.000Z' });
  });

  it('US at 12:40 Israel (closed): today at the New York open, 16:30 Israel', () => {
    expect(run('US', '2026-11-11T10:40:00Z')).toEqual({ priceType: 'open', day: '2026-11-11', at: '2026-11-11T14:30:00.000Z' });
  });

  it('US open: today at the New York close, 23:00 Israel', () => {
    expect(run('US', '2026-11-11T18:00:00Z')).toEqual({ priceType: 'close', day: '2026-11-11', at: '2026-11-11T21:00:00.000Z' });
  });

  it('US on Friday night after the close: Monday at the open', () => {
    expect(run('US', '2026-11-13T21:30:00Z').day).toBe('2026-11-16');
  });
});

// A tiny Yahoo response: 3 days around a weekend, with a null day and a repeated live row.
function yahoo(currency: string, timeZone: string, rows: [number, number | null, number, number, number, number][]) {
  return {
    chart: {
      result: [{
        meta: { currency, exchangeTimezoneName: timeZone },
        timestamp: rows.map((r) => r[0]),
        indicators: { quote: [{
          open: rows.map((r) => r[1]),
          high: rows.map((r) => r[2]),
          low: rows.map((r) => r[3]),
          close: rows.map((r) => r[4]),
          volume: rows.map((r) => r[5]),
        }] },
      }],
    },
  };
}
const ts = (iso: string) => Date.parse(iso) / 1000;

describe('parseYahooDaily', () => {
  it('reads US bars by the New York date and skips days with a missing value', () => {
    const bars = parseYahooDaily(yahoo('USD', 'America/New_York', [
      [ts('2026-11-12T14:30:00Z'), 10, 12, 9, 11, 100],
      [ts('2026-11-13T14:30:00Z'), null, 12, 9, 11, 100],
      [ts('2026-11-16T14:30:00Z'), 11, 13, 10, 12, 200],
    ]));
    expect(bars).toEqual([
      { time: '2026-11-12', open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: '2026-11-16', open: 11, high: 13, low: 10, close: 12, volume: 200 },
    ]);
  });

  it('turns TASE agorot into shekels', () => {
    const [bar] = parseYahooDaily(yahoo('ILA', 'Asia/Jerusalem', [[ts('2026-11-12T07:00:00Z'), 13100, 13300, 13000, 13180, 5]]));
    expect(bar).toEqual({ time: '2026-11-12', open: 131, high: 133, low: 130, close: 131.8, volume: 5 });
  });

  it('keeps the last row when Yahoo repeats a day', () => {
    const bars = parseYahooDaily(yahoo('USD', 'America/New_York', [
      [ts('2026-11-12T14:30:00Z'), 10, 12, 9, 11, 100],
      [ts('2026-11-12T20:59:00Z'), 10, 13, 9, 12.5, 150],
    ]));
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(12.5);
  });

  it('returns nothing for an empty or broken response', () => {
    expect(parseYahooDaily({})).toEqual([]);
    expect(parseYahooDaily(null)).toEqual([]);
  });
});

describe('barsUpTo and toWeekly', () => {
  const bar = (time: string, open: number, high: number, low: number, close: number, volume = 1) => ({ time, open, high, low, close, volume });
  const daily = [
    bar('2026-11-09', 10, 11, 9, 10.5),
    bar('2026-11-10', 10.5, 12, 10, 11.5),
    bar('2026-11-11', 11.5, 11.8, 8, 9),
    bar('2026-11-16', 9, 10, 8.5, 9.5),
  ];

  it('drops every bar after the last closed day (no future)', () => {
    expect(barsUpTo(daily, '2026-11-10').map((b) => b.time)).toEqual(['2026-11-09', '2026-11-10']);
  });

  it('builds Monday-keyed weekly bars from the days that happened', () => {
    expect(toWeekly(daily)).toEqual([
      { time: '2026-11-09', open: 10, high: 12, low: 8, close: 9, volume: 3 },
      { time: '2026-11-16', open: 9, high: 10, low: 8.5, close: 9.5, volume: 1 },
    ]);
  });

  it('a week in progress only has the days so far', () => {
    expect(toWeekly(barsUpTo(daily, '2026-11-10'))[0]).toEqual({ time: '2026-11-09', open: 10, high: 12, low: 9, close: 11.5, volume: 2 });
  });
});

describe('chart settings', () => {
  it('keeps only known keys with allowed values', () => {
    expect(pickChartSettings({ type: 'line', range: 66, grid: false, roles: ['admin'], bg: 'pink', volume: 'yes' }))
      .toEqual({ type: 'line', range: 66, grid: false });
  });

  it('returns null when nothing is valid', () => {
    expect(pickChartSettings({ hack: 1 })).toBeNull();
    expect(pickChartSettings([])).toBeNull();
    expect(pickChartSettings('candles')).toBeNull();
  });

  it('fills the rest from the defaults, and ignores broken saved values', () => {
    expect(withDefaults({ colors: 'blue', tf: 'Y' })).toEqual({ ...DEFAULT_CHART_SETTINGS, colors: 'blue' });
    expect(withDefaults(null)).toEqual(DEFAULT_CHART_SETTINGS);
  });
});
