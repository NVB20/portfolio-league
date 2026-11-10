// The calendar-aware market hours (D-016, D-022) and the clock moves (D-017). Pure, no database.
// Dates used, all checked against the price data:
//   2026-04-01 Wed, 2026-04-02 Thu: TASE closed (Passover), US open
//   2026-04-03 Fri: US closed (Good Friday), TASE open (Friday hours)
//   2025-11-07 Fri: TASE closed (Fridays before 2026), US open
// Early April: Israel UTC+3, New York UTC-4 (US 16:30-23:00 Israel). November 2025: Israel UTC+2, New York UTC-5.

import { describe, expect, it } from 'vitest';
import { executionFor, isMarketOpen, makeCalendar, marketStatus, sessionOn } from '../src/game/marketHours.js';
import { type ClockState, eventsBetween, isTradingDay, jumpTarget, runForward, worldNow } from '../src/game/clock.js';

const cal = makeCalendar([
  { market: 'TASE', day: '2026-04-01', reason: 'פסח' },
  { market: 'TASE', day: '2026-04-02', reason: 'פסח' },
  { market: 'US', day: '2026-04-03', reason: 'Good Friday' },
  { market: 'TASE', day: '2025-11-07', reason: 'הבורסה סגורה בימי שישי עד 2026' },
  // A made-up day when both are closed, to test skipping.
  { market: 'TASE', day: '2026-04-06', reason: 'test' },
  { market: 'US', day: '2026-04-06', reason: 'test' },
]);
const at = (iso: string) => new Date(iso);
const FAR = at('2030-01-01T00:00:00Z');

describe('market hours with the calendar', () => {
  it('closes TASE on a holiday while the US trades', () => {
    expect(sessionOn('TASE', '2026-04-01', cal)).toBeNull();
    expect(sessionOn('US', '2026-04-01', cal)).toEqual({ openMin: 16 * 60 + 30, closeMin: 23 * 60 });
    expect(isMarketOpen('TASE', at('2026-04-01T09:00:00Z'), cal)).toBe(false);   // 12:00 Israel
  });

  it('closes TASE on Fridays before 2026', () => {
    expect(sessionOn('TASE', '2025-11-07', cal)).toBeNull();
    expect(sessionOn('US', '2025-11-07', cal)).not.toBeNull();
  });

  it('still knows the weekend without any calendar rows', () => {
    expect(sessionOn('TASE', '2026-04-04', cal)).toBeNull();   // Saturday
    expect(sessionOn('US', '2026-04-05', cal)).toBeNull();     // Sunday
  });

  it('sends a TASE order on a holiday to the next real open', () => {
    // Wed 01.04 12:00 Israel: TASE closed Wed + Thu, opens Fri 03.04 10:00 (07:00 UTC)
    const e = executionFor('TASE', at('2026-04-01T09:00:00Z'), cal);
    expect(e).toEqual({ priceType: 'open', day: '2026-04-03', at: at('2026-04-03T07:00:00Z') });
  });

  it('sends a US order on Good Friday to Monday', () => {
    // Fri 03.04 18:00 Israel: US closed; Mon 06.04 is closed too (test row), so Tue 07.04 16:30 Israel
    const e = executionFor('US', at('2026-04-03T15:00:00Z'), cal);
    expect(e).toEqual({ priceType: 'open', day: '2026-04-07', at: at('2026-04-07T13:30:00Z') });
  });

  it('reports each market separately, with the reason and the next open', () => {
    const now = at('2026-04-01T09:00:00Z');   // Wed 12:00 Israel
    expect(marketStatus('TASE', now, cal)).toMatchObject({
      state: 'holiday', reason: 'פסח', session: null, nextOpenAt: at('2026-04-03T07:00:00Z'),
    });
    expect(marketStatus('US', now, cal)).toMatchObject({
      state: 'pre_open', reason: null, nextOpenAt: at('2026-04-01T13:30:00Z'),
    });
    expect(marketStatus('US', at('2026-04-01T14:00:00Z'), cal)).toMatchObject({ state: 'open', nextOpenAt: null });
    expect(marketStatus('TASE', at('2026-04-04T09:00:00Z'), cal)).toMatchObject({ state: 'weekend', reason: null });
  });
});

describe('clock: events between two instants', () => {
  it('lists every open and close in order, skipping closed markets', () => {
    // Thu 02.04 00:00 Israel -> Fri 03.04 23:59 Israel
    const events = eventsBetween(at('2026-04-01T21:00:00Z'), at('2026-04-03T20:59:00Z'), cal);
    expect(events.map((e) => `${e.day} ${e.market} ${e.kind}`)).toEqual([
      '2026-04-02 US open',
      '2026-04-02 US close',
      '2026-04-03 TASE open',
      '2026-04-03 TASE close',
    ]);
  });

  it('excludes the start instant and includes the end instant', () => {
    const open = at('2026-04-03T07:00:00Z');   // TASE open Fri 03.04
    expect(eventsBetween(open, at('2026-04-03T07:00:00Z'), cal)).toEqual([]);
    expect(eventsBetween(at('2026-04-03T06:59:00Z'), open, cal)).toHaveLength(1);
  });
});

describe('clock: admin jumps', () => {
  it('jumps to the close while a market is open', () => {
    // Fri 03.04 12:00 Israel: TASE open (Friday close 13:50 = 10:50 UTC)
    expect(jumpTarget(at('2026-04-03T09:00:00Z'), FAR, cal)).toEqual({ kind: 'to_close', to: at('2026-04-03T10:50:00Z') });
  });

  it('jumps to the earliest close when both are open', () => {
    // Tue 07.04 17:00 Israel: TASE (till 17:30) and US (from 16:30) both open
    expect(jumpTarget(at('2026-04-07T14:00:00Z'), FAR, cal)).toEqual({ kind: 'to_close', to: at('2026-04-07T14:30:00Z') });
  });

  it('jumps to the next open when both are closed, skipping closed days', () => {
    // Fri 03.04 14:00 Israel: TASE closed for the day, US closed (Good Friday), weekend, Mon 06.04 closed
    expect(jumpTarget(at('2026-04-03T11:00:00Z'), FAR, cal)).toEqual({ kind: 'to_open', to: at('2026-04-07T07:00:00Z') });
  });

  it('stops at the end of history', () => {
    const end = at('2026-04-03T08:00:00Z');
    expect(jumpTarget(at('2026-04-03T07:30:00Z'), end, cal)).toEqual({ kind: 'to_close', to: end });
    expect(jumpTarget(end, end, cal)).toBeNull();
  });
});

describe('clock: running at real speed', () => {
  it('moves by real time inside a trading day', () => {
    expect(runForward(at('2026-04-03T07:00:00Z'), 90 * 60_000, FAR, cal)).toEqual(at('2026-04-03T08:30:00Z'));
  });

  it('skips the weekend and days when both markets are closed', () => {
    // Fri 03.04 23:00 Israel + 2 real hours: 1 hour to midnight, Sat/Sun/Mon 06.04 skipped, 1 hour into Tue 07.04
    expect(isTradingDay('2026-04-06', cal)).toBe(false);
    expect(runForward(at('2026-04-03T20:00:00Z'), 2 * 3_600_000, FAR, cal)).toEqual(at('2026-04-06T22:00:00Z'));
  });

  it('never passes the end of history', () => {
    const end = at('2026-04-03T08:00:00Z');
    expect(runForward(at('2026-04-03T07:00:00Z'), 10 * 3_600_000, end, cal)).toEqual(end);
  });
});

describe('clock: the effective now (worldNow)', () => {
  const FRI_OPEN = at('2026-04-03T07:00:00Z');    // Fri 03.04 10:00 Israel, TASE opens
  const FRI_CLOSE = at('2026-04-03T10:50:00Z');   // Fri 03.04 13:50 Israel, TASE's Friday close
  const REAL_AT = at('2026-11-10T12:00:00Z');     // the real time the row was stored
  const realLater = (ms: number) => new Date(REAL_AT.getTime() + ms);
  const row = (more: Partial<ClockState> = {}): ClockState => ({
    nowAt: FRI_OPEN, realAt: REAL_AT, running: false, endsAt: null, eventsThrough: null, ...more,
  });

  it('is the stored world time while the clock is stopped, however much real time has passed', () => {
    expect(worldNow(row(), realLater(5 * 3_600_000), cal)).toEqual(FRI_OPEN);
  });

  it('runs on by the real time since the row was stored, skipping days when both markets are closed', () => {
    // Fri 03.04 23:00 Israel + 2 real hours: Sat, Sun and Mon 06.04 (both closed) take no time -> Tue 07.04 01:00
    const r = row({ nowAt: at('2026-04-03T20:00:00Z'), running: true });
    expect(worldNow(r, realLater(2 * 3_600_000), cal)).toEqual(at('2026-04-06T22:00:00Z'));
  });

  it('never runs past ends_at, and has no end when ends_at is null', () => {
    const tenHours = realLater(10 * 3_600_000);
    expect(worldNow(row({ running: true, endsAt: at('2026-04-03T08:00:00Z') }), tenHours, cal)).toEqual(at('2026-04-03T08:00:00Z'));
    expect(worldNow(row({ running: true }), tenHours, cal)).toEqual(at('2026-04-03T17:00:00Z'));   // Fri 20:00 Israel
  });

  it('counts a row stored after the real now (it changed while we waited for its lock) as no time passed', () => {
    expect(worldNow(row({ running: true }), realLater(-1_000), cal)).toEqual(FRI_OPEN);
  });

  it('is never before the latest event the runner has started (an admin jump in progress)', () => {
    // The admin jumps to the 13:50 close: the runner has started it, the clock row still says 10:00.
    expect(worldNow(row({ eventsThrough: FRI_CLOSE }), REAL_AT, cal)).toEqual(FRI_CLOSE);
    expect(worldNow(row({ running: true, eventsThrough: FRI_CLOSE }), realLater(30 * 60_000), cal)).toEqual(FRI_CLOSE);
    // So an order sent in that moment runs at the next open, not at the close that is already running:
    // Mon 06.04 is closed, so Tue 07.04 10:00 Israel.
    const now = worldNow(row({ eventsThrough: FRI_CLOSE }), REAL_AT, cal);
    expect(executionFor('TASE', now, cal)).toEqual({ priceType: 'open', day: '2026-04-07', at: at('2026-04-07T07:00:00Z') });
  });

  it('is the clock time once the clock has passed the latest event', () => {
    const r = row({ running: true, eventsThrough: FRI_OPEN });
    expect(worldNow(r, realLater(90 * 60_000), cal)).toEqual(at('2026-04-03T08:30:00Z'));
    expect(worldNow(row({ eventsThrough: at('2026-04-02T20:00:00Z') }), REAL_AT, cal)).toEqual(FRI_OPEN);
  });
});
