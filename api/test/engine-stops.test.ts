// The stop loss as pure rules (api/src/game/stops.ts, D-037): when a stop fires at an open or a close, and what
// each fired stop sells. No database.

import { describe, expect, it } from 'vitest';
import { parse, SCALE } from '../src/game/fixed.js';
import { type ActiveStop, planStops, stopFires, type StopPosition } from '../src/game/stops.js';

const P = (s: string) => parse(s, SCALE.PRICE);
const U = (s: string) => parse(s, SCALE.UNITS);

const stop = (o: Partial<ActiveStop> = {}): ActiveStop => ({
  id: '1', uid: 'alice', symbol: 'TEVA', positionId: '10', stopPrice: P('95'), units: U('100'), activationPrice: P('100'), moved: false, ...o,
});
const open = (units: string, reserved = '0'): StopPosition => ({ status: 'open', units: U(units), reservedUnits: U(reserved) });

describe('stopFires: checked only at the open and the close', () => {
  it('fires when the event price is below the stop', () => {
    expect(stopFires(P('95'), P('100'), P('94.99'))).toBe(true);
  });

  it('fires when the event price equals the stop', () => {
    expect(stopFires(P('95'), P('100'), P('95'))).toBe(true);
  });

  it('stays when the event price is above the stop', () => {
    expect(stopFires(P('95'), P('100'), P('95.01'))).toBe(false);
  });

  it('fires at the first check, whatever the price, when the buy itself filled at or below the stop', () => {
    // The price gapped past the stop before the buy ran: a broker sells such a stop at the next price.
    expect(stopFires(P('95'), P('90'), P('120'))).toBe(true);
    expect(stopFires(P('95'), P('95'), P('120'))).toBe(true);
  });

  it('waits when the stock has no price at this event', () => {
    expect(stopFires(P('95'), P('90'), undefined)).toBe(false);
  });

  it('a moved stop fires only on the price: the buy price no longer counts (D-041)', () => {
    // Bought at ₪100, the price rose, the stop was raised to ₪105: above the buy price, below the price now.
    expect(stopFires(P('105'), null, P('120'))).toBe(false);
    expect(stopFires(P('105'), null, P('105'))).toBe(true);
    expect(stopFires(P('105'), null, P('104'))).toBe(true);
  });
});

describe('planStops: what each fired stop sells', () => {
  it('sells the units its buy got', () => {
    expect(planStops([stop()], new Map([['10', open('100')]]))).toEqual([{ stopId: '1', action: 'sell', units: U('100') }]);
  });

  it('sells at most the free units: a hand sale since then leaves it less', () => {
    expect(planStops([stop()], new Map([['10', open('40')]]))).toEqual([{ stopId: '1', action: 'sell', units: U('40') }]);
  });

  it('leaves the units a pending hand sell has locked', () => {
    expect(planStops([stop()], new Map([['10', open('100', '70')]]))).toEqual([{ stopId: '1', action: 'sell', units: U('30') }]);
  });

  it('waits when every unit is locked by a pending sell', () => {
    expect(planStops([stop()], new Map([['10', open('100', '100')]]))).toEqual([{ stopId: '1', action: 'wait' }]);
  });

  it('expires when its position is closed or missing', () => {
    const closed: StopPosition = { status: 'closed', units: 0n, reservedUnits: 0n };
    expect(planStops([stop()], new Map([['10', closed]]))).toEqual([{ stopId: '1', action: 'expire' }]);
    expect(planStops([stop()], new Map())).toEqual([{ stopId: '1', action: 'expire' }]);
  });

  it('shares one position between its stops, the highest stop first, then the oldest', () => {
    const plans = planStops(
      [
        stop({ id: '3', stopPrice: P('90'), units: U('60') }),
        stop({ id: '2', stopPrice: P('95'), units: U('60') }),
        stop({ id: '4', stopPrice: P('90'), units: U('60') }),
      ],
      new Map([['10', open('100')]]),
    );
    expect(plans).toEqual([
      { stopId: '2', action: 'sell', units: U('60') },
      { stopId: '3', action: 'sell', units: U('40') },
      { stopId: '4', action: 'wait' },
    ]);
  });

  it('keeps stops on different positions apart', () => {
    const plans = planStops(
      [stop({ id: '1', positionId: '10' }), stop({ id: '2', positionId: '11', units: U('5') })],
      new Map([['10', open('100')], ['11', open('5')]]),
    );
    expect(plans).toEqual([
      { stopId: '1', action: 'sell', units: U('100') },
      { stopId: '2', action: 'sell', units: U('5') },
    ]);
  });

  it('never changes its inputs', () => {
    const fired = [stop({ id: '2' }), stop({ id: '1' })];
    const positions = new Map([['10', open('100')]]);
    planStops(fired, positions);
    expect(fired.map((s) => s.id)).toEqual(['2', '1']);
    expect(positions.get('10')).toEqual(open('100'));
  });
});
