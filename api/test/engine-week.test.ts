// Marks, totals and the weekly running totals (api/src/game/week.ts; D-019, D-024, D-025). Pure, no database.
// Calendar: Monday 09.11.2026 and Monday 16.11.2026. In November Israel is UTC+2, so the TASE open
// (10:00) is 08:00Z and the TASE close (17:30) 15:30Z.

import { describe, expect, it } from 'vitest';
import { avgCost, parse, SCALE, valueIls } from '../src/game/fixed.js';
import type { PositionState } from '../src/game/engine.js';
import type { Market } from '../src/game/marketHours.js';
import {
  applyEvent, markPositions, median, startWeek, totals, type WeekState, weekOf, weekReturnPct,
} from '../src/game/week.js';

const ils = (s: string) => parse(s, SCALE.ILS);
const units = (s: string) => parse(s, SCALE.UNITS);
const price = (s: string) => parse(s, SCALE.PRICE);
const rate = (s: string) => parse(s, SCALE.RATE);
const pctOf = (s: string) => parse(s, SCALE.PCT);
const at = (iso: string) => new Date(iso);

function position(symbol: string, market: Market, u: string, cost: string, more: Partial<PositionState> = {}): PositionState {
  const un = units(u);
  const cb = ils(cost);
  return {
    id: '1', symbol, market, status: 'open',
    units: un, reservedUnits: 0n, costBasis: cb, avgCost: avgCost(cb, un), realizedPnl: 0n,
    lastPrice: null, lastRate: null, marketValue: null, markedAt: null,
    openedAt: at('2026-11-02T08:00:00Z'), closedAt: null,
    ...more,
  };
}

// ---------- marks ----------

describe('markPositions', () => {
  const positions = [
    position('A', 'TASE', '10', '1000.00', { reservedUnits: units('4') }),
    position('B', 'TASE', '5', '500.00', { lastPrice: price('100.0000'), marketValue: ils('500.00') }),
    position('N', 'US', '2', '1100.00'),
  ];

  it('re-marks only this market\'s positions that have a price, and makes new objects', () => {
    const before = structuredClone(positions);
    const when = at('2026-11-09T15:30:00Z');
    // N is a US stock: a stray price for it in a TASE event's map must be ignored.
    const out = markPositions(positions, 'TASE', new Map([['A', price('110.0000')], ['N', price('1.0000')]]), rate('3.7000'), when);
    expect(out[0]).toEqual({ ...positions[0], lastPrice: price('110.0000'), lastRate: null, marketValue: ils('1100.00'), markedAt: when });
    expect(out[1]).toEqual(positions[1]);         // no price at this event
    expect(out[2]).toEqual(positions[2]);         // the other market
    out.forEach((p, i) => expect(p).not.toBe(positions[i]));
    expect(positions).toEqual(before);
  });

  it('uses the event rate for US positions and stores it', () => {
    const when = at('2026-11-09T21:00:00Z');
    const out = markPositions(positions, 'US', new Map([['N', price('150.0000')]]), rate('3.7000'), when);
    expect(out[2]).toMatchObject({
      lastPrice: price('150.0000'), lastRate: rate('3.7000'), markedAt: when,
      marketValue: valueIls(units('2'), price('150.0000'), rate('3.7000')),   // 2 × 150 × 3.7 = 1,110.00
    });
    expect(out[2].marketValue).toBe(ils('1110.00'));
    expect(out[0]).toEqual(positions[0]);
  });

  it('values TASE at rate 1.0000 whatever rate it is given', () => {
    const out = markPositions(positions, 'TASE', new Map([['A', price('110.0000')]]), rate('3.7000'), at('2026-11-09T15:30:00Z'));
    expect(out[0].marketValue).toBe(ils('1100.00'));
  });
});

describe('totals', () => {
  it('adds the marks, counts an unmarked position at cost, and sums gains and losses', () => {
    const t = totals(ils('900000.00'), [
      position('A', 'TASE', '10', '1000.00', { marketValue: ils('1100.00') }),   // +100
      position('B', 'TASE', '5', '500.00'),                                       // no mark: at cost, 0
      position('C', 'US', '1', '400.00', { marketValue: ils('300.00') }),        // −100
    ]);
    expect(t).toEqual({ holdingsValue: ils('1900.00'), equity: ils('901900.00'), unrealizedPnl: 0n });
  });

  it('a cash-only portfolio is worth its cash', () => {
    expect(totals(ils('1000000.00'), [])).toEqual({ holdingsValue: 0n, equity: ils('1000000.00'), unrealizedPnl: 0n });
  });
});

// ---------- the week ----------

const EMPTY: WeekState = { weekStart: null, weekStartValue: null, peakValue: null, maxDrawdownPct: 0n, lastEventAt: null };
const MON_OPEN = at('2026-11-09T08:00:00Z');
const MON_CLOSE = at('2026-11-09T15:30:00Z');
const TUE_OPEN = at('2026-11-10T08:00:00Z');
const TUE_CLOSE = at('2026-11-10T15:30:00Z');
const WED_OPEN = at('2026-11-11T08:00:00Z');
const NEXT_MON_OPEN = at('2026-11-16T08:00:00Z');

describe('weekOf', () => {
  it('is the Monday of the Israel calendar date', () => {
    expect(weekOf(MON_OPEN)).toBe('2026-11-09');
    expect(weekOf(at('2026-11-13T21:00:00Z'))).toBe('2026-11-09');   // Friday 23:00 Israel, the US close
    expect(weekOf(at('2026-11-15T21:00:00Z'))).toBe('2026-11-09');   // Sunday 23:00 Israel
    expect(weekOf(at('2026-11-15T22:30:00Z'))).toBe('2026-11-16');   // Monday 00:30 Israel, still Sunday in UTC
  });
});

describe('applyEvent', () => {
  it('starts a never-touched row from the value before the event', () => {
    const w = applyEvent(EMPTY, MON_OPEN, ils('1000000.00'), ils('1010000.00'));
    expect(w).toEqual({
      weekStart: '2026-11-09', weekStartValue: ils('1000000.00'), peakValue: ils('1010000.00'),
      maxDrawdownPct: 0n, lastEventAt: MON_OPEN,
    });
  });

  it('tracks the peak and the worst drop from it through the week', () => {
    const steps: [Date, string, string, string, string][] = [
      // event, value before, value after, expected peak, expected max drawdown %
      [MON_OPEN, '1000000.00', '1050000.00', '1050000.00', '0'],
      [MON_CLOSE, '1050000.00', '1000000.00', '1050000.00', '4.7619'],   // 50,000 / 1,050,000
      [TUE_OPEN, '1000000.00', '1020000.00', '1050000.00', '4.7619'],    // a smaller drop doesn't lower it
      [TUE_CLOSE, '1020000.00', '945000.00', '1050000.00', '10'],        // 105,000 / 1,050,000
      [WED_OPEN, '945000.00', '1100000.00', '1100000.00', '10'],         // a new peak keeps the worst drop
    ];
    let w: WeekState = EMPTY;
    for (const [when, before, after, peak, dd] of steps) {
      w = applyEvent(w, when, ils(before), ils(after))!;
      expect(w).toEqual({
        weekStart: '2026-11-09', weekStartValue: ils('1000000.00'), peakValue: ils(peak),
        maxDrawdownPct: pctOf(dd), lastEventAt: when,
      });
    }
  });

  it('returns null for an event already applied, or an older one (the retry guard)', () => {
    const w = applyEvent(EMPTY, MON_CLOSE, ils('1000000.00'), ils('990000.00'))!;
    expect(applyEvent(w, MON_CLOSE, ils('990000.00'), ils('900000.00'))).toBeNull();
    expect(applyEvent(w, MON_OPEN, ils('990000.00'), ils('900000.00'))).toBeNull();
    expect(applyEvent(w, TUE_OPEN, ils('990000.00'), ils('980000.00'))).not.toBeNull();
  });

  it('resets lazily on the first event of a new week, from the value before it', () => {
    const lastWeek: WeekState = {
      weekStart: '2026-11-09', weekStartValue: ils('1000000.00'), peakValue: ils('1100000.00'),
      maxDrawdownPct: pctOf('10'), lastEventAt: WED_OPEN,
    };
    expect(applyEvent(lastWeek, NEXT_MON_OPEN, ils('1100000.00'), ils('1089000.00'))).toEqual({
      weekStart: '2026-11-16', weekStartValue: ils('1100000.00'), peakValue: ils('1100000.00'),
      maxDrawdownPct: pctOf('1'), lastEventAt: NEXT_MON_OPEN,                // 11,000 / 1,100,000
    });
  });

  it('resets a row last touched weeks ago the same way', () => {
    const old: WeekState = {
      weekStart: '2026-10-26', weekStartValue: ils('500000.00'), peakValue: ils('2000000.00'),
      maxDrawdownPct: pctOf('50'), lastEventAt: at('2026-10-27T15:30:00Z'),
    };
    expect(applyEvent(old, MON_OPEN, ils('1000000.00'), ils('1000000.00'))).toEqual({
      weekStart: '2026-11-09', weekStartValue: ils('1000000.00'), peakValue: ils('1000000.00'),
      maxDrawdownPct: 0n, lastEventAt: MON_OPEN,
    });
  });

  it('uses the Israel date for the week: Monday 00:30 Israel is a new week', () => {
    const sunday: WeekState = {
      weekStart: '2026-11-09', weekStartValue: ils('1000000.00'), peakValue: ils('1200000.00'),
      maxDrawdownPct: pctOf('5'), lastEventAt: at('2026-11-15T21:00:00Z'),
    };
    const w = applyEvent(sunday, at('2026-11-15T22:30:00Z'), ils('1000000.00'), ils('1000000.00'))!;
    expect(w.weekStart).toBe('2026-11-16');
    expect(w.maxDrawdownPct).toBe(0n);
    expect(w.peakValue).toBe(ils('1000000.00'));
  });

  it('a value of 0 has no drawdown instead of dividing by zero', () => {
    expect(applyEvent(EMPTY, MON_OPEN, 0n, 0n)).toMatchObject({ peakValue: 0n, maxDrawdownPct: 0n });
  });

  it('never changes the row it was given', () => {
    const w: WeekState = {
      weekStart: '2026-11-09', weekStartValue: ils('1000000.00'), peakValue: ils('1050000.00'),
      maxDrawdownPct: 0n, lastEventAt: MON_OPEN,
    };
    const before = structuredClone(w);
    applyEvent(w, MON_CLOSE, ils('1050000.00'), ils('1000000.00'));
    applyEvent(w, NEXT_MON_OPEN, ils('1050000.00'), ils('1000000.00'));
    expect(w).toEqual(before);
  });
});

describe('startWeek', () => {
  const lastWeek: WeekState = {
    weekStart: '2026-11-09', weekStartValue: ils('1000000.00'), peakValue: ils('1100000.00'),
    maxDrawdownPct: pctOf('10'), lastEventAt: WED_OPEN,
  };

  it('starts a never-touched row from the value before the event, and leaves the retry guard alone', () => {
    expect(startWeek(EMPTY, MON_OPEN, ils('1000000.00'))).toEqual({
      weekStart: '2026-11-09', weekStartValue: ils('1000000.00'), peakValue: ils('1000000.00'),
      maxDrawdownPct: 0n, lastEventAt: null,
    });
  });

  it('resets a row from an older week, keeping its lastEventAt', () => {
    expect(startWeek(lastWeek, NEXT_MON_OPEN, ils('1089000.00'))).toEqual({
      weekStart: '2026-11-16', weekStartValue: ils('1089000.00'), peakValue: ils('1089000.00'),
      maxDrawdownPct: 0n, lastEventAt: WED_OPEN,
    });
  });

  it('changes nothing in the same week, whatever the value, and returns a copy', () => {
    const out = startWeek(lastWeek, at('2026-11-12T15:30:00Z'), ils('1.00'));   // Thursday's close
    expect(out).toEqual(lastWeek);
    expect(out).not.toBe(lastWeek);
  });

  it('uses the Israel date: Monday 00:30 Israel starts a new week, Sunday 23:00 does not', () => {
    expect(startWeek(lastWeek, at('2026-11-15T21:00:00Z'), ils('5.00'))).toEqual(lastWeek);
    expect(startWeek(lastWeek, at('2026-11-15T22:30:00Z'), ils('5.00')).weekStart).toBe('2026-11-16');
  });

  it('is safe to call twice for the same event (a retried batch)', () => {
    const once = startWeek(lastWeek, NEXT_MON_OPEN, ils('1089000.00'));
    expect(startWeek(once, NEXT_MON_OPEN, ils('1200000.00'))).toEqual(once);
  });

  it('never changes the row it was given', () => {
    const before = structuredClone(lastWeek);
    startWeek(lastWeek, NEXT_MON_OPEN, ils('1089000.00'));
    expect(lastWeek).toEqual(before);
  });

  it('then applyEvent at the same event: the week starts from the value before the trade, not after it', () => {
    // Worth 1,000,000.00 before Monday's open. The open fills a sale above its last mark (+5,000.00 of value),
    // then re-marking the rest takes 1,000.00 off. The week's gain is +4,000.00 (0.4%), all of it this week's.
    const started = startWeek(lastWeek, NEXT_MON_OPEN, ils('1000000.00'));
    const w = applyEvent(started, NEXT_MON_OPEN, ils('1005000.00'), ils('1004000.00'))!;
    expect(w).toEqual({
      weekStart: '2026-11-16', weekStartValue: ils('1000000.00'), peakValue: ils('1004000.00'),
      maxDrawdownPct: 0n, lastEventAt: NEXT_MON_OPEN,
    });
    expect(weekReturnPct(w, ils('1004000.00'), '2026-11-16')).toBe(pctOf('0.4'));
    // Without startWeek the week would start after the sale, and the sale's gain would vanish from it.
    const late = applyEvent(lastWeek, NEXT_MON_OPEN, ils('1005000.00'), ils('1004000.00'))!;
    expect(late.weekStartValue).toBe(ils('1005000.00'));
  });
});

describe('weekReturnPct', () => {
  const w: WeekState = {
    weekStart: '2026-11-09', weekStartValue: ils('1000000.00'), peakValue: ils('1010000.00'),
    maxDrawdownPct: 0n, lastEventAt: MON_CLOSE,
  };

  it('is the change from the start of the week, in PCT', () => {
    expect(weekReturnPct(w, ils('1008513.52'), '2026-11-09')).toBe(pctOf('0.8514'));   // 0.851352 %
    expect(weekReturnPct(w, ils('945000.00'), '2026-11-09')).toBe(pctOf('-5.5'));
    expect(weekReturnPct(w, ils('1000000.00'), '2026-11-09')).toBe(0n);
  });

  it('is 0 for a row from an older week or one never touched: the value has not moved this week', () => {
    expect(weekReturnPct(w, ils('1200000.00'), '2026-11-16')).toBe(0n);
    expect(weekReturnPct(EMPTY, ils('1200000.00'), '2026-11-16')).toBe(0n);
  });
});

describe('median', () => {
  it('is null for no values and the value itself for one', () => {
    expect(median([])).toBeNull();
    expect(median([5n])).toBe(5n);
  });

  it('takes the middle value of an odd count, in any input order', () => {
    expect(median([3n, 1n, 2n])).toBe(2n);
    expect(median([10n, -4n, 7n, 7n, 0n])).toBe(7n);
  });

  it('takes the mean of the two middle values of an even count, rounded half away from zero', () => {
    expect(median([10n, 20n, 30n, 40n])).toBe(25n);
    expect(median([4n, 1n, 3n, 2n])).toBe(3n);      // 2.5 → 3
    expect(median([1n, 2n])).toBe(2n);              // 1.5 → 2
    expect(median([-1n, -2n])).toBe(-2n);           // −1.5 → −2
    expect(median([-3n, 5n])).toBe(1n);
    // agorot: (1,000,000.00 + 1,000,000.01) / 2 = 1,000,000.005 → 1,000,000.01
    expect(median([ils('1000000.00'), ils('1000100.01'), ils('999999.99'), ils('1000000.01')])).toBe(ils('1000000.01'));
  });

  it('does not reorder its input', () => {
    const values = [3n, 1n, 2n, 0n];
    median(values);
    expect(values).toEqual([3n, 1n, 2n, 0n]);
  });
});
