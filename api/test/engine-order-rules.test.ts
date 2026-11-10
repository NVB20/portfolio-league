// The rules checked when an order is SENT (api/src/game/orderRules.ts; D-014, D-018, D-020, D-021, D-028).
// Pure, no database. The execution-time checks are the engine's (engine-orders.test.ts).

import { describe, expect, it } from 'vitest';
import { parse, SCALE } from '../src/game/fixed.js';
import {
  checkSend, checkTiming, type HeldPosition, MIN_ORDER_ILS, parseSendBody, RATE_LIMIT, retryAfterSeconds,
  SEND_REASONS,
} from '../src/game/orderRules.js';

const ils = (s: string) => parse(s, SCALE.ILS);
const units = (s: string) => parse(s, SCALE.UNITS);
const price = (s: string) => parse(s, SCALE.PRICE);
const rate = (s: string) => parse(s, SCALE.RATE);

// ---------- the request body ----------

describe('parseSendBody', () => {
  const ok = (body: unknown) => {
    const r = parseSendBody(body);
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    return r.order;
  };
  const bad = (body: unknown) => {
    const r = parseSendBody(body);
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.error;
  };

  it('reads a buy in ₪, from a string or a JSON number, exactly', () => {
    expect(ok({ symbol: 'NVDA', side: 'buy', amountIls: '100000.00' })).toEqual({
      symbol: 'NVDA', side: 'buy', amount: ils('100000.00'), units: null, clientOrderId: null,
    });
    expect(ok({ symbol: 'NVDA', side: 'buy', amountIls: 100.5 }).amount).toBe(10_050n);
    expect(ok({ symbol: 'BRK-B', side: 'buy', amountIls: '250', clientOrderId: 'a_B-9' })).toMatchObject({
      symbol: 'BRK-B', amount: 25_000n, clientOrderId: 'a_B-9',
    });
  });

  it('reads a sell in units, up to 8 decimals', () => {
    expect(ok({ symbol: 'TEVA', side: 'sell', units: '90.09009009' })).toEqual({
      symbol: 'TEVA', side: 'sell', amount: null, units: units('90.09009009'), clientOrderId: null,
    });
    expect(ok({ symbol: 'TEVA', side: 'sell', units: 3 }).units).toBe(300_000_000n);
  });

  it('treats null like a missing field', () => {
    expect(ok({ symbol: 'TEVA', side: 'buy', amountIls: '100', units: null, clientOrderId: null }).units).toBeNull();
  });

  it('a buy is a ₪ amount and a sell is units, never the other way (D-018)', () => {
    bad({ symbol: 'TEVA', side: 'buy' });
    bad({ symbol: 'TEVA', side: 'buy', units: '5' });
    bad({ symbol: 'TEVA', side: 'buy', amountIls: '100', units: '5' });
    bad({ symbol: 'TEVA', side: 'sell' });
    bad({ symbol: 'TEVA', side: 'sell', amountIls: '100' });
    bad({ symbol: 'TEVA', side: 'sell', amountIls: '100', units: '5' });
  });

  it('refuses sizes it would have to round or guess', () => {
    const buy = (amountIls: unknown) => bad({ symbol: 'TEVA', side: 'buy', amountIls });
    const sell = (u: unknown) => bad({ symbol: 'TEVA', side: 'sell', units: u });
    buy('100.001');                 // 3 decimals, even though the last is 0
    buy('100.000');
    buy(0.1 + 0.2);                 // String() gives 0.30000000000000004
    buy(1e21);                      // String() gives 1e+21
    buy('1e5');
    buy('-100');
    buy('0');
    buy('0.00');
    buy('');
    buy(' 100');
    buy('1,000');
    buy('.5');
    buy('5.');
    buy('abc');
    buy(true);
    buy({});
    buy('1'.repeat(21));            // over 20 characters
    sell('0.000000001');            // 9 decimals
    sell(1e-7);                     // String() gives 1e-7
    sell('0.00000000');
  });

  it('accepts exactly 20 characters', () => {
    expect(ok({ symbol: 'TEVA', side: 'sell', units: '12345678901.12345678' }).units).toBe(units('12345678901.12345678'));
  });

  it('checks the symbol, the side and the client id', () => {
    bad({ symbol: 'teva', side: 'buy', amountIls: '100' });
    bad({ symbol: 'TOOLONGSYMB', side: 'buy', amountIls: '100' });
    bad({ symbol: 'TE VA', side: 'buy', amountIls: '100' });
    bad({ side: 'buy', amountIls: '100' });
    bad({ symbol: 'TEVA', side: 'short', amountIls: '100' });
    bad({ symbol: 'TEVA', side: 'buy', amountIls: '100', clientOrderId: '' });
    bad({ symbol: 'TEVA', side: 'buy', amountIls: '100', clientOrderId: 'has space' });
    bad({ symbol: 'TEVA', side: 'buy', amountIls: '100', clientOrderId: 'x'.repeat(65) });
    bad({ symbol: 'TEVA', side: 'buy', amountIls: '100', clientOrderId: 42 });
    expect(ok({ symbol: 'TEVA', side: 'buy', amountIls: '100', clientOrderId: 'x'.repeat(64) }).clientOrderId).toHaveLength(64);
  });

  it('needs a JSON object', () => {
    for (const body of [undefined, null, 'buy', 5, [], [{ symbol: 'TEVA' }]]) bad(body);
  });

  it('says what is wrong, in English', () => {
    expect(bad({ symbol: 'TEVA', side: 'buy', amountIls: '1.234' })).toMatch(/amountIls/);
    expect(bad({ symbol: 'TEVA', side: 'sell', units: 'x' })).toMatch(/units/);
  });
});

// ---------- buy ----------

const NO_POSITION_HELD = null;

function held(more: Partial<HeldPosition> = {}): HeldPosition {
  return {
    units: units('100'), reservedUnits: 0n, costBasis: ils('10000.00'), avgCost: parse('100', SCALE.AVG_COST),
    lastPrice: null, lastRate: null, marketValue: null,
    ...more,
  };
}

const buy = (amount: string, opts: { available?: string; equity?: string; pending?: string; position?: HeldPosition | null } = {}) =>
  checkSend({
    side: 'buy',
    amount: ils(amount),
    availableCash: ils(opts.available ?? '1000000.00'),
    equity: ils(opts.equity ?? '1000000.00'),
    pendingBuys: ils(opts.pending ?? '0'),
    position: opts.position ?? NO_POSITION_HELD,
  });

describe('checkSend: buy', () => {
  it('passes a normal order', () => {
    expect(buy('100000.00')).toBeNull();
  });

  it('refuses under ₪100.00 (D-014)', () => {
    expect(MIN_ORDER_ILS).toBe(10_000n);
    expect(buy('99.99')).toEqual({ code: 'BELOW_MIN', reason: SEND_REASONS.BELOW_MIN_BUY });
    expect(buy('100.00')).toBeNull();
  });

  it('refuses more than the available cash (cash − reserved cash)', () => {
    expect(buy('5000.01', { available: '5000.00' })).toEqual({ code: 'INSUFFICIENT_CASH', reason: SEND_REASONS.INSUFFICIENT_CASH });
    expect(buy('5000.00', { available: '5000.00' })).toBeNull();
  });

  it('checks the minimum before the cash', () => {
    expect(buy('50.00', { available: '10.00' })?.code).toBe('BELOW_MIN');
  });

  it('20%: exactly a fifth of the stored equity passes, one agora more does not', () => {
    expect(buy('200000.00')).toBeNull();
    const over = buy('200000.01');
    expect(over?.code).toBe('OVER_LIMIT');
    // One agora over still reads as a breach, never "20.0%" (D-020).
    expect(over?.reason).toBe('ההחזקה הייתה מגיעה ל־20.1% מהתיק (מותר עד 20%)');
  });

  it('20%: counts the holding at its last mark', () => {
    const position = held({ marketValue: ils('150000.00'), costBasis: ils('90000.00') });
    expect(buy('50000.00', { position })).toBeNull();
    expect(buy('50000.01', { position })?.code).toBe('OVER_LIMIT');
  });

  it('20%: counts a never-marked holding at its cost', () => {
    const position = held({ marketValue: null, costBasis: ils('190000.00') });
    expect(buy('10000.00', { position })).toBeNull();
    expect(buy('10000.01', { position })?.code).toBe('OVER_LIMIT');
  });

  it('20%: counts this player\'s pending buys of the same stock (D-028)', () => {
    expect(buy('50000.00', { pending: '150000.00' })).toBeNull();
    const over = buy('100000.00', { pending: '150000.00' });
    expect(over).toEqual({ code: 'OVER_LIMIT', reason: 'ההחזקה הייתה מגיעה ל־25.0% מהתיק (מותר עד 20%)' });
  });

  it('20%: the whole is the stored equity, which counts reserved cash too', () => {
    // equity 500,000 with only 300,000 available: the limit is 100,000, not 60,000.
    expect(buy('100000.00', { available: '300000.00', equity: '500000.00' })).toBeNull();
    expect(buy('100000.01', { available: '300000.00', equity: '500000.00' })?.code).toBe('OVER_LIMIT');
  });

  it('checks the cash before the 20%', () => {
    expect(buy('300000.00', { available: '100.00' })?.code).toBe('INSUFFICIENT_CASH');
  });
});

// ---------- sell ----------

const sell = (u: string, position: HeldPosition | null) => checkSend({ side: 'sell', units: units(u), position });

describe('checkSend: sell', () => {
  const marked = (more: Partial<HeldPosition> = {}) =>
    held({ lastPrice: price('132.6000'), marketValue: ils('13260.00'), ...more });   // TASE: no rate

  it('passes a normal sale', () => {
    expect(sell('40', marked())).toBeNull();
  });

  it('refuses a sale with no open position', () => {
    expect(sell('1', null)).toEqual({ code: 'NO_POSITION', reason: SEND_REASONS.NO_POSITION });
  });

  it('refuses more than the free units (units − units locked by pending sells)', () => {
    const p = marked({ reservedUnits: units('60') });
    expect(sell('40.00000001', p)).toEqual({ code: 'INSUFFICIENT_UNITS', reason: SEND_REASONS.INSUFFICIENT_UNITS });
    expect(sell('40', p)).toBeNull();
  });

  it('refuses a sale worth under ₪100 at the last mark (TASE: no rate)', () => {
    // 0.75 × 132.60 = 99.45
    expect(sell('0.75', marked())).toEqual({ code: 'BELOW_MIN', reason: SEND_REASONS.BELOW_MIN_SELL });
    // At ₪100.0000: 1 unit is exactly ₪100.00; 0.9999 is ₪99.99.
    const at100 = marked({ lastPrice: price('100.0000') });
    expect(sell('1', at100)).toBeNull();
    expect(sell('0.9999', at100)?.code).toBe('BELOW_MIN');
    // 0.99995 × 100 = 99.995, which rounds half up to ₪100.00 (the agora rounding of valueIls).
    expect(sell('0.99995', at100)).toBeNull();
  });

  it('values a US sale with the mark\'s USD/ILS rate', () => {
    // 0.18 × $150 × 3.7 = ₪99.90; the same units at 3.71 = ₪100.17
    const us = (fx: string) => held({ lastPrice: price('150.0000'), lastRate: rate(fx), marketValue: ils('55500.00') });
    expect(sell('0.18', us('3.7000'))?.code).toBe('BELOW_MIN');
    expect(sell('0.18', us('3.7100'))).toBeNull();
  });

  it('lets a small position be closed: selling every free unit is always allowed (D-028)', () => {
    const small = marked({ units: units('0.5'), costBasis: ils('60.00'), marketValue: ils('66.30') });
    expect(sell('0.5', small)).toBeNull();
    expect(sell('0.4', small)?.code).toBe('BELOW_MIN');
    // With 0.2 locked by a pending sell, the 0.3 left is "everything free".
    expect(sell('0.3', { ...small, reservedUnits: units('0.2') })).toBeNull();
  });

  it('values a never-marked position at its average cost', () => {
    const unmarked = held({ avgCost: parse('130', SCALE.AVG_COST) });
    expect(sell('0.76', unmarked)?.code).toBe('BELOW_MIN');   // 0.76 × 130 = 98.80
    expect(sell('0.77', unmarked)).toBeNull();                // 0.77 × 130 = 100.10
  });

  it('checks the units before the minimum', () => {
    expect(sell('1000', marked({ units: units('0.1') }))?.code).toBe('INSUFFICIENT_UNITS');
  });
});

// ---------- timing: the end of the world ----------

describe('checkTiming', () => {
  const NOW = new Date('2026-11-11T10:40:00Z');
  const CLOSE = new Date('2026-11-11T15:30:00Z');

  it('passes when the world has no end', () => {
    expect(checkTiming(NOW, CLOSE, null)).toBeNull();
  });

  it('passes an order that runs at or before the end', () => {
    expect(checkTiming(NOW, CLOSE, CLOSE)).toBeNull();
    expect(checkTiming(NOW, CLOSE, new Date('2026-11-12T07:59:00Z'))).toBeNull();
  });

  it('refuses an order that would run after the end: no event will ever run it', () => {
    expect(checkTiming(NOW, CLOSE, new Date('2026-11-11T15:29:59Z'))).toEqual({ code: 'GAME_OVER', reason: SEND_REASONS.GAME_OVER });
  });

  it('refuses everything once the clock is at the end', () => {
    expect(checkTiming(CLOSE, new Date('2026-11-12T08:00:00Z'), CLOSE)?.code).toBe('GAME_OVER');
  });
});

// ---------- the rate limit ----------

describe('retryAfterSeconds', () => {
  const NOW = new Date('2026-11-10T12:00:00.000Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  it('is 5 orders per real minute', () => {
    expect(RATE_LIMIT).toEqual({ orders: 5, windowSeconds: 60 });
  });

  it('is null while fewer than 5 orders were sent in the last minute', () => {
    expect(retryAfterSeconds([], NOW)).toBeNull();
    expect(retryAfterSeconds([ago(1000), ago(2000), ago(3000), ago(4000)], NOW)).toBeNull();
  });

  it('waits until the oldest of the last 5 is a minute old, rounded up', () => {
    // Newest first. The 5th newest was sent 50.5 s ago: 9.5 s to go → 10.
    expect(retryAfterSeconds([ago(1000), ago(2000), ago(3000), ago(4000), ago(50_500)], NOW)).toBe(10);
    expect(retryAfterSeconds([ago(0), ago(0), ago(0), ago(0), ago(0)], NOW)).toBe(60);
  });

  it('never says 0: at least 1 second', () => {
    expect(retryAfterSeconds([ago(1), ago(1), ago(1), ago(1), ago(59_999)], NOW)).toBe(1);
    expect(retryAfterSeconds([ago(1), ago(1), ago(1), ago(1), ago(60_000)], NOW)).toBe(1);
  });
});
