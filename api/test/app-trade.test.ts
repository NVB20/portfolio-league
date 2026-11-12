// The trading screen's pure logic (src/trade/), checked against the server's send rules (D-014, D-018,
// D-020, D-028). No database, no network, no React.
// The app files are ES modules for this NodeNext check because of src/trade/package.json ("type": "module").

import { describe, expect, it } from 'vitest';
import {
  CAP, checkOrder, checkStop, cleanAmount, groupAmount, MIN_ORDER_ILS, SLIDER_STEP, sliderAmount, sliderRange, sliderRatio, PENDING_LIST_MAX, pendingBuysIls, pendingListCut, sellPlan, shortfallIls, shownFreeIls,
  type CheckInput, type CheckStatus, type HoldingInput,
} from '../../src/trade/orderCheck.js';
import { bodyKey, memoryFor, newClientOrderId, orderBody, SendMemory, type OrderBody } from '../../src/trade/orderBody.js';
import { NETWORK_FAILURE, sendFailure } from '../../src/trade/sendError.js';

// A player with ₪1,000,000 of equity, ₪500,000 of it free cash.
const base: CheckInput = {
  side: 'buy',
  amount: 10_000,
  availableCash: 500_000,
  totalValue: 1_000_000,
  holding: null,
  pendingBuysIls: 0,
  pendingCut: false,
  priceIls: 100,
  gameOver: false,
};
const buy = (o: Partial<CheckInput>) => checkOrder({ ...base, ...o });
const sell = (o: Partial<CheckInput>) => checkOrder({ ...base, side: 'sell', ...o });

// 10 units worth ₪1,000 at the last mark: ₪100 a unit.
const tenUnits: HoldingInput = { units: 10, freeUnits: 10, valueIls: 1_000 };

describe('checkOrder: buy', () => {
  it('ok: inside cash, the cap and the minimum', () => {
    const c = buy({ amount: 10_000 });
    expect(c.status).toBe('ok');
    expect(c.ok).toBe(true);
    expect(c.units).toBe(100);
    expect(c.cashAfter).toBe(490_000);
    expect(c.weightAfterPct).toBeCloseTo(1, 9);
    expect(c.maxIls).toBe(200_000);       // the cap (20% of ₪1,000,000) is below the cash
    expect(c.leftIls).toBe(190_000);
    expect(c.sell).toBeNull();
  });

  it('empty: no amount', () => {
    expect(buy({ amount: 0 }).status).toBe('empty');
    expect(buy({ amount: 0 }).ok).toBe(false);
  });

  it('gameOver blocks first, even with no amount and no price', () => {
    expect(buy({ gameOver: true }).status).toBe('gameOver');
    expect(buy({ gameOver: true, amount: 0, priceIls: null }).status).toBe('gameOver');
    expect(buy({ gameOver: true }).ok).toBe(false);
  });

  it('noPrice: no close known yet', () => {
    expect(buy({ priceIls: null }).status).toBe('noPrice');
  });

  it('noCash: the AVAILABLE cash counts, not the cash reserved for pending buys', () => {
    expect(buy({ availableCash: 9_999, amount: 10_000 }).status).toBe('noCash');
    expect(buy({ availableCash: 10_000, amount: 10_000 }).status).toBe('ok');
    expect(buy({ availableCash: 9_999 }).cashAfter).toBe(-1);
  });

  it('the most allowed is the smaller of the available cash and the cap room', () => {
    expect(buy({ availableCash: 50_000 }).maxIls).toBe(50_000);
    expect(buy({ holding: { units: 1, freeUnits: 1, valueIls: 150_000 } }).maxIls).toBe(50_000);
    expect(buy({ holding: { units: 1, freeUnits: 1, valueIls: 250_000 } }).maxIls).toBe(0);   // over by a price rise
  });

  it('exactly 20% is allowed (the server compares with >)', () => {
    const c = buy({ amount: 200_000 });
    expect(c.status).toBe('ok');
    expect(c.weightAfterPct).toBeCloseTo(20, 9);
    expect(c.leftIls).toBe(0);
  });

  it('overCap: one agora past 20% is refused', () => {
    expect(buy({ amount: 200_000.01 }).status).toBe('overCap');
    expect(buy({ amount: 200_001 }).status).toBe('overCap');
  });

  it('overCap counts the holding at its last mark', () => {
    const holding = { units: 100, freeUnits: 100, valueIls: 150_000 };
    expect(buy({ holding, amount: 50_000 }).status).toBe('ok');
    expect(buy({ holding, amount: 50_001 }).status).toBe('overCap');
  });

  it('pending buys of the same symbol count toward the 20% (D-028)', () => {
    // ₪150,000 already waiting: ₪50,000 more reaches 20% exactly, ₪50,001 is over.
    expect(buy({ pendingBuysIls: 150_000, amount: 50_000 }).status).toBe('ok');
    const over = buy({ pendingBuysIls: 150_000, amount: 50_001 });
    expect(over.status).toBe('overCap');
    expect(over.maxIls).toBe(50_000);
    expect(over.weightAfterPct).toBeCloseTo(20.0001, 9);
    // Holding + pending + this order together.
    expect(buy({ holding: { units: 1, freeUnits: 1, valueIls: 100_000 }, pendingBuysIls: 90_000, amount: 10_001 }).status).toBe('overCap');
  });

  it('the cap is worked out in whole agorot, so float noise never flips the boundary', () => {
    // 0.1 + 0.2 style values: 20% of ₪333,333.33 is ₪66,666.666; ₪66,666.66 fits, ₪66,666.67 does not.
    expect(buy({ totalValue: 333_333.33, amount: 66_666.66 }).status).toBe('ok');
    expect(buy({ totalValue: 333_333.33, amount: 66_666.67 }).status).toBe('overCap');
    // The most allowed is what the amount field can hold: whole ₪, rounded DOWN (₪66,666.66 → ₪66,666).
    expect(buy({ totalValue: 333_333.33 }).maxIls).toBe(66_666);
  });

  it('a spending limit is never shown above what may be spent (whole ₪, rounded down)', () => {
    // ₪12,345.67 available: the most is ₪12,345; ₪12,346 is short by 33 agorot, not by "₪0".
    const cash = buy({ availableCash: 12_345.67, amount: 12_346 });
    expect(cash.status).toBe('noCash');
    expect(cash.maxIls).toBe(12_345);
    expect(buy({ availableCash: 12_345.67, amount: 12_345 }).status).toBe('ok');
    expect(shortfallIls(12_346, 12_345.67)).toBe(0.33);
    expect(shortfallIls(20_000, 12_345.67)).toBe(7_654.33);
    // Cap room of ₪12,345.67 (a holding of ₪187,654.33 on ₪1,000,000): the most is ₪12,345, ₪12,346 is over.
    const holding = { units: 1, freeUnits: 1, valueIls: 187_654.33 };
    expect(buy({ holding, amount: 12_346 }).status).toBe('overCap');
    expect(buy({ holding, amount: 12_346 }).maxIls).toBe(12_345);
    expect(buy({ holding, amount: 12_345 }).status).toBe('ok');
    // The room left after this buy: ₪2,345.67 shows as ₪2,345.
    expect(buy({ holding, amount: 10_000 }).leftIls).toBe(2_345);
  });

  it('cash is compared in whole agorot, so float noise in the stored figure never blocks an exact amount', () => {
    expect(buy({ availableCash: 9_999.999999999, amount: 10_000 }).status).toBe('ok');   // ₪10,000.00 with a float tail
    expect(buy({ availableCash: 9_999.99, amount: 10_000 }).status).toBe('noCash');
  });

  it('a pending list cut at the API limit makes the 20% room an upper bound, not exact', () => {
    expect(buy({}).capExact).toBe(true);
    expect(buy({ pendingCut: true }).capExact).toBe(false);
    expect(buy({ pendingCut: true }).status).toBe('ok');   // the server has the last word; the preview only stops claiming the exact room
    expect(sell({ holding: tenUnits, amount: 250, pendingCut: true }).capExact).toBe(true);   // a sell has no cap
    const one = { symbol: 'NVDA', side: 'buy' as const, amountIls: 100, units: null };
    expect(PENDING_LIST_MAX).toBe(50);
    expect(pendingListCut(Array.from({ length: 49 }, () => one))).toBe(false);
    expect(pendingListCut(Array.from({ length: 50 }, () => one))).toBe(true);
  });

  it('with no amount typed, a buy at the cap already says why (not "enter an amount")', () => {
    const atCap = { units: 1, freeUnits: 1, valueIls: 200_000 };
    expect(buy({ holding: atCap, amount: 0 }).status).toBe('overCap');
    expect(buy({ pendingBuysIls: 200_000, amount: 0 }).status).toBe('overCap');
    expect(buy({ amount: 0 }).status).toBe('empty');
  });

  it('belowMin: ₪100 is the smallest buy, exactly ₪100 is allowed', () => {
    expect(MIN_ORDER_ILS).toBe(100);
    expect(buy({ amount: 99 }).status).toBe('belowMin');
    expect(buy({ amount: 100 }).status).toBe('ok');
  });

  it('a US price is already in ₪ (the screen converts at the latest rate)', () => {
    expect(buy({ amount: 3_720, priceIls: 372 }).units).toBe(10);
  });
});

describe('checkOrder: sell', () => {
  it('ok: a part of the holding, sent as units', () => {
    const c = sell({ holding: tenUnits, amount: 250 });
    expect(c.status).toBe('ok');
    expect(c.sell).toEqual({ units: '2.50000000', all: false, valueIls: 250 });
    expect(c.units).toBe(2.5);
    expect(c.cashAfter).toBe(500_250);
    expect(c.leftIls).toBe(750);
    expect(c.weightAfterPct).toBeCloseTo(0.075, 9);
    expect(c.maxIls).toBe(1_000);
  });

  it('empty: no amount', () => {
    expect(sell({ holding: tenUnits, amount: 0 }).status).toBe('empty');
  });

  it('gameOver blocks a sell too', () => {
    expect(sell({ holding: tenUnits, amount: 250, gameOver: true }).status).toBe('gameOver');
  });

  it('nothingToSell: no holding', () => {
    expect(sell({ holding: null, amount: 250 }).status).toBe('nothingToSell');
    expect(sell({ holding: { units: 0, freeUnits: 0, valueIls: 0 }, amount: 250 }).status).toBe('nothingToSell');
  });

  it('locked: every unit is already in a pending sell', () => {
    const c = sell({ holding: { units: 10, freeUnits: 0, valueIls: 1_000 }, amount: 250 });
    expect(c.status).toBe('locked');
    expect(c.maxIls).toBe(0);
    expect(c.sell).toBeNull();
  });

  it('with no amount typed, a sell with nothing free or nothing held already says why', () => {
    // The "sell all" chip at ₪0 used to turn these into "enter an amount".
    expect(sell({ holding: { units: 10, freeUnits: 0, valueIls: 1_000 }, amount: 0 }).status).toBe('locked');
    expect(sell({ holding: null, amount: 0 }).status).toBe('nothingToSell');
    expect(sell({ holding: tenUnits, amount: 0 }).status).toBe('empty');
  });

  it('overHolding: more than the FREE units are worth', () => {
    const partly = { units: 10, freeUnits: 4, valueIls: 1_000 };   // ₪400 free
    expect(sell({ holding: partly, amount: 401 }).status).toBe('overHolding');
    expect(sell({ holding: partly, amount: 401 }).maxIls).toBe(400);
    expect(sell({ holding: partly, amount: 400 }).status).toBe('ok');
    expect(sell({ holding: tenUnits, amount: 1_001 }).status).toBe('overHolding');
  });

  it('belowMin: under ₪100 without selling everything free; exactly ₪100 is allowed', () => {
    expect(sell({ holding: tenUnits, amount: 99 }).status).toBe('belowMin');
    expect(sell({ holding: tenUnits, amount: 100 }).status).toBe('ok');
  });

  it('selling every free unit is allowed under ₪100 (D-028)', () => {
    const small = { units: 1, freeUnits: 0.6, valueIls: 100 };   // ₪60 free
    const c = sell({ holding: small, amount: 60 });
    expect(c.status).toBe('ok');
    expect(c.sell).toEqual({ units: '0.60000000', all: true, valueIls: 60 });
    expect(sell({ holding: small, amount: 59 }).status).toBe('belowMin');
  });

  it('a holding worth under ₪1 can still be closed with ₪1', () => {
    const dust = { units: 0.001, freeUnits: 0.001, valueIls: 0.3 };
    expect(shownFreeIls(dust)).toBe(1);
    expect(sell({ holding: dust, amount: 1 }).status).toBe('ok');
    expect(sell({ holding: dust, amount: 1 }).sell?.all).toBe(true);
  });
});

describe('sellPlan (D-018: a sell is units; the player types ₪)', () => {
  it('units = ₪ ÷ value per unit at the mark, rounded DOWN to 8 decimals', () => {
    // ₪1,000 for 3 units: ₪333.33… a unit. ₪100 → 0.300000003 units → 0.30000000.
    const h = { units: 3, freeUnits: 3, valueIls: 1_000 };
    expect(sellPlan(100, h)?.units).toBe('0.30000000');
    expect(sellPlan(500, h)?.units).toBe('1.50000000');
    // 1/7 of a unit: 0.142857142857… → 0.14285714 (down, not up to …15)
    expect(sellPlan(100, { units: 7, freeUnits: 7, valueIls: 4_900 })?.units).toBe('0.14285714');
  });

  it('reaching the free value as shown sends every free unit, exactly', () => {
    const h = { units: 12.34567891, freeUnits: 12.34567891, valueIls: 1_234.6 };   // shown as ₪1,235
    expect(shownFreeIls(h)).toBe(1_235);
    expect(sellPlan(1_235, h)).toEqual({ units: '12.34567891', all: true, valueIls: 1_234.6 });
    expect(sellPlan(1_234, h)?.all).toBe(false);
    // Shown as ₪1,234 (rounded down): typing ₪1,234 is everything.
    expect(sellPlan(1_234, { ...h, valueIls: 1_234.4 })?.all).toBe(true);
  });

  it('never more than the free units, even when most units are locked', () => {
    const h = { units: 10, freeUnits: 2.5, valueIls: 1_000 };   // ₪250 free
    expect(sellPlan(250, h)).toEqual({ units: '2.50000000', all: true, valueIls: 250 });
    expect(sellPlan(10_000, h)?.units).toBe('2.50000000');
    expect(sellPlan(200, h)?.units).toBe('2.00000000');
  });

  it('never 0 units, never a float tail, at most 8 decimals', () => {
    const pricey = { units: 1, freeUnits: 1, valueIls: 1e9 };
    expect(sellPlan(1, pricey)?.units).toBe('0.00000001');
    for (const amount of [101, 333, 777, 1_234]) {
      const units = sellPlan(amount, { units: 3.3, freeUnits: 3.3, valueIls: 9_999.99 })!.units;
      expect(units).toMatch(/^\d+\.\d{8}$/);
      expect(Number(units)).toBeGreaterThan(0);
    }
  });

  it('nothing to plan: no holding, no free units or no amount', () => {
    expect(sellPlan(100, null)).toBeNull();
    expect(sellPlan(100, { units: 5, freeUnits: 0, valueIls: 500 })).toBeNull();
    expect(sellPlan(0, tenUnits)).toBeNull();
  });
});

describe('pendingBuysIls', () => {
  it('sums only the pending BUYS of the symbol, in whole agorot', () => {
    const orders = [
      { symbol: 'NVDA', side: 'buy' as const, amountIls: 0.1, units: null },
      { symbol: 'NVDA', side: 'buy' as const, amountIls: 0.2, units: null },
      { symbol: 'NVDA', side: 'sell' as const, amountIls: null, units: 3 },
      { symbol: 'TEVA', side: 'buy' as const, amountIls: 5_000, units: null },
    ];
    expect(pendingBuysIls(orders, 'NVDA')).toBe(0.3);
    expect(pendingBuysIls(orders, 'TEVA')).toBe(5_000);
    expect(pendingBuysIls(orders, 'AAPL')).toBe(0);
  });
});

describe('every status has a test', () => {
  it('covers the full list', () => {
    const seen = new Set<CheckStatus>([
      buy({}).status, buy({ amount: 0 }).status, buy({ gameOver: true }).status, buy({ priceIls: null }).status,
      buy({ availableCash: 1 }).status, buy({ amount: 300_000 }).status, buy({ amount: 50 }).status,
      sell({ holding: null }).status, sell({ holding: { units: 1, freeUnits: 0, valueIls: 10 } }).status,
      sell({ holding: tenUnits, amount: 5_000 }).status,
    ]);
    const all: CheckStatus[] = ['ok', 'empty', 'gameOver', 'noPrice', 'noCash', 'overCap', 'belowMin', 'nothingToSell', 'locked', 'overHolding'];
    expect([...seen].sort()).toEqual([...all].sort());
    expect(CAP).toBe(0.2);
  });
});

describe('orderBody (the POST /me/orders body)', () => {
  it('a buy is ₪ with 2 decimals', () => {
    expect(orderBody({ symbol: 'NVDA', side: 'buy', amount: 10_000, sell: null })).toEqual({ symbol: 'NVDA', side: 'buy', amountIls: '10000.00' });
  });

  it('a sell is the planned units, as a string', () => {
    const plan = sellPlan(250, tenUnits);
    expect(orderBody({ symbol: 'TEVA', side: 'sell', amount: 250, sell: plan })).toEqual({ symbol: 'TEVA', side: 'sell', units: '2.50000000' });
  });

  it('nothing to send: no amount, or a sell with no plan', () => {
    expect(orderBody({ symbol: 'NVDA', side: 'buy', amount: 0, sell: null })).toBeNull();
    expect(orderBody({ symbol: 'NVDA', side: 'sell', amount: 250, sell: null })).toBeNull();
  });

  it('bodyKey: the same order gives the same key; any change gives another', () => {
    const a = orderBody({ symbol: 'NVDA', side: 'buy', amount: 10_000, sell: null })!;
    expect(bodyKey(a)).toBe(bodyKey({ ...a }));
    expect(bodyKey(a)).not.toBe(bodyKey({ ...a, amountIls: '10001.00' }));
    expect(bodyKey(a)).not.toBe(bodyKey({ ...a, symbol: 'AAPL' }));
    expect(bodyKey({ symbol: 'NVDA', side: 'sell', units: '1.00000000' })).not.toBe(bodyKey({ symbol: 'NVDA', side: 'sell', units: '1.00000001' }));
  });

  it('a buy with a stop loss sends it with 2 decimals; the stop is part of the key (D-037)', () => {
    const a = orderBody({ symbol: 'TEVA', side: 'buy', amount: 10_000, sell: null, stop: 95.5 })!;
    expect(a).toEqual({ symbol: 'TEVA', side: 'buy', amountIls: '10000.00', stopPrice: '95.50' });
    expect(orderBody({ symbol: 'TEVA', side: 'buy', amount: 10_000, sell: null, stop: null })).toEqual({ symbol: 'TEVA', side: 'buy', amountIls: '10000.00' });
    expect(bodyKey(a)).not.toBe(bodyKey({ ...a, stopPrice: '95.51' }));
    expect(bodyKey(a)).not.toBe(bodyKey({ symbol: 'TEVA', side: 'buy', amountIls: '10000.00' }));
  });

  it('a sell never carries a stop', () => {
    expect(orderBody({ symbol: 'TEVA', side: 'sell', amount: 250, sell: sellPlan(250, tenUnits), stop: 95 })).toEqual({ symbol: 'TEVA', side: 'sell', units: '2.50000000' });
  });
});

describe('checkStop (the stop loss in the preview, D-037)', () => {
  it('off: nothing to check', () => {
    expect(checkStop(null, 100, 10_000)).toEqual({ ok: true, status: 'off', stop: null, belowPct: 0, lossIls: 0 });
  });

  it('below the latest close: how far, and the loss if it sold exactly at the stop', () => {
    const c = checkStop(96, 100, 10_000);
    expect(c).toMatchObject({ ok: true, status: 'ok', stop: 96 });
    expect(c.belowPct).toBeCloseTo(4, 10);
    expect(c.lossIls).toBeCloseTo(400, 10);
  });

  it('judges the stop as it will be sent, with 2 decimals', () => {
    expect(checkStop(99.996, 100, 10_000)).toMatchObject({ ok: false, status: 'notBelow', stop: 100 });
    expect(checkStop(95.678, 100, 10_000).stop).toBe(95.68);
  });

  it('refuses a stop at or above the close, with no close, or at 0', () => {
    expect(checkStop(100, 100, 10_000)).toMatchObject({ ok: false, status: 'notBelow' });
    expect(checkStop(120, 100, 10_000)).toMatchObject({ ok: false, status: 'notBelow' });
    expect(checkStop(95, null, 10_000)).toMatchObject({ ok: false, status: 'noPrice' });
    expect(checkStop(0.001, 100, 10_000)).toMatchObject({ ok: false, status: 'empty' });
  });
});

describe('newClientOrderId', () => {
  it('matches the server pattern and differs every time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newClientOrderId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('works without crypto.randomUUID (an older engine, or http on a LAN address)', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const a = newClientOrderId();
      const b = newClientOrderId();
      expect(a).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(a).not.toBe(b);
    } finally {
      if (real) Object.defineProperty(globalThis, 'crypto', real);
    }
  });
});

describe('sendFailure (what the player reads when a send fails)', () => {
  it('a network failure or timeout: may not have gone through, pressing again is safe', () => {
    expect(sendFailure(null)).toEqual({ message: NETWORK_FAILURE, retry: true, outcome: 'unknown', reload: true });
    expect(NETWORK_FAILURE).toContain('שוב');
  });

  it('a 5xx is just as uncertain: keep the id and offer to press again', () => {
    expect(sendFailure({ status: 500, body: null })).toEqual({ message: NETWORK_FAILURE, retry: true, outcome: 'unknown', reload: true });
    expect(sendFailure({ status: 503, body: { error: 'x' } }).retry).toBe(true);
  });

  it("the server's Hebrew reason wins", () => {
    const f = sendFailure({ status: 422, body: { error: 'x', code: 'OVER_LIMIT', reason: 'ההחזקה תגיע ל־21.3% מהתיק' } });
    expect(f).toEqual({ message: 'ההחזקה תגיע ל־21.3% מהתיק', retry: false, outcome: 'refused', reload: true });
  });

  it('a refusal means the preview was out of date: reload (all but a rate limit, where nothing changed)', () => {
    for (const code of ['GAME_OVER', 'NO_WORLD', 'INSUFFICIENT_CASH', 'NO_POSITION', 'INSUFFICIENT_UNITS', 'OVER_LIMIT', 'BELOW_MIN']) {
      const status = code === 'GAME_OVER' || code === 'NO_WORLD' ? 409 : 422;
      expect(sendFailure({ status, body: { error: 'x', code } })).toMatchObject({ outcome: 'refused', reload: true });
    }
    expect(sendFailure({ status: 429, body: { error: 'x', code: 'RATE_LIMITED' } })).toMatchObject({ outcome: 'refused', reload: false, retry: true });
  });

  it('a Hebrew fallback for every code that comes without a reason', () => {
    const codes = ['BAD_REQUEST', 'UNKNOWN_SYMBOL', 'NO_USER', 'NO_WORLD', 'GAME_OVER', 'CLIENT_ID_CONFLICT', 'BELOW_MIN',
      'INSUFFICIENT_CASH', 'NO_POSITION', 'INSUFFICIENT_UNITS', 'OVER_LIMIT', 'RATE_LIMITED'];
    const texts = codes.map((code) => sendFailure({ status: 422, body: { error: 'x', code } }).message);
    for (const t of texts) expect(t).toMatch(/[א-ת]/);
    expect(new Set(texts).size).toBe(codes.length);
  });

  it('a client id conflict retires the id; rate limited may be pressed again', () => {
    expect(sendFailure({ status: 409, body: { error: 'x', code: 'CLIENT_ID_CONFLICT' } })).toMatchObject({ retry: true, outcome: 'conflict' });
    expect(sendFailure({ status: 429, body: { error: 'x', code: 'RATE_LIMITED', reason: 'יותר מדי הזמנות' } })).toMatchObject({ retry: true, outcome: 'refused' });
    expect(sendFailure({ status: 409, body: { error: 'x', code: 'GAME_OVER' } })).toMatchObject({ retry: false, outcome: 'refused' });
  });

  it('an unknown body or code gets a generic Hebrew line, never English', () => {
    for (const body of [null, 'oops', { error: 'invalid token' }, { code: 'toString' }, { code: 'NEW_CODE', reason: '' }]) {
      const f = sendFailure({ status: 401, body });
      expect(f.message).toMatch(/[א-ת]/);
      expect(f.retry).toBe(false);
    }
  });
});

describe('cleanAmount (unchanged)', () => {
  it('digits only, no leading zeros, at most 7 digits', () => {
    expect(cleanAmount('₪0012,500')).toBe('12500');
    expect(cleanAmount('123456789')).toBe('1234567');
  });
});

describe('groupAmount', () => {
  it('shows the digits with thousands commas, and an empty field stays empty', () => {
    expect(groupAmount('')).toBe('');
    expect(groupAmount('100')).toBe('100');
    expect(groupAmount('100000')).toBe('100,000');
    expect(groupAmount('1000000')).toBe('1,000,000');
  });

  it('round-trips through cleanAmount', () => {
    expect(cleanAmount(groupAmount('1234567'))).toBe('1234567');
  });
});

describe('the amount slider', () => {
  it('a buy runs from the ₪100 minimum to the whole-₪ maximum, or not at all under ₪100', () => {
    expect(sliderRange('buy', 187_654.9)).toEqual({ lo: MIN_ORDER_ILS, hi: 187_654 });
    expect(sliderRange('buy', 100)).toEqual({ lo: 100, hi: 100 });
    expect(sliderRange('buy', 99.99)).toBeNull();
    expect(sliderRange('buy', 0)).toBeNull();
  });

  it('a sell worth under ₪100 can still sell everything; nothing free means no slider', () => {
    expect(sliderRange('sell', 5_000)).toEqual({ lo: 100, hi: 5_000 });
    expect(sliderRange('sell', 50)).toEqual({ lo: 50, hi: 50 });
    expect(sliderRange('sell', 0)).toBeNull();
  });

  it('the ends are exactly the minimum and the maximum; in between moves in ₪100 steps', () => {
    const r = { lo: 100, hi: 187_654 };
    expect(sliderAmount(0, r)).toBe(100);
    expect(sliderAmount(-0.2, r)).toBe(100);
    expect(sliderAmount(1, r)).toBe(187_654);
    expect(sliderAmount(1.3, r)).toBe(187_654);
    expect(sliderAmount(0.5, r) % SLIDER_STEP).toBe(0);
    expect(sliderAmount(0.99999, r)).toBeLessThanOrEqual(187_654);   // rounding up never passes the maximum
  });

  it('a one-amount range always picks it', () => {
    expect(sliderAmount(0, { lo: 50, hi: 50 })).toBe(50);
    expect(sliderAmount(0.4, { lo: 50, hi: 50 })).toBe(50);
  });

  it('follows the typed amount, and an amount outside the range sits at an end', () => {
    const r = { lo: 100, hi: 10_100 };
    expect(sliderRatio(5_100, r)).toBe(0.5);
    expect(sliderRatio(0, r)).toBe(0);
    expect(sliderRatio(50_000, r)).toBe(1);
    expect(sliderRatio(50, { lo: 50, hi: 50 })).toBe(1);
    expect(sliderRatio(0, { lo: 50, hi: 50 })).toBe(0);
  });
});

// ---------- which clientOrderId goes with which order ----------

describe('SendMemory: a retry after no answer can never make a second order', () => {
  const buyBody = (amountIls: string): OrderBody => ({ symbol: 'NVDA', side: 'buy', amountIls });
  let n = 0;
  const fresh = () => new SendMemory(() => `id-${++n}`);

  it('the confirm step makes the id, and the send uses that same id', () => {
    const m = fresh();
    m.prepare('NVDA:buy:10000', buyBody('10000.00'));
    const a = m.pick('NVDA:buy:10000', buyBody('10000.00'))!;
    expect(m.pick('NVDA:buy:10000', buyBody('10000.00'))!.id).toBe(a.id);
    expect(a.body).toEqual(buyBody('10000.00'));
  });

  it('an unanswered send keeps its id while other orders are prepared and sent in between', () => {
    const m = fresh();
    const first = m.pick('NVDA:buy:10000', buyBody('10000.00'))!;
    m.settle('NVDA:buy:10000', first, 'unknown');
    // Compare with ₪25,000: its confirm step opens, then it is sent and stored.
    m.prepare('NVDA:buy:25000', buyBody('25000.00'));
    const other = m.pick('NVDA:buy:25000', buyBody('25000.00'))!;
    expect(other.id).not.toBe(first.id);
    m.settle('NVDA:buy:25000', other, 'stored');
    // Back to ₪10,000: the same id again, so the server answers with the stored order (replay).
    m.prepare('NVDA:buy:10000', buyBody('10000.00'));
    expect(m.pick('NVDA:buy:10000', buyBody('10000.00'))).toEqual(first);
  });

  it('a retry resends the exact body that went out, even when new data changed what the ticket works out', () => {
    const m = fresh();
    // ₪500 of a holding worth ₪1,000.40 is some units; after a reload the same ₪500 is "sell all" (other units).
    const before: OrderBody = { symbol: 'TEVA', side: 'sell', units: '4.99800080' };
    const after: OrderBody = { symbol: 'TEVA', side: 'sell', units: '5.00200000' };
    const sent = m.pick('TEVA:sell:500', before)!;
    m.settle('TEVA:sell:500', sent, 'unknown');
    expect(m.pick('TEVA:sell:500', after)).toEqual(sent);
  });

  it('the same body under another ticket text reuses the unanswered id too', () => {
    const m = fresh();
    const sent = m.pick('NVDA:buy:10000', buyBody('10000.00'))!;
    m.settle('NVDA:buy:10000', sent, 'unknown');
    expect(m.pick('NVDA:buy:other', buyBody('10000.00'))!.id).toBe(sent.id);
  });

  it('once stored, the same order again is a NEW order (a new id)', () => {
    const m = fresh();
    const a = m.pick('NVDA:buy:10000', buyBody('10000.00'))!;
    m.settle('NVDA:buy:10000', a, 'unknown');
    m.settle('NVDA:buy:10000', a, 'stored');   // the retry got the replay
    const b = m.pick('NVDA:buy:10000', buyBody('10000.00'))!;
    expect(b.id).not.toBe(a.id);
  });

  it('a conflict retires the id; a refusal frees the ticket (nothing was stored under that id)', () => {
    const m = fresh();
    const a = m.pick('NVDA:buy:10000', buyBody('10000.00'))!;
    m.settle('NVDA:buy:10000', a, 'conflict');
    expect(m.pick('NVDA:buy:10000', buyBody('10000.00'))!.id).not.toBe(a.id);

    const u = m.pick('NVDA:sell:500', { symbol: 'NVDA', side: 'sell', units: '1.00000000' })!;
    m.settle('NVDA:sell:500', u, 'unknown');
    m.settle('NVDA:sell:500', u, 'refused');   // e.g. INSUFFICIENT_UNITS: the replay check runs first, so it was never stored
    expect(m.pick('NVDA:sell:500', { symbol: 'NVDA', side: 'sell', units: '0.90000000' })!.body.units).toBe('0.90000000');
  });

  it('nothing to send: no body and no unanswered send', () => {
    expect(fresh().pick('NVDA:buy:0', null)).toBeNull();
  });

  it('kept per player for the life of the page (leaving the screen keeps it; another player never gets it)', () => {
    expect(memoryFor('uid-a')).toBe(memoryFor('uid-a'));
    expect(memoryFor('uid-a')).not.toBe(memoryFor('uid-b'));
  });
});
