// Executing the orders of one market event (api/src/game/engine.ts; D-018, D-019, D-020). Pure, no database.
// Every batch run through `run()` is also reconciled: each output journal must balance, and the ledger
// that matched the input state, plus the output journals, must equal the output state.
// Dates: Monday 09.11.2026 and Tuesday 10.11.2026. In November Israel is UTC+2, so the TASE close (17:30)
// is 15:30Z, the US open (16:30) 14:30Z and the US close (23:00) 21:00Z.

import { describe, expect, it } from 'vitest';
import { avgCost, format, parse, SCALE, unitsFor, valueIls } from '../src/game/fixed.js';
import {
  type Entry, isBalanced, type Journal, ledgerBalances, releaseJournal, reserveJournal, startJournal,
} from '../src/game/ledger.js';
import {
  type DueOrder, type EventInput, executeOrders, type ExecuteResult, type OrderResult, type PortfolioState,
  type PositionState, REASONS, sortOrders,
} from '../src/game/engine.js';
import { markPositions, totals } from '../src/game/week.js';
import type { Market } from '../src/game/marketHours.js';

// ---------- builders ----------

const ils = (s: string) => parse(s, SCALE.ILS);
const units = (s: string) => parse(s, SCALE.UNITS);
const price = (s: string) => parse(s, SCALE.PRICE);
const rate = (s: string) => parse(s, SCALE.RATE);
const money = (v: bigint | null) => (v === null ? null : format(v, SCALE.ILS));

const TASE_CLOSE = new Date('2026-11-09T15:30:00Z');
const US_CLOSE = new Date('2026-11-09T21:00:00Z');
const NEXT_TASE_CLOSE = new Date('2026-11-10T15:30:00Z');
const NEXT_US_OPEN = new Date('2026-11-10T14:30:00Z');
const NEXT_US_CLOSE = new Date('2026-11-10T21:00:00Z');
const OPENED = new Date('2026-11-02T08:00:00Z');

const defaultAt = (market: Market) => (market === 'US' ? US_CLOSE : TASE_CLOSE);

function portfolio(
  uid: string,
  cash: string,
  opts: { reserved?: string; realized?: string; positions?: PositionState[] } = {},
): PortfolioState {
  return {
    uid,
    cash: ils(cash),
    reservedCash: ils(opts.reserved ?? '0'),
    realizedPnl: ils(opts.realized ?? '0'),
    positions: opts.positions ?? [],
  };
}

function position(symbol: string, market: Market, u: string, cost: string, more: Partial<PositionState> = {}): PositionState {
  const un = units(u);
  const cb = ils(cost);
  return {
    id: '100', symbol, market, status: 'open',
    units: un, reservedUnits: 0n, costBasis: cb, avgCost: avgCost(cb, un), realizedPnl: 0n,
    lastPrice: null, lastRate: null, marketValue: null, markedAt: null,
    openedAt: OPENED, closedAt: null,
    ...more,
  };
}

function buy(id: string, uid: string, symbol: string, market: Market, amount: string, executesAt = defaultAt(market)): DueOrder {
  return { id, uid, symbol, market, side: 'buy', amountIls: ils(amount), units: null, executesAt };
}

function sell(id: string, uid: string, symbol: string, market: Market, u: string, executesAt = defaultAt(market)): DueOrder {
  return { id, uid, symbol, market, side: 'sell', amountIls: null, units: units(u), executesAt };
}

function event(market: Market, prices: Record<string, string>, opts: { rate?: string; at?: Date } = {}): EventInput {
  return {
    market,
    kind: 'close',
    at: opts.at ?? defaultAt(market),
    prices: new Map(Object.entries(prices).map(([s, p]) => [s, price(p)])),
    rate: rate(opts.rate ?? (market === 'US' ? '3.7000' : '1.0000')),
  };
}

type Executed = Extract<OrderResult, { status: 'executed' }>;
type Rejected = Extract<OrderResult, { status: 'rejected' }>;

function executed(r: OrderResult): Executed {
  if (r.status !== 'executed') throw new Error(`order ${r.orderId} was rejected: ${r.code} ${r.reason}`);
  return r;
}

function rejected(r: OrderResult): Rejected {
  if (r.status !== 'rejected') throw new Error(`order ${r.orderId} executed`);
  return r;
}

// ---------- reconciliation ----------

// A ledger that matches a portfolio state: one journal that puts every balance where the state says it is.
function openingJournal(p: PortfolioState): Journal {
  const entries: Entry[] = [
    { account: 'cash_free', symbol: null, amount: p.cash - p.reservedCash },
    { account: 'cash_locked', symbol: null, amount: p.reservedCash },
    ...p.positions.map((x): Entry => ({ account: 'stock_cost', symbol: x.symbol, amount: x.costBasis })),
    { account: 'realized_pnl', symbol: null, amount: -p.realizedPnl },
  ];
  const capital = -entries.reduce((s, e) => s + e.amount, 0n);
  return {
    kind: 'start', orderId: null,
    entries: [...entries, { account: 'capital' as const, symbol: null, amount: capital }].filter((e) => e.amount !== 0n),
  };
}

// cash + Σ cost − realized gain: what the player was given. No order may change it.
const capitalOf = (p: PortfolioState) => p.cash + p.positions.reduce((s, x) => s + x.costBasis, 0n) - p.realizedPnl;

function expectLedgerMatches(input: Map<string, PortfolioState>, out: ExecuteResult): void {
  for (const { uid, journal } of out.journals) {
    expect(isBalanced(journal), `${uid} ${journal.kind} ${journal.orderId}`).toBe(true);
    expect(out.portfolios.has(uid)).toBe(true);
  }
  for (const [uid, after] of out.portfolios) {
    const before = input.get(uid)!;
    const opening = openingJournal(before);
    const b = ledgerBalances([opening, ...out.journals.filter((j) => j.uid === uid).map((j) => j.journal)]);
    expect(b.cashFree + b.cashLocked, `${uid} cash`).toBe(after.cash);
    expect(b.cashLocked, `${uid} reserved cash`).toBe(after.reservedCash);
    expect(-b.realizedPnl, `${uid} realized`).toBe(after.realizedPnl);
    expect(b.capital, `${uid} capital`).toBe(ledgerBalances([opening]).capital);
    const symbols = new Set([...b.stockCost.keys(), ...after.positions.map((x) => x.symbol)]);
    for (const s of symbols) {
      expect(b.stockCost.get(s) ?? 0n, `${uid} stock_cost ${s}`).toBe(after.positions.find((x) => x.symbol === s)?.costBasis ?? 0n);
    }
    expect(capitalOf(after), `${uid} money created or lost`).toBe(capitalOf(before));
    // The database CHECKs.
    expect(after.reservedCash >= 0n && after.reservedCash <= after.cash, `${uid} reserved cash range`).toBe(true);
    expect(new Set(after.positions.map((x) => x.symbol)).size).toBe(after.positions.length);
    for (const x of after.positions) {
      expect(x.status).toBe('open');
      expect(x.units > 0n, `${x.symbol} units`).toBe(true);
      expect(x.reservedUnits >= 0n && x.reservedUnits <= x.units, `${x.symbol} reserved units`).toBe(true);
      expect(x.costBasis >= 0n && x.avgCost >= 0n, `${x.symbol} cost`).toBe(true);
    }
  }
  for (const c of out.closed) {
    expect(c).toMatchObject({ status: 'closed', units: 0n, reservedUnits: 0n, costBasis: 0n });
    expect(c.closedAt).not.toBeNull();
  }
}

function run(ev: EventInput, orders: DueOrder[], ...portfolios: PortfolioState[]): ExecuteResult {
  const input = new Map(portfolios.map((p) => [p.uid, p]));
  const out = executeOrders(ev, orders, input);
  expectLedgerMatches(input, out);
  expect(out.results.map((r) => r.orderId)).toEqual(sortOrders(orders).map((o) => o.id));
  return out;
}

// ---------- the worked examples ----------

describe('the worked example from the money model', () => {
  it('buy NVDA ₪100,000 at $150 / 3.70, mark at $160, sell half at $165 / 3.65', () => {
    // Sign-up and sending the order wrote these journals before the event.
    const sent = [startJournal(ils('1000000.00')), reserveJournal('1', ils('100000.00'))];
    const p0 = portfolio('u1', '1000000.00', { reserved: '100000.00' });

    // 1. The buy fills at the US close.
    const b1 = run(event('US', { NVDA: '150.0000' }, { rate: '3.7000' }), [buy('1', 'u1', 'NVDA', 'US', '100000.00')], p0);
    const r1 = executed(b1.results[0]);
    expect(r1).toMatchObject({ side: 'buy', symbol: 'NVDA', fillPrice: price('150.0000'), rate: rate('3.7000'), realizedPnl: null });
    expect(format(r1.filledUnits, SCALE.UNITS)).toBe('180.18018018');
    expect(money(r1.filledIls)).toBe('100000.00');

    const p1 = b1.portfolios.get('u1')!;
    expect(money(p1.cash)).toBe('900000.00');
    expect(p1.reservedCash).toBe(0n);
    expect(p1.realizedPnl).toBe(0n);
    expect(p1.positions).toEqual([{
      id: null, symbol: 'NVDA', market: 'US', status: 'open',
      units: units('180.18018018'), reservedUnits: 0n,
      costBasis: ils('100000.00'), avgCost: parse('555.00000000', SCALE.AVG_COST), realizedPnl: 0n,
      lastPrice: price('150.0000'), lastRate: rate('3.7000'), marketValue: ils('100000.00'), markedAt: US_CLOSE,
      openedAt: US_CLOSE, closedAt: null,
    }]);
    expect(r1.position).toEqual(p1.positions[0]);
    expect(b1.journals).toEqual([{
      uid: 'u1',
      journal: {
        kind: 'buy', orderId: '1',
        entries: [
          { account: 'cash_locked', symbol: null, amount: ils('-100000.00') },
          { account: 'stock_cost', symbol: 'NVDA', amount: ils('100000.00') },
        ],
      },
    }]);
    expect(ledgerBalances([...sent, ...b1.journals.map((j) => j.journal)])).toEqual({
      cashFree: ils('900000.00'), cashLocked: 0n, realizedPnl: 0n, capital: ils('-1000000.00'),
      stockCost: new Map([['NVDA', ils('100000.00')]]),
    });

    // 2. The next US open marks it at $160 / 3.70.
    const marked = markPositions(p1.positions, 'US', new Map([['NVDA', price('160.0000')]]), rate('3.7000'), NEXT_US_OPEN);
    expect(money(marked[0].marketValue)).toBe('106666.67');
    const t1 = totals(p1.cash, marked);
    expect(money(t1.holdingsValue)).toBe('106666.67');
    expect(money(t1.unrealizedPnl)).toBe('6666.67');
    expect(money(t1.equity)).toBe('1006666.67');

    // 3. The player sends a sell of half (the units are locked), and it fills at the close: $165 / 3.65.
    const p2: PortfolioState = { ...p1, positions: [{ ...marked[0], id: '55', reservedUnits: units('90.09009009') }] };
    const b2 = run(
      event('US', { NVDA: '165.0000' }, { rate: '3.6500', at: NEXT_US_CLOSE }),
      [sell('2', 'u1', 'NVDA', 'US', '90.09009009', NEXT_US_CLOSE)],
      p2,
    );
    const r2 = executed(b2.results[0]);
    expect(r2).toMatchObject({ side: 'sell', fillPrice: price('165.0000'), rate: rate('3.6500'), filledUnits: units('90.09009009') });
    expect(money(r2.filledIls)).toBe('54256.76');
    expect(money(r2.realizedPnl)).toBe('4256.76');

    const p3 = b2.portfolios.get('u1')!;
    expect(money(p3.cash)).toBe('954256.76');
    expect(money(p3.realizedPnl)).toBe('4256.76');
    expect(p3.positions).toHaveLength(1);
    expect(p3.positions[0]).toMatchObject({
      id: '55', status: 'open', units: units('90.09009009'), reservedUnits: 0n,
      costBasis: ils('50000.00'), avgCost: parse('555.00000000', SCALE.AVG_COST), realizedPnl: ils('4256.76'),
      lastPrice: price('165.0000'), lastRate: rate('3.6500'), marketValue: ils('54256.76'), markedAt: NEXT_US_CLOSE,
    });
    expect(b2.journals.map((j) => j.journal)).toEqual([{
      kind: 'sell', orderId: '2',
      entries: [
        { account: 'cash_free', symbol: null, amount: ils('54256.76') },
        { account: 'stock_cost', symbol: 'NVDA', amount: ils('-50000.00') },
        { account: 'realized_pnl', symbol: null, amount: ils('-4256.76') },
      ],
    }]);
    const t2 = totals(p3.cash, p3.positions);
    expect(money(t2.holdingsValue)).toBe('54256.76');
    expect(money(t2.unrealizedPnl)).toBe('4256.76');
    expect(money(t2.equity)).toBe('1008513.52');

    expect(ledgerBalances([...sent, ...b1.journals.map((j) => j.journal), ...b2.journals.map((j) => j.journal)])).toEqual({
      cashFree: ils('954256.76'), cashLocked: 0n, realizedPnl: ils('-4256.76'), capital: ils('-1000000.00'),
      stockCost: new Map([['NVDA', ils('50000.00')]]),
    });
  });

  it('buy ₪1,000 at ₪100 (10 units), sell the 10 at ₪110: +₪100 and the position closes at cost 0 (D-019)', () => {
    const sent = [startJournal(ils('1000000.00')), reserveJournal('1', ils('1000.00'))];
    const b1 = run(event('TASE', { TEVA: '100.0000' }), [buy('1', 'u1', 'TEVA', 'TASE', '1000.00')],
      portfolio('u1', '1000000.00', { reserved: '1000.00' }));
    const r1 = executed(b1.results[0]);
    expect(r1.filledUnits).toBe(units('10'));
    expect(r1.rate).toBeNull();                   // TASE: no exchange rate
    expect(r1.position.lastRate).toBeNull();
    expect(r1.position.avgCost).toBe(parse('100', SCALE.AVG_COST));
    const p1 = b1.portfolios.get('u1')!;
    expect(money(p1.cash)).toBe('999000.00');

    const p2: PortfolioState = { ...p1, positions: [{ ...p1.positions[0], id: '8', reservedUnits: units('10') }] };
    const b2 = run(event('TASE', { TEVA: '110.0000' }, { at: NEXT_TASE_CLOSE }),
      [sell('2', 'u1', 'TEVA', 'TASE', '10', NEXT_TASE_CLOSE)], p2);
    const r2 = executed(b2.results[0]);
    expect(money(r2.filledIls)).toBe('1100.00');
    expect(money(r2.realizedPnl)).toBe('100.00');

    const p3 = b2.portfolios.get('u1')!;
    expect(money(p3.cash)).toBe('1000100.00');    // back to the start + ₪100
    expect(money(p3.realizedPnl)).toBe('100.00');
    expect(p3.positions).toEqual([]);
    expect(b2.closed).toHaveLength(1);
    expect(b2.closed[0]).toMatchObject({
      id: '8', symbol: 'TEVA', status: 'closed', units: 0n, reservedUnits: 0n, costBasis: 0n,
      avgCost: parse('100', SCALE.AVG_COST), realizedPnl: ils('100.00'), marketValue: 0n, closedAt: NEXT_TASE_CLOSE,
    });
    expect(r2.position).toEqual(b2.closed[0]);

    // The D-019 table, line by line.
    const all = [...sent, ...b1.journals.map((j) => j.journal), ...b2.journals.map((j) => j.journal)];
    expect(all.map((j) => [j.kind, j.entries.map((e) => `${e.account}${e.symbol ? ':' + e.symbol : ''} ${money(e.amount)}`)])).toEqual([
      ['start', ['cash_free 1000000.00', 'capital -1000000.00']],
      ['reserve', ['cash_free -1000.00', 'cash_locked 1000.00']],
      ['buy', ['cash_locked -1000.00', 'stock_cost:TEVA 1000.00']],
      ['sell', ['cash_free 1100.00', 'stock_cost:TEVA -1000.00', 'realized_pnl -100.00']],
    ]);
    const b = ledgerBalances(all);
    expect([money(b.cashFree), money(b.cashLocked), money(b.stockCost.get('TEVA')!), money(b.realizedPnl)])
      .toEqual(['1000100.00', '0.00', '0.00', '-100.00']);
  });
});

// ---------- the 20% limit ----------

describe('the 20% limit at the execution price (D-020)', () => {
  it('allows exactly 20% and rejects one agora more', () => {
    const ok = run(event('TASE', { X: '100.0000' }), [buy('1', 'u1', 'X', 'TASE', '200000.00')],
      portfolio('u1', '1000000.00', { reserved: '200000.00' }));
    executed(ok.results[0]);

    const over = run(event('TASE', { X: '100.0000' }), [buy('1', 'u1', 'X', 'TASE', '200000.01')],
      portfolio('u1', '1000000.00', { reserved: '200000.01' }));
    const r = rejected(over.results[0]);
    expect(r.code).toBe('OVER_LIMIT');
    // 20.000001% rounds to 20.0; a breach is shown as 20.1 so it never reads as allowed.
    expect(r.reason).toBe('ההחזקה הייתה מגיעה ל־20.1% מהתיק (מותר עד 20%)');
    expect(over.portfolios.get('u1')).toEqual(portfolio('u1', '1000000.00'));
    expect(over.journals.map((j) => j.journal)).toEqual([releaseJournal('1', ils('200000.01'))]);
  });

  it('a breach of 20.04% also shows as 20.1%, never as 20.0% next to "allowed up to 20%"', () => {
    const out = run(event('TASE', { X: '100.0000' }), [buy('1', 'u1', 'X', 'TASE', '200400.00')],
      portfolio('u1', '1000000.00', { reserved: '200400.00' }));
    expect(rejected(out.results[0]).reason).toBe('ההחזקה הייתה מגיעה ל־20.1% מהתיק (מותר עד 20%)');
  });

  it('rounds the shown percent once, from the exact ratio, half up', () => {
    const reasonFor = (amount: string) => rejected(run(event('TASE', { X: '100.0000' }), [buy('1', 'u1', 'X', 'TASE', amount)],
      portfolio('u1', '1000000.00', { reserved: amount })).results[0]).reason;
    // 21.34995%: one rounding gives 21.3. Rounding to 21.3500 first and then to one decimal would give 21.4.
    expect(reasonFor('213499.50')).toBe('ההחזקה הייתה מגיעה ל־21.3% מהתיק (מותר עד 20%)');
    expect(reasonFor('213500.00')).toBe('ההחזקה הייתה מגיעה ל־21.4% מהתיק (מותר עד 20%)');   // 21.35 → 21.4
  });

  it('values the held stock at the execution price, not its last mark', () => {
    // 1,000 TEVA marked at ₪100 (₪100,000). At the execution price of ₪150 the holding is ₪150,000 and the
    // portfolio ₪1,050,000, so the most one may add is ₪210,000 − ₪150,000 = ₪60,000.
    const teva = position('TEVA', 'TASE', '1000', '100000.00', { lastPrice: price('100.0000'), marketValue: ils('100000.00') });
    const at150 = (amount: string) =>
      run(event('TASE', { TEVA: '150.0000' }), [buy('1', 'u1', 'TEVA', 'TASE', amount)],
        portfolio('u1', '900000.00', { reserved: amount, positions: [teva] }));

    executed(at150('60000.00').results[0]);
    expect(rejected(at150('60000.01').results[0]).code).toBe('OVER_LIMIT');
    // ₪100,000 would be fine at the old mark (₪200,000 of ₪1,000,000) but is 23.8% at the real price.
    const r = rejected(at150('100000.00').results[0]);
    expect(r.reason).toBe('ההחזקה הייתה מגיעה ל־23.8% מהתיק (מותר עד 20%)');

    // A falling price works the other way: at ₪50 the portfolio is ₪950,000 and ₪140,000 more is exactly 20%.
    const at50 = (amount: string) =>
      run(event('TASE', { TEVA: '50.0000' }), [buy('1', 'u1', 'TEVA', 'TASE', amount)],
        portfolio('u1', '900000.00', { reserved: amount, positions: [teva] }));
    executed(at50('140000.00').results[0]);
    expect(rejected(at50('140000.01').results[0]).code).toBe('OVER_LIMIT');
  });

  it('counts reserved cash in the portfolio value', () => {
    // ₪600,000 is locked by this order and other pending ones; the portfolio is still ₪1,000,000.
    const out = run(event('TASE', { X: '100.0000' }), [buy('1', 'u1', 'X', 'TASE', '200000.00')],
      portfolio('u1', '1000000.00', { reserved: '600000.00' }));
    executed(out.results[0]);
    expect(money(out.portfolios.get('u1')!.reservedCash)).toBe('400000.00');
  });

  it("values the other market's positions at their last mark", () => {
    // A US event. LEUMI (TASE) cost ₪200,000 and is marked at ₪250,000: the portfolio is ₪1,000,000.
    // At cost it would be ₪950,000 and ₪200,000 would break the limit.
    const leumi = position('LEUMI', 'TASE', '10000', '200000.00', { lastPrice: price('25.0000'), marketValue: ils('250000.00') });
    // A stray TASE price in a US event's map must not be used.
    const ev = event('US', { NVDA: '150.0000', LEUMI: '1.0000' });
    const send = (amount: string) => run(ev, [buy('1', 'u1', 'NVDA', 'US', amount)],
      portfolio('u1', '750000.00', { reserved: amount, positions: [leumi] }));
    executed(send('200000.00').results[0]);
    expect(rejected(send('200000.01').results[0]).code).toBe('OVER_LIMIT');
  });

  it('values a position with no mark yet at its cost', () => {
    const leumi = position('LEUMI', 'TASE', '10000', '250000.00');   // never marked
    const send = (amount: string) => run(event('US', { NVDA: '150.0000' }), [buy('1', 'u1', 'NVDA', 'US', amount)],
      portfolio('u1', '750000.00', { reserved: amount, positions: [leumi] }));
    executed(send('200000.00').results[0]);
    expect(rejected(send('200000.01').results[0]).code).toBe('OVER_LIMIT');
  });

  it("values this market's other positions at this event's price", () => {
    // A: 1,000 units marked at ₪100, executing at ₪200, so the portfolio is ₪900,000 + ₪200,000.
    const a = position('A', 'TASE', '1000', '100000.00', { lastPrice: price('100.0000'), marketValue: ils('100000.00') });
    const send = (amount: string) => run(event('TASE', { A: '200.0000', B: '50.0000' }), [buy('1', 'u1', 'B', 'TASE', amount)],
      portfolio('u1', '900000.00', { reserved: amount, positions: [a] }));
    executed(send('220000.00').results[0]);
    expect(rejected(send('220000.01').results[0]).code).toBe('OVER_LIMIT');
  });

  it("values this market's position with no price at this event at its last mark", () => {
    const a = position('A', 'TASE', '1000', '80000.00', { lastPrice: price('100.0000'), marketValue: ils('100000.00') });
    const send = (amount: string) => run(event('TASE', { B: '50.0000' }), [buy('1', 'u1', 'B', 'TASE', amount)],
      portfolio('u1', '900000.00', { reserved: amount, positions: [a] }));
    executed(send('200000.00').results[0]);
    expect(rejected(send('200000.01').results[0]).code).toBe('OVER_LIMIT');
  });

  it('checks several buys of one stock at one event one by one, each seeing the ones before it', () => {
    const out = run(
      event('TASE', { X: '100.0000' }),
      [buy('1', 'u1', 'X', 'TASE', '150000.00'), buy('2', 'u1', 'X', 'TASE', '50000.00'), buy('3', 'u1', 'X', 'TASE', '100.00')],
      portfolio('u1', '1000000.00', { reserved: '200100.00' }),
    );
    executed(out.results[0]);
    executed(out.results[1]);                     // ₪150,000 + ₪50,000 = exactly 20%
    const r = rejected(out.results[2]);           // ₪200,100 of ₪1,000,000
    expect(r.code).toBe('OVER_LIMIT');
    const p = out.portfolios.get('u1')!;
    expect(p.positions).toHaveLength(1);
    expect(p.positions[0]).toMatchObject({ units: units('2000'), costBasis: ils('200000.00') });
    expect(p.reservedCash).toBe(0n);
    expect(money(p.cash)).toBe('800000.00');
  });

  it('uses rate 1.0000 for TASE whatever rate the event carries', () => {
    const ev = { ...event('TASE', { X: '100.0000' }), rate: rate('3.7000') };
    const out = run(ev, [buy('1', 'u1', 'X', 'TASE', '200000.00')], portfolio('u1', '1000000.00', { reserved: '200000.00' }));
    const r = executed(out.results[0]);
    expect(r.filledUnits).toBe(units('2000'));
    expect(r.rate).toBeNull();
    expect(r.position.marketValue).toBe(ils('200000.00'));
  });
});

// ---------- buys ----------

describe('buys', () => {
  it('two buys of the same stock at one event build one position', () => {
    const out = run(
      event('US', { NVDA: '150.0000' }),
      [buy('1', 'u1', 'NVDA', 'US', '100000.00'), buy('2', 'u1', 'NVDA', 'US', '50000.00')],
      portfolio('u1', '1000000.00', { reserved: '150000.00' }),
    );
    const [r1, r2] = out.results.map(executed);
    expect(r1.filledUnits).toBe(units('180.18018018'));
    expect(r2.filledUnits).toBe(units('90.09009009'));
    // Each result keeps the position as it was right after its own fill.
    expect(r1.position.units).toBe(units('180.18018018'));
    expect(r2.position.units).toBe(units('270.27027027'));
    const p = out.portfolios.get('u1')!;
    expect(p.positions).toHaveLength(1);
    expect(p.positions[0]).toMatchObject({
      id: null, openedAt: US_CLOSE, units: units('270.27027027'), costBasis: ils('150000.00'),
      avgCost: avgCost(ils('150000.00'), units('270.27027027')),
      marketValue: valueIls(units('270.27027027'), price('150.0000'), rate('3.7000')),
    });
    expect(money(p.cash)).toBe('850000.00');
    expect(out.journals.map((j) => j.journal.kind)).toEqual(['buy', 'buy']);
  });

  it('a buy into a held stock moves the average cost and keeps the id and the locked units', () => {
    const x = position('X', 'TASE', '10', '1000.00', { id: '42', reservedUnits: units('4') });
    const out = run(event('TASE', { X: '110.0000' }), [buy('1', 'u1', 'X', 'TASE', '1100.00')],
      portfolio('u1', '999000.00', { reserved: '1100.00', positions: [x] }));
    const r = executed(out.results[0]);
    expect(r.position).toMatchObject({
      id: '42', openedAt: OPENED, units: units('20'), reservedUnits: units('4'),
      costBasis: ils('2100.00'), avgCost: parse('105', SCALE.AVG_COST),
      lastPrice: price('110.0000'), marketValue: ils('2200.00'), markedAt: TASE_CLOSE,
    });
  });

  it('pays the exact ₪ amount and rounds the units down', () => {
    const out = run(event('TASE', { X: '300.0000' }), [buy('1', 'u1', 'X', 'TASE', '2000.00')],
      portfolio('u1', '1000000.00', { reserved: '2000.00' }));
    const r = executed(out.results[0]);
    expect(r.filledIls).toBe(ils('2000.00'));
    expect(r.filledUnits).toBe(units('6.66666666'));
    expect(r.position.costBasis).toBe(ils('2000.00'));
    expect(money(out.portfolios.get('u1')!.cash)).toBe('998000.00');
  });
});

// ---------- rejected buys ----------

describe('a rejected buy releases its reserved cash', () => {
  const cases: [string, EventInput, string, string, string][] = [
    // name, event, amount, reason code, reason text
    ['NO_PRICE', event('TASE', {}), '5000.00', 'NO_PRICE', REASONS.NO_PRICE],
    ['OVER_LIMIT', event('TASE', { X: '100.0000' }), '300000.00', 'OVER_LIMIT', 'ההחזקה הייתה מגיעה ל־30.0% מהתיק (מותר עד 20%)'],
    // ₪0.01 at ₪2,000,000 a unit buys 0 units (8 decimals).
    ['too small for one unit-step', event('TASE', { X: '2000000.0000' }), '0.01', 'INSUFFICIENT_CASH', REASONS.AMOUNT_TOO_SMALL],
  ];
  for (const [name, ev, amount, code, reason] of cases) {
    it(name, () => {
      const out = run(ev, [buy('1', 'u1', 'X', 'TASE', amount)],
        portfolio('u1', '1000000.00', { reserved: amount, positions: [position('Y', 'TASE', '5', '500.00')] }));
      expect(rejected(out.results[0])).toEqual({ orderId: '1', uid: 'u1', status: 'rejected', code, reason });
      const p = out.portfolios.get('u1')!;
      expect(p.reservedCash).toBe(0n);
      expect(money(p.cash)).toBe('1000000.00');
      expect(p.positions).toEqual([position('Y', 'TASE', '5', '500.00')]);
      expect(out.journals).toEqual([{ uid: 'u1', journal: releaseJournal('1', ils(amount)) }]);
      expect(out.closed).toEqual([]);
    });
  }

  it('the reasons players see are fixed Hebrew strings (D-023)', () => {
    expect(REASONS).toEqual({
      NO_PRICE: 'אין מחיר למניה בזמן הביצוע',
      INSUFFICIENT_CASH: 'אין מספיק מזומן פנוי',
      AMOUNT_TOO_SMALL: 'הסכום קטן מדי לקנייה במחיר הביצוע',
      INSUFFICIENT_UNITS: 'אין מספיק יחידות למכירה',
    });
  });

  it('an amount too small for one unit-step is INSUFFICIENT_CASH with its own reason, not "not enough cash"', () => {
    // The cash was there and reserved, so "אין מספיק מזומן פנוי" would be false. The code stays INSUFFICIENT_CASH.
    const out = run(event('TASE', { X: '2000000.0000' }), [buy('1', 'u1', 'X', 'TASE', '0.01')],
      portfolio('u1', '1000000.00', { reserved: '0.01' }));
    expect(rejected(out.results[0])).toMatchObject({ code: 'INSUFFICIENT_CASH', reason: 'הסכום קטן מדי לקנייה במחיר הביצוע' });
  });

  it('INSUFFICIENT_CASH when nothing was reserved: no journal', () => {
    const out = run(event('TASE', { X: '100.0000' }), [buy('1', 'u1', 'X', 'TASE', '100.00')], portfolio('u1', '1000000.00'));
    expect(rejected(out.results[0])).toMatchObject({ code: 'INSUFFICIENT_CASH', reason: REASONS.INSUFFICIENT_CASH });
    expect(out.journals).toEqual([]);
    expect(out.portfolios.get('u1')).toEqual(portfolio('u1', '1000000.00'));
  });

  it('INSUFFICIENT_CASH with part of it reserved releases only what is locked', () => {
    const out = run(event('TASE', { X: '100.0000' }), [buy('1', 'u1', 'X', 'TASE', '100.00')],
      portfolio('u1', '1000000.00', { reserved: '50.00' }));
    expect(rejected(out.results[0]).code).toBe('INSUFFICIENT_CASH');
    expect(out.journals.map((j) => j.journal)).toEqual([releaseJournal('1', ils('50.00'))]);
    expect(out.portfolios.get('u1')!.reservedCash).toBe(0n);
  });

  it('INSUFFICIENT_CASH when cash itself is short', () => {
    const out = run(event('TASE', { X: '100.0000' }), [buy('1', 'u1', 'X', 'TASE', '100.00')],
      portfolio('u1', '99.99', { reserved: '99.99' }));
    expect(rejected(out.results[0]).code).toBe('INSUFFICIENT_CASH');
    expect(out.portfolios.get('u1')).toEqual(portfolio('u1', '99.99'));
  });
});

// ---------- sells ----------

describe('sells', () => {
  it('partial sells keep the average cost; the last one releases the exact rest of the cost', () => {
    // 3 units for ₪1,000.00 (₪333.33333333 each), all locked by three 1-unit sells.
    const x = position('X', 'TASE', '3', '1000.00', { reservedUnits: units('3') });
    const out = run(
      event('TASE', { X: '400.0000' }),
      [sell('1', 'u1', 'X', 'TASE', '1'), sell('2', 'u1', 'X', 'TASE', '1'), sell('3', 'u1', 'X', 'TASE', '1')],
      portfolio('u1', '999000.00', { positions: [x] }),
    );
    const [a, b, c] = out.results.map(executed);
    // cost released: 1 × 333.33333333 = 333.33, twice (D-019: at average cost); then all that is left, 333.34
    expect([a, b, c].map((r) => money(r.realizedPnl))).toEqual(['66.67', '66.67', '66.66']);
    expect([a, b].map((r) => money(r.position.costBasis))).toEqual(['666.67', '333.34']);
    expect([a, b].map((r) => r.position.avgCost)).toEqual([x.avgCost, x.avgCost]);
    expect(c.position).toMatchObject({ status: 'closed', units: 0n, costBasis: 0n, realizedPnl: ils('200.00') });
    const p = out.portfolios.get('u1')!;
    expect(money(p.cash)).toBe('1000200.00');
    expect(money(p.realizedPnl)).toBe('200.00');
    expect(p.positions).toEqual([]);
    expect(out.closed).toEqual([c.position]);
  });

  it('selling everything closes the position with cost exactly 0, even when the units came at odd prices', () => {
    const bought = run(
      event('US', { NVDA: '150.0000' }),
      [buy('1', 'u1', 'NVDA', 'US', '100000.00'), buy('2', 'u1', 'NVDA', 'US', '33333.33')],
      portfolio('u1', '1000000.00', { reserved: '133333.33' }),
    );
    const p1 = bought.portfolios.get('u1')!;
    const held = p1.positions[0];
    expect(held.costBasis).toBe(ils('133333.33'));
    const p2: PortfolioState = { ...p1, positions: [{ ...held, id: '7', reservedUnits: held.units }] };
    const sold = run(event('US', { NVDA: '149.9999' }, { rate: '3.6999', at: NEXT_US_CLOSE }),
      [sell('3', 'u1', 'NVDA', 'US', format(held.units, SCALE.UNITS), NEXT_US_CLOSE)], p2);
    const r = executed(sold.results[0]);
    expect(r.position).toMatchObject({ id: '7', status: 'closed', units: 0n, reservedUnits: 0n, costBasis: 0n, closedAt: NEXT_US_CLOSE });
    expect(r.realizedPnl).toBe(r.filledIls - ils('133333.33'));
    expect(sold.portfolios.get('u1')!.positions).toEqual([]);
    expect(sold.closed).toEqual([r.position]);
  });

  it('a loss is a negative realized gain and a + line on realized_pnl', () => {
    const x = position('X', 'TASE', '10', '1000.00', { reservedUnits: units('10') });
    const out = run(event('TASE', { X: '90.0000' }), [sell('1', 'u1', 'X', 'TASE', '10')], portfolio('u1', '0', { positions: [x] }));
    expect(money(executed(out.results[0]).realizedPnl)).toBe('-100.00');
    expect(money(out.portfolios.get('u1')!.realizedPnl)).toBe('-100.00');
    expect(out.journals[0].journal.entries).toContainEqual({ account: 'realized_pnl', symbol: null, amount: ils('100.00') });
  });

  it('a dust sale worth ₪0.00 at ₪0.00 cost writes no journal but still moves the units', () => {
    const x = position('X', 'TASE', '1', '0.01', { reservedUnits: units('0.00000001') });
    const out = run(event('TASE', { X: '1.0000' }), [sell('1', 'u1', 'X', 'TASE', '0.00000001')], portfolio('u1', '100.00', { positions: [x] }));
    const r = executed(out.results[0]);
    expect([r.filledIls, r.realizedPnl]).toEqual([0n, 0n]);
    expect(out.journals).toEqual([]);
    expect(r.position).toMatchObject({ units: units('0.99999999'), reservedUnits: 0n, costBasis: ils('0.01'), status: 'open' });
  });

  it('a dust sale worth ₪0.00 that releases cost writes only the cost and loss lines', () => {
    const x = position('X', 'TASE', '1', '1000000.00', { reservedUnits: units('0.00000001') });
    const out = run(event('TASE', { X: '1.0000' }), [sell('1', 'u1', 'X', 'TASE', '0.00000001')], portfolio('u1', '100.00', { positions: [x] }));
    expect(out.journals[0].journal.entries).toEqual([
      { account: 'stock_cost', symbol: 'X', amount: ils('-0.01') },
      { account: 'realized_pnl', symbol: null, amount: ils('0.01') },
    ]);
    expect(money(out.portfolios.get('u1')!.realizedPnl)).toBe('-0.01');
  });
});

// ---------- the gain of a sale (D-019) ----------

describe('a sale releases cost at the average cost (D-019)', () => {
  // D-019: gain = units sold × (execution price × rate − average cost per unit). The proceeds and the cost
  // released are each rounded to the agora (the ledger holds agorot), and the gain is their difference.

  it('two equal partial sales give equal gains, and the average does not move', () => {
    // 3 units for ₪1.00: average ₪0.33333333. Two pending 1-unit sells at ₪1.0000.
    const t = position('T1', 'TASE', '3', '1.00', { reservedUnits: units('2') });
    const out = run(event('TASE', { T1: '1.0000' }),
      [sell('1', 'u1', 'T1', 'TASE', '1'), sell('2', 'u1', 'T1', 'TASE', '1')],
      portfolio('u1', '999999.00', { positions: [t] }));
    const [a, b] = out.results.map(executed);
    // 1 × (1.00 − 0.33333333) = 0.66666667 → 0.67, both times
    expect([a, b].map((r) => money(r.realizedPnl))).toEqual(['0.67', '0.67']);
    expect([a, b].map((r) => r.position.avgCost)).toEqual([t.avgCost, t.avgCost]);
    expect(money(b.position.costBasis)).toBe('0.34');   // what is left stays on the last unit
  });

  it('a partial sale of a cheap stock: the gain is units sold × (price − the average shown)', () => {
    // Two lots: ₪160,824.17 at 0.0170 and ₪168,459.20 at 0.0557 → 12,484,647.44851620 units for ₪329,283.37.
    const p = position('P', 'TASE', '12484647.44851620', '329283.37', { reservedUnits: units('6242323') });
    expect(format(p.avgCost, SCALE.AVG_COST)).toBe('0.02637506');
    const out = run(event('TASE', { P: '0.0500' }), [sell('1', 'u1', 'P', 'TASE', '6242323')],
      portfolio('u1', '0', { positions: [p] }));
    const s = executed(out.results[0]);
    expect(money(s.filledIls)).toBe('312116.15');
    // 6,242,323 × (0.0500 − 0.02637506) = 147,474.51 (cost released 6,242,323 × 0.02637506 = 164,641.64)
    expect(money(s.realizedPnl)).toBe('147474.51');
    expect(money(s.position.costBasis)).toBe('164641.73');
    expect(s.position.avgCost).toBe(p.avgCost);
  });

  it('rounds the proceeds and the cost to the agora separately, so the cost never depends on the sale price', () => {
    // ₪100,000.00 for 666.66666666 units at ₪150 (average ₪150.00000000); sell 16.26016260 at ₪150.0001.
    const a = position('A', 'TASE', '666.66666666', '100000.00', { reservedUnits: units('16.26016260') });
    expect(format(a.avgCost, SCALE.AVG_COST)).toBe('150.00000000');
    const out = run(event('TASE', { A: '150.0001' }), [sell('1', 'u1', 'A', 'TASE', '16.26016260')],
      portfolio('u1', '900000.00', { positions: [a] }));
    const s = executed(out.results[0]);
    // proceeds 2,439.0260… → 2,439.03; cost 16.26016260 × 150 = 2,439.02439 → 2,439.02; gain 0.01.
    // (One rounding of the whole gain would give 0.00, but then the cost released would be 2,439.03,
    // more than those units cost.)
    expect(money(s.filledIls)).toBe('2439.03');
    expect(money(s.realizedPnl)).toBe('0.01');
    expect(money(s.position.costBasis)).toBe('97560.98');
  });

  it('rounding up on earlier sales never releases more cost than is left', () => {
    // 7 units for ₪0.05: average ₪0.00714286, so each 1-unit sale releases 0.01 until the cost runs out.
    const d = position('D', 'TASE', '7', '0.05', { reservedUnits: units('7') });
    const sells = ['1', '2', '3', '4', '5', '6', '7'].map((id) => sell(id, 'u1', 'D', 'TASE', '1'));
    const out = run(event('TASE', { D: '1.0000' }), sells, portfolio('u1', '0', { positions: [d] }));
    const rs = out.results.map(executed);
    expect(rs.map((r) => money(r.realizedPnl))).toEqual(['0.99', '0.99', '0.99', '0.99', '0.99', '1.00', '1.00']);
    expect(rs.slice(0, 6).map((r) => money(r.position.costBasis))).toEqual(['0.04', '0.03', '0.02', '0.01', '0.00', '0.00']);
    expect(rs[6].position).toMatchObject({ status: 'closed', units: 0n, costBasis: 0n, realizedPnl: ils('6.95') });
    expect(money(out.portfolios.get('u1')!.realizedPnl)).toBe('6.95');   // 7.00 received − 0.05 paid
  });
});

// ---------- rejected sells ----------

describe('a rejected sell unlocks its units', () => {
  it('INSUFFICIENT_UNITS with no position: nothing changes', () => {
    const p = portfolio('u1', '1000.00');
    const out = run(event('TASE', { X: '100.0000' }), [sell('1', 'u1', 'X', 'TASE', '1')], p);
    expect(rejected(out.results[0])).toEqual({
      orderId: '1', uid: 'u1', status: 'rejected', code: 'INSUFFICIENT_UNITS', reason: REASONS.INSUFFICIENT_UNITS,
    });
    expect(out.portfolios.get('u1')).toEqual(p);
    expect(out.journals).toEqual([]);
  });

  it('INSUFFICIENT_UNITS when selling more than is held unlocks what was locked', () => {
    const x = position('X', 'TASE', '5', '500.00', { reservedUnits: units('5') });
    const out = run(event('TASE', { X: '100.0000' }), [sell('1', 'u1', 'X', 'TASE', '6')], portfolio('u1', '0', { positions: [x] }));
    expect(rejected(out.results[0]).code).toBe('INSUFFICIENT_UNITS');
    expect(out.portfolios.get('u1')!.positions).toEqual([{ ...x, reservedUnits: 0n }]);
  });

  it('INSUFFICIENT_UNITS when fewer units are locked than the order sells', () => {
    const x = position('X', 'TASE', '10', '1000.00', { reservedUnits: units('4') });
    const out = run(event('TASE', { X: '100.0000' }), [sell('1', 'u1', 'X', 'TASE', '6')], portfolio('u1', '0', { positions: [x] }));
    expect(rejected(out.results[0]).code).toBe('INSUFFICIENT_UNITS');
    expect(out.portfolios.get('u1')!.positions).toEqual([{ ...x, reservedUnits: 0n }]);
  });

  it('NO_PRICE unlocks exactly the order units and keeps the rest', () => {
    const x = position('X', 'TASE', '10', '1000.00', { reservedUnits: units('7') });
    const out = run(event('TASE', { Y: '1.0000' }), [sell('1', 'u1', 'X', 'TASE', '6')], portfolio('u1', '5.00', { positions: [x] }));
    expect(rejected(out.results[0])).toMatchObject({ code: 'NO_PRICE', reason: REASONS.NO_PRICE });
    const p = out.portfolios.get('u1')!;
    expect(p.positions).toEqual([{ ...x, reservedUnits: units('1') }]);
    expect(money(p.cash)).toBe('5.00');
    expect(out.journals).toEqual([]);
  });
});

// ---------- order of execution ----------

describe('execution order', () => {
  it("sorts by executesAt, then by numeric id: '9' runs before '10'", () => {
    const t = TASE_CLOSE;
    const early = new Date(t.getTime() - 3_600_000);
    const o = (id: string, at: Date) => buy(id, 'u1', 'X', 'TASE', '100.00', at);
    expect(sortOrders([o('10', t), o('9', t), o('100', t), o('11', t), o('500', early)]).map((x) => x.id))
      .toEqual(['500', '9', '10', '11', '100']);
  });

  it('the sorted order decides which buy hits the limit', () => {
    // Given as ['10', '9']: '9' (₪150,000) runs first and fits, so '10' (₪100,000) breaks the limit.
    const out = run(
      event('TASE', { X: '100.0000' }),
      [buy('10', 'u1', 'X', 'TASE', '100000.00'), buy('9', 'u1', 'X', 'TASE', '150000.00')],
      portfolio('u1', '1000000.00', { reserved: '250000.00' }),
    );
    expect(out.results.map((r) => [r.orderId, r.status])).toEqual([['9', 'executed'], ['10', 'rejected']]);
    expect(rejected(out.results[1]).reason).toBe('ההחזקה הייתה מגיעה ל־25.0% מהתיק (מותר עד 20%)');
  });

  it('a buy and then a sell of the same stock at one event', () => {
    const x = position('X', 'TASE', '10', '1000.00', { id: '42', reservedUnits: units('10') });
    const out = run(
      event('TASE', { X: '110.0000' }),
      [buy('1', 'u1', 'X', 'TASE', '1100.00'), sell('2', 'u1', 'X', 'TASE', '10')],
      portfolio('u1', '998900.00', { reserved: '1100.00', positions: [x] }),
    );
    const [b, s] = out.results.map(executed);
    expect(b.position).toMatchObject({ units: units('20'), costBasis: ils('2100.00'), avgCost: parse('105', SCALE.AVG_COST) });
    // The sale releases 10 units at the new average: 10 × 105 = 1,050, so the gain is 1,100 − 1,050 = 50.
    expect(money(s.realizedPnl)).toBe('50.00');
    expect(s.position).toMatchObject({
      id: '42', status: 'open', units: units('10'), reservedUnits: 0n, costBasis: ils('1050.00'), avgCost: parse('105', SCALE.AVG_COST),
    });
    expect(money(out.portfolios.get('u1')!.cash)).toBe('998900.00');
  });

  it('a sell that closes a position and then a buy of it at one event opens a new position', () => {
    const x = position('X', 'TASE', '10', '1000.00', { id: '42', reservedUnits: units('10') });
    const out = run(
      event('TASE', { X: '110.0000' }),
      [sell('1', 'u1', 'X', 'TASE', '10'), buy('2', 'u1', 'X', 'TASE', '550.00')],
      portfolio('u1', '998900.00', { reserved: '550.00', positions: [x] }),
    );
    const [s, b] = out.results.map(executed);
    expect(s.position).toMatchObject({ id: '42', status: 'closed', costBasis: 0n, realizedPnl: ils('100.00') });
    expect(b.position).toMatchObject({ id: null, status: 'open', openedAt: TASE_CLOSE, units: units('5'), costBasis: ils('550.00'), realizedPnl: 0n });
    expect(out.closed).toEqual([s.position]);
    expect(out.portfolios.get('u1')!.positions).toEqual([b.position]);
  });

  it('keeps players apart and leaves out portfolios without orders', () => {
    const out = executeOrders(
      event('TASE', { X: '100.0000' }),
      [buy('2', 'u2', 'X', 'TASE', '1000.00'), buy('1', 'u1', 'X', 'TASE', '1000.00')],
      new Map([
        ['u1', portfolio('u1', '1000000.00', { reserved: '1000.00' })],
        ['u2', portfolio('u2', '4999.99', { reserved: '1000.00' })],
        ['u3', portfolio('u3', '7.00')],
      ]),
    );
    expect([...out.portfolios.keys()].sort()).toEqual(['u1', 'u2']);
    // u2: ₪1,000 is just over 20% of ₪4,999.99
    expect(out.results.map((r) => [r.uid, r.status])).toEqual([['u1', 'executed'], ['u2', 'rejected']]);
    expect(out.journals.map((j) => [j.uid, j.journal.kind])).toEqual([['u1', 'buy'], ['u2', 'release']]);
  });
});

// ---------- bad input ----------

describe('programming errors throw instead of rejecting', () => {
  const p = () => new Map([['u1', portfolio('u1', '1000000.00', { reserved: '1000.00', positions: [position('X', 'TASE', '1', '100.00', { reservedUnits: units('1') })] })]]);
  const ev = event('TASE', { X: '100.0000' });
  const bad: [string, () => unknown][] = [
    ['an order for the other market', () => executeOrders(ev, [buy('1', 'u1', 'NVDA', 'US', '1000.00')], p())],
    ['a buy with units', () => executeOrders(ev, [{ ...buy('1', 'u1', 'X', 'TASE', '1000.00'), units: 1n }], p())],
    ['a buy without an amount', () => executeOrders(ev, [{ ...buy('1', 'u1', 'X', 'TASE', '1000.00'), amountIls: null }], p())],
    ['a sell with an amount', () => executeOrders(ev, [{ ...sell('1', 'u1', 'X', 'TASE', '1'), amountIls: 1n }], p())],
    ['a sell without units', () => executeOrders(ev, [{ ...sell('1', 'u1', 'X', 'TASE', '1'), units: null }], p())],
    ['a zero amount', () => executeOrders(ev, [buy('1', 'u1', 'X', 'TASE', '0')], p())],
    ['a negative amount', () => executeOrders(ev, [buy('1', 'u1', 'X', 'TASE', '-1.00')], p())],
    ['zero units', () => executeOrders(ev, [sell('1', 'u1', 'X', 'TASE', '0')], p())],
    ['negative units', () => executeOrders(ev, [sell('1', 'u1', 'X', 'TASE', '-1')], p())],
    ['a missing portfolio', () => executeOrders(ev, [buy('1', 'u2', 'X', 'TASE', '1000.00')], p())],
    ['the same order twice', () => executeOrders(ev, [buy('1', 'u1', 'X', 'TASE', '500.00'), buy('1', 'u1', 'X', 'TASE', '500.00')], p())],
    ['a non-numeric id', () => executeOrders(ev, [buy('abc', 'u1', 'X', 'TASE', '1000.00')], p())],
    ['a US event without a rate', () => executeOrders({ ...event('US', { NVDA: '1.0000' }), rate: 0n }, [], new Map())],
    ['a zero price', () => executeOrders(event('TASE', { X: '0' }), [], new Map())],
    ['a portfolio with reserved cash above its cash', () =>
      executeOrders(ev, [buy('1', 'u1', 'X', 'TASE', '1000.00')], new Map([['u1', portfolio('u1', '10.00', { reserved: '20.00' })]]))],
    ['a position with more units locked than held', () =>
      executeOrders(ev, [sell('1', 'u1', 'X', 'TASE', '1')],
        new Map([['u1', portfolio('u1', '0', { positions: [position('X', 'TASE', '1', '1.00', { reservedUnits: units('2') })] })]]))],
    // A sale releases units × average cost, so a negative average would add cost instead.
    ['a position with a negative average cost', () =>
      executeOrders(ev, [sell('1', 'u1', 'X', 'TASE', '1')],
        new Map([['u1', portfolio('u1', '0', { positions: [position('X', 'TASE', '2', '1.00', { reservedUnits: units('1'), avgCost: -1n })] })]]))],
  ];
  for (const [name, call] of bad) {
    it(name, () => expect(call).toThrow());
  }
});

// ---------- immutability ----------

describe('inputs are never changed', () => {
  it('leaves the event, the orders and the portfolios exactly as they were', () => {
    const ev = event('TASE', { X: '110.0000', Y: '50.0000' });
    const orders = [
      sell('4', 'u1', 'X', 'TASE', '10'),
      buy('3', 'u1', 'Y', 'TASE', '1000.00'),
      buy('2', 'u2', 'X', 'TASE', '900000.00'),
      sell('1', 'u2', 'Y', 'TASE', '3'),
    ];
    const portfolios = new Map([
      ['u1', portfolio('u1', '998900.00', { reserved: '1000.00', positions: [position('X', 'TASE', '10', '1000.00', { reservedUnits: units('10') })] })],
      ['u2', portfolio('u2', '1000000.00', { reserved: '900000.00', positions: [position('Y', 'TASE', '5', '250.00', { reservedUnits: units('3') })] })],
    ]);
    const snapshot = structuredClone({ ev, orders, portfolios });
    const out = run(ev, orders, ...portfolios.values());
    executeOrders(ev, orders, portfolios);
    expect({ ev, orders, portfolios }).toEqual(snapshot);
    expect(orders.map((o) => o.id)).toEqual(['4', '3', '2', '1']);
    // The output never shares objects with the input.
    for (const [uid, after] of out.portfolios) {
      expect(after).not.toBe(portfolios.get(uid));
      for (const x of after.positions) expect(portfolios.get(uid)!.positions).not.toContain(x);
    }
  });
});

// ---------- random batches ----------

// A small seeded generator, so a failure always reproduces.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('random batches keep the books exact', () => {
  it('300 random events: balanced journals, ledger = state, no money created, DB invariants hold', () => {
    const r = rng(20261109);
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    const big = (lo: number, hi: number) => BigInt(int(lo, hi));
    const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
    const seen = new Map<string, number>();
    const symbols = ['A', 'B', 'C', 'D'];

    for (let round = 0; round < 300; round++) {
      const market: Market = r() < 0.5 ? 'TASE' : 'US';
      const other: Market = market === 'TASE' ? 'US' : 'TASE';
      const prices = new Map<string, bigint>();
      for (const s of symbols) if (r() < 0.85) prices.set(s, big(10_000, 10_000_000));   // ₪/$1 to 1,000
      const at = new Date(Date.UTC(2026, 10, 2 + int(0, 20), 15, 30));
      const ev: EventInput = { market, kind: r() < 0.5 ? 'open' : 'close', at, prices, rate: big(30_000, 40_000) };

      const portfolios: PortfolioState[] = [];
      const orders: DueOrder[] = [];
      let id = int(1, 1000);
      for (let k = 0, players = int(1, 3); k < players; k++) {
        const uid = `u${k}`;
        const cash = big(10_000_000, 200_000_000);                 // ₪100,000 to ₪2,000,000
        let reserved = 0n;
        const positions: PositionState[] = [];
        for (const s of [...symbols, 'Z']) {
          if (r() < 0.5) continue;
          const u = big(1, 500_000_000_000);                       // up to 5,000 units
          const cost = big(1, 50_000_000);                         // up to ₪500,000
          const marked = r() < 0.7;
          positions.push({
            id: String(int(1, 10_000)), symbol: s, market: s === 'Z' ? other : market, status: 'open',
            units: u, reservedUnits: 0n, costBasis: cost, avgCost: avgCost(cost, u), realizedPnl: big(-1_000_000, 1_000_000),
            lastPrice: null, lastRate: null, marketValue: marked ? big(0, 60_000_000) : null, markedAt: null,
            openedAt: OPENED, closedAt: null,
          });
        }
        for (let i = 0, n = int(0, 6); i < n; i++) {
          id += int(1, 20);
          const executesAt = new Date(at.getTime() - int(0, 2) * 3_600_000);
          const held = positions.filter((x) => x.market === market && x.reservedUnits < x.units);
          if (r() < 0.55 || held.length === 0) {
            const amount = big(1, 30_000_000);                     // up to ₪300,000, including dust
            if (r() < 0.9 && cash - reserved >= amount) reserved += amount;   // sometimes not reserved
            orders.push({ id: String(id), uid, symbol: pick(symbols), market, side: 'buy', amountIls: amount, units: null, executesAt });
          } else if (r() < 0.1) {
            // A stock not held, or more units than are free: never reserved.
            orders.push({ id: String(id), uid, symbol: pick(symbols), market, side: 'sell', amountIls: null, units: big(1, 600_000_000_000), executesAt });
          } else {
            // Lock the units as sending the order would: all the free units, or some of them.
            const x = pick(held);
            const free = x.units - x.reservedUnits;
            const u = r() < 0.3 ? free : BigInt(1 + Math.floor(r() * Number(free)));
            positions[positions.indexOf(x)] = { ...x, reservedUnits: x.reservedUnits + u };
            orders.push({ id: String(id), uid, symbol: x.symbol, market, side: 'sell', amountIls: null, units: u, executesAt });
          }
        }
        portfolios.push({ uid, cash, reservedCash: reserved, realizedPnl: big(-5_000_000, 5_000_000), positions });
      }

      const out = run(ev, orders, ...portfolios);
      expect(out.results).toHaveLength(orders.length);
      for (const res of out.results) {
        const key = res.status === 'executed' ? `executed ${res.side}` : res.code;
        seen.set(key, (seen.get(key) ?? 0) + 1);
        if (res.status === 'executed' && res.side === 'buy') {
          const o = orders.find((x) => x.id === res.orderId)!;
          expect(res.filledIls).toBe(o.amountIls);
          expect(res.filledUnits).toBe(unitsFor(o.amountIls!, res.fillPrice, market === 'US' ? ev.rate : 10_000n));
        }
      }
    }
    // The random batches must reach every path, or they prove little.
    for (const key of ['executed buy', 'executed sell', 'NO_PRICE', 'INSUFFICIENT_CASH', 'OVER_LIMIT', 'INSUFFICIENT_UNITS']) {
      expect(seen.get(key) ?? 0, key).toBeGreaterThan(5);
    }
  });
});
