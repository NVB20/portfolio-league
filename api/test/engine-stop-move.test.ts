// Moving a stop loss as pure rules (api/src/game/stopMove.ts, D-041): the request, when its market's check is
// running, what a move may set, and the rate limit. No database.

import { describe, expect, it } from 'vitest';
import { parse, SCALE } from '../src/game/fixed.js';
import { NO_CLOSURES, makeCalendar } from '../src/game/marketHours.js';
import {
  checkMove, checkRunning, lastEventOf, moveRetryAfter, parseMoveBody, parseStopId, STOP_MOVE_LIMIT,
} from '../src/game/stopMove.js';

const P = (s: string) => parse(s, SCALE.PRICE);

describe('parseStopId', () => {
  it('takes a stop id: digits, no leading zero, within a BIGINT', () => {
    expect(parseStopId('1')).toBe('1');
    expect(parseStopId('9223372036854775807')).toBe('9223372036854775807');
  });

  it('refuses anything else', () => {
    for (const id of ['', '0', '01', '-1', '1.5', 'abc', '9223372036854775808', '1 ', '12345678901234567890']) {
      expect(parseStopId(id)).toBeNull();
    }
  });
});

describe('parseMoveBody', () => {
  it('reads the new price exactly, as a string or as a number', () => {
    expect(parseMoveBody({ stopPrice: '98.5' })).toEqual({ ok: true, price: P('98.5') });
    expect(parseMoveBody({ stopPrice: 98.25 })).toEqual({ ok: true, price: P('98.25') });
    expect(parseMoveBody({ stopPrice: '0.0001' })).toEqual({ ok: true, price: P('0.0001') });
  });

  it('refuses a missing, zero, negative, over-precise or non-numeric price', () => {
    for (const stopPrice of [undefined, null, '0', '-5', '95.12345', 'abc', '1e2', true, {}, '1'.repeat(21)]) {
      expect(parseMoveBody({ stopPrice })).toMatchObject({ ok: false });
    }
  });

  it('refuses a body that is not an object', () => {
    for (const body of [undefined, null, '98', 98, [98]]) expect(parseMoveBody(body)).toMatchObject({ ok: false });
  });
});

describe('lastEventOf: the latest open or close of a market at or before now', () => {
  // Thursday 2026-11-12. TASE: open 10:00, close 17:30 Israel (08:00 and 15:30 UTC). US: 16:30 and 23:00 Israel.
  it('is the open while the market is open, and the close after it', () => {
    expect(lastEventOf('TASE', new Date('2026-11-12T10:40:00Z'), NO_CLOSURES)).toMatchObject({ kind: 'open', day: '2026-11-12' });
    expect(lastEventOf('TASE', new Date('2026-11-12T15:30:00Z'), NO_CLOSURES)).toMatchObject({ kind: 'close', day: '2026-11-12' });
    expect(lastEventOf('TASE', new Date('2026-11-12T15:30:30Z'), NO_CLOSURES)).toMatchObject({ kind: 'close', day: '2026-11-12' });
  });

  it('is the day before when the market has not opened yet', () => {
    expect(lastEventOf('TASE', new Date('2026-11-12T05:00:00Z'), NO_CLOSURES)).toMatchObject({ kind: 'close', day: '2026-11-11' });
    expect(lastEventOf('US', new Date('2026-11-12T10:00:00Z'), NO_CLOSURES)).toMatchObject({ kind: 'close', day: '2026-11-11' });
  });

  it('skips the weekend and closed days', () => {
    // Monday 2026-11-16 before the open: the last TASE close was Friday's (TASE trades Monday to Friday since 2026).
    expect(lastEventOf('TASE', new Date('2026-11-16T05:00:00Z'), NO_CLOSURES)).toMatchObject({ kind: 'close', day: '2026-11-13' });
    const calendar = makeCalendar([{ market: 'TASE', day: '2026-11-13', reason: 'חג' }]);
    expect(lastEventOf('TASE', new Date('2026-11-16T05:00:00Z'), calendar)).toMatchObject({ kind: 'close', day: '2026-11-12' });
  });
});

describe('checkRunning: is the market of the stop between its open or close and the runner checking it?', () => {
  const close = { market: 'TASE' as const, kind: 'close' as const, day: '2026-11-12', at: new Date('2026-11-12T15:30:00Z') };

  it('is running while the runner has not started the event, or has started it and not checked its stops', () => {
    expect(checkRunning(close, undefined)).toBe(true);
    expect(checkRunning(close, 'pending')).toBe(true);
  });

  it('is not running once its orders are done, or with no event at all', () => {
    expect(checkRunning(close, 'orders_done')).toBe(false);
    expect(checkRunning(close, 'done')).toBe(false);
    expect(checkRunning(null, undefined)).toBe(false);
  });
});

describe('checkMove: what a move may set', () => {
  it('moves an active stop up or down, to any price below the latest close', () => {
    expect(checkMove({ status: 'active', price: P('99.99'), latestClose: P('100') })).toBeNull();
    expect(checkMove({ status: 'active', price: P('50'), latestClose: P('100') })).toBeNull();
  });

  it('refuses a stop that fired or expired', () => {
    expect(checkMove({ status: 'triggered', price: P('90'), latestClose: P('100') })).toMatchObject({ code: 'STOP_NOT_ACTIVE', reason: expect.any(String) });
    expect(checkMove({ status: 'expired', price: P('90'), latestClose: P('100') })).toMatchObject({ code: 'STOP_NOT_ACTIVE' });
  });

  it('refuses a price at or above the latest close, or when no close is known', () => {
    expect(checkMove({ status: 'active', price: P('100'), latestClose: P('100') })).toMatchObject({ code: 'STOP_NOT_BELOW_PRICE' });
    expect(checkMove({ status: 'active', price: P('120'), latestClose: P('100') })).toMatchObject({ code: 'STOP_NOT_BELOW_PRICE' });
    expect(checkMove({ status: 'active', price: P('90'), latestClose: null })).toMatchObject({ code: 'STOP_NO_PRICE' });
  });
});

describe('moveRetryAfter: 5 moves a minute per player', () => {
  const NOW = new Date('2026-11-12T12:00:00Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  it('allows a move under the limit', () => {
    expect(STOP_MOVE_LIMIT).toEqual({ moves: 5, windowSeconds: 60 });
    expect(moveRetryAfter([], NOW)).toBeNull();
    expect(moveRetryAfter([ago(1000), ago(2000), ago(3000), ago(4000)], NOW)).toBeNull();
  });

  it('says how long until the oldest of the last 5 is a minute old', () => {
    expect(moveRetryAfter([ago(1000), ago(2000), ago(3000), ago(4000), ago(50_500)], NOW)).toBe(10);
  });
});
