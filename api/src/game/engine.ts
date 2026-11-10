// Executes the orders due at ONE market event (an open or a close), as a pure function (D-018, D-019, D-020).
// In: the event's prices, the due orders and the current state of every portfolio that has one.
// Out: a result per order, the journals to write and the new state. Nothing here touches the database:
// the runner loads the state, calls executeOrders, and writes what comes back in one transaction (D-021).
// Inputs are never mutated; every change makes a new object.

import { avgCost, bigMin, costAtAvg, format, pct, RATE_ONE, unitsFor, valueIls } from './fixed.js';
import { buyJournal, type Journal, releaseJournal, sellJournal } from './ledger.js';
import type { Market } from './marketHours.js';

export type PositionState = {
  id: string | null;            // DB id; null = opened in this run
  symbol: string;
  market: Market;
  status: 'open' | 'closed';
  units: bigint;                // UNITS
  reservedUnits: bigint;        // UNITS locked by pending sells
  costBasis: bigint;            // ILS: ₪ paid for the units still held
  avgCost: bigint;              // AVG_COST
  realizedPnl: bigint;          // ILS, this position's realized gain (+ = gain)
  lastPrice: bigint | null;     // the mark: PRICE in the security's currency
  lastRate: bigint | null;      // USD/ILS of the mark; null for TASE (like positions.last_fx)
  marketValue: bigint | null;   // ILS
  markedAt: Date | null;
  openedAt: Date | null;
  closedAt: Date | null;
};

export type PortfolioState = {
  uid: string;
  cash: bigint;                 // ILS, includes reserved cash
  reservedCash: bigint;         // ILS locked by pending buys
  realizedPnl: bigint;          // ILS, total (+ = gain)
  positions: PositionState[];   // OPEN positions only, at most one per symbol
};

export type DueOrder = {
  id: string;                   // bigint id as a string; execution order = (executesAt, BigInt(id))
  uid: string;
  symbol: string;
  market: Market;
  side: 'buy' | 'sell';
  amountIls: bigint | null;     // buys only
  units: bigint | null;         // sells only
  executesAt: Date;
};

export type EventInput = {
  market: Market;
  kind: 'open' | 'close';
  at: Date;
  prices: Map<string, bigint>;  // this event's open or close per symbol of THIS market; missing = no price
  rate: bigint;                 // USD/ILS for this event (US); ignored for TASE
};

export type RejectCode = 'NO_PRICE' | 'INSUFFICIENT_CASH' | 'OVER_LIMIT' | 'INSUFFICIENT_UNITS';

export type OrderResult =
  | {
      orderId: string; uid: string; status: 'executed'; side: 'buy' | 'sell'; symbol: string;
      fillPrice: bigint; rate: bigint | null;                 // rate null for TASE
      filledUnits: bigint; filledIls: bigint; realizedPnl: bigint | null;   // realizedPnl null for buys
      position: PositionState;                                // the position after the fill (may be closed)
    }
  | { orderId: string; uid: string; status: 'rejected'; code: RejectCode; reason: string };

export type ExecuteResult = {
  results: OrderResult[];                     // one per order, in execution order
  journals: { uid: string; journal: Journal }[];
  portfolios: Map<string, PortfolioState>;    // new state of every portfolio that had an order
  closed: PositionState[];                    // positions closed in this run (status 'closed')
};

// The brief's rule 4: one holding may be at most 20% of the portfolio when it is bought.
export const LIMIT_PCT = 20n;

// Shown to players in a toast (D-023).
export const REASONS = {
  NO_PRICE: 'אין מחיר למניה בזמן הביצוע',
  INSUFFICIENT_CASH: 'אין מספיק מזומן פנוי',
  AMOUNT_TOO_SMALL: 'הסכום קטן מדי לקנייה במחיר הביצוע',
  INSUFFICIENT_UNITS: 'אין מספיק יחידות למכירה',
} as const;

// "Would be 21.3% of the portfolio (allowed up to 20%)". One decimal, rounded once from the exact ratio
// (rounding to PCT first and then to one decimal would turn 21.34995% into 21.4). A breach can be as small as
// one agora, which rounds to "20.0%"; anything up to 20.0 shows as 20.1% so a rejection never reads as allowed.
export function overLimitReason(part: bigint, whole: bigint): string {
  const limitTenths = LIMIT_PCT * 10n;
  let tenths = whole > 0n ? pct(part, whole, 1) : limitTenths + 1n;
  if (tenths <= limitTenths) tenths = limitTenths + 1n;
  return `ההחזקה הייתה מגיעה ל־${format(tenths, 1)}% מהתיק (מותר עד ${LIMIT_PCT}%)`;
}

// TASE prices are already in ₪.
export function rateFor(market: Market, eventRate: bigint): bigint {
  return market === 'US' ? eventRate : RATE_ONE;
}

// The position valued at a price. `rate` is the effective rate (RATE_ONE for TASE); TASE stores no rate.
export function markPosition(p: PositionState, price: bigint, rate: bigint, at: Date): PositionState {
  return {
    ...p,
    lastPrice: price,
    lastRate: p.market === 'US' ? rate : null,
    marketValue: valueIls(p.units, price, rate),
    markedAt: at,
  };
}

type Ctx = { event: EventInput; rate: bigint };
type Step = { portfolio: PortfolioState; result: OrderResult; journals: Journal[]; closed: PositionState | null };

export function executeOrders(
  event: EventInput,
  orders: DueOrder[],
  portfolios: Map<string, PortfolioState>,
): ExecuteResult {
  checkEvent(event);
  checkOrders(event, orders, portfolios);
  const ctx: Ctx = { event, rate: rateFor(event.market, event.rate) };

  // Our own copies: the caller's objects stay as they were, even for a portfolio whose orders change nothing.
  const state = new Map<string, PortfolioState>();
  for (const o of orders) if (!state.has(o.uid)) state.set(o.uid, copyPortfolio(portfolios.get(o.uid)!));

  const out: ExecuteResult = { results: [], journals: [], portfolios: state, closed: [] };
  for (const order of sortOrders(orders)) {
    const before = state.get(order.uid)!;
    const step = order.side === 'buy' ? executeBuy(ctx, before, order) : executeSell(ctx, before, order);
    // State carries over: the next order of this player sees this one's cash and holding.
    state.set(order.uid, step.portfolio);
    out.results.push(step.result);
    for (const journal of step.journals) out.journals.push({ uid: order.uid, journal });
    if (step.closed) out.closed.push(step.closed);
  }
  return out;
}

// Orders run in the order they were sent: by executesAt, then by numeric id ('9' before '10').
export function sortOrders(orders: readonly DueOrder[]): DueOrder[] {
  return [...orders].sort((a, b) => {
    const t = a.executesAt.getTime() - b.executesAt.getTime();
    if (t !== 0) return t;
    const x = BigInt(a.id);
    const y = BigInt(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

// ---------- buy ----------

// A buy of ₪A. The cash was reserved when the order was sent; every rejection gives it back.
function executeBuy(ctx: Ctx, p: PortfolioState, order: DueOrder): Step {
  const amount = order.amountIls!;
  const reject = (code: RejectCode, reason: string): Step => {
    const release = bigMin(amount, p.reservedCash);   // never more than is actually locked
    return {
      portfolio: release > 0n ? { ...p, reservedCash: p.reservedCash - release } : p,
      journals: release > 0n ? [releaseJournal(order.id, release)] : [],
      result: { orderId: order.id, uid: order.uid, status: 'rejected', code, reason },
      closed: null,
    };
  };

  const price = ctx.event.prices.get(order.symbol);
  if (price === undefined) return reject('NO_PRICE', REASONS.NO_PRICE);
  // Can't happen if the order was reserved when sent; checked so a bad row can never spend cash twice.
  if (p.reservedCash < amount || p.cash < amount) return reject('INSUFFICIENT_CASH', REASONS.INSUFFICIENT_CASH);

  // The 20% limit, again, at the execution price (D-020). Exact bigint comparison, no rounding.
  const held = findPosition(p, order.symbol);
  const holding = held ? valueIls(held.units, price, ctx.rate) : 0n;
  const total = portfolioValue(ctx, p);
  if ((holding + amount) * 100n > LIMIT_PCT * total) {
    return reject('OVER_LIMIT', overLimitReason(holding + amount, total));
  }

  const units = unitsFor(amount, price, ctx.rate);
  if (units === 0n) return reject('INSUFFICIENT_CASH', REASONS.AMOUNT_TOO_SMALL);

  const base = held ?? openPosition(order, ctx.event.at);
  const newUnits = base.units + units;
  const newCost = base.costBasis + amount;
  const position = markPosition(
    { ...base, units: newUnits, costBasis: newCost, avgCost: avgCost(newCost, newUnits) },
    price, ctx.rate, ctx.event.at,
  );
  return {
    portfolio: {
      ...p,
      cash: p.cash - amount,
      reservedCash: p.reservedCash - amount,
      positions: putPosition(p.positions, position),
    },
    journals: [buyJournal(order.id, order.symbol, amount)],
    result: {
      orderId: order.id, uid: order.uid, status: 'executed', side: 'buy', symbol: order.symbol,
      fillPrice: price, rate: reportedRate(ctx), filledUnits: units, filledIls: amount, realizedPnl: null, position,
    },
    closed: null,
  };
}

// Portfolio value right now: all cash (reserved cash too) plus every open position. This market's positions
// are at this event's price; the other market's at their last mark, since their price hasn't changed (D-024).
function portfolioValue(ctx: Ctx, p: PortfolioState): bigint {
  let total = p.cash;
  for (const pos of p.positions) {
    const price = pos.market === ctx.event.market ? ctx.event.prices.get(pos.symbol) : undefined;
    total += price !== undefined ? valueIls(pos.units, price, ctx.rate) : (pos.marketValue ?? pos.costBasis);
  }
  return total;
}

function openPosition(order: DueOrder, at: Date): PositionState {
  return {
    id: null, symbol: order.symbol, market: order.market, status: 'open',
    units: 0n, reservedUnits: 0n, costBasis: 0n, avgCost: 0n, realizedPnl: 0n,
    lastPrice: null, lastRate: null, marketValue: null, markedAt: null,
    openedAt: at, closedAt: null,
  };
}

// ---------- sell ----------

// A sell of U units. The units were reserved when the order was sent; every rejection unlocks them.
function executeSell(ctx: Ctx, p: PortfolioState, order: DueOrder): Step {
  const sold = order.units!;
  const held = findPosition(p, order.symbol);
  const reject = (code: RejectCode, reason: string, unlock: bigint): Step => ({
    portfolio: held && unlock > 0n
      ? { ...p, positions: putPosition(p.positions, { ...held, reservedUnits: held.reservedUnits - unlock }) }
      : p,
    journals: [],
    result: { orderId: order.id, uid: order.uid, status: 'rejected', code, reason },
    closed: null,
  });

  if (!held || held.units < sold || held.reservedUnits < sold) {
    return reject('INSUFFICIENT_UNITS', REASONS.INSUFFICIENT_UNITS, held ? bigMin(sold, held.reservedUnits) : 0n);
  }
  const price = ctx.event.prices.get(order.symbol);
  if (price === undefined) return reject('NO_PRICE', REASONS.NO_PRICE, sold);

  const proceeds = valueIls(sold, price, ctx.rate);
  // D-019: gain = units sold × (price × rate − average cost), each ₪ side rounded to the agora. So two equal
  // sales give equal gains, and a player can check it with the average shown on screen. Selling everything
  // releases the whole remaining cost, so a closed position keeps no agora of rounding; and rounding up on
  // earlier sales can never release more cost than is left.
  const costReleased = sold === held.units
    ? held.costBasis
    : bigMin(costAtAvg(sold, held.avgCost), held.costBasis);
  const gain = proceeds - costReleased;
  const journal = sellJournal(order.id, order.symbol, proceeds, costReleased);

  // A sale never changes the average cost (D-019), so avgCost is carried over untouched.
  let position = markPosition(
    {
      ...held,
      units: held.units - sold,
      reservedUnits: held.reservedUnits - sold,
      costBasis: held.costBasis - costReleased,
      realizedPnl: held.realizedPnl + gain,
    },
    price, ctx.rate, ctx.event.at,
  );
  let positions: PositionState[];
  let closed: PositionState | null = null;
  if (position.units === 0n) {
    if (position.costBasis !== 0n || position.reservedUnits !== 0n) {
      throw new Error(`closing ${order.symbol} for ${order.uid} left cost ${position.costBasis} or reserved ${position.reservedUnits}`);
    }
    position = { ...position, status: 'closed', closedAt: ctx.event.at };
    positions = p.positions.filter((x) => x.symbol !== order.symbol);
    closed = position;
  } else {
    positions = putPosition(p.positions, position);
  }

  return {
    portfolio: { ...p, cash: p.cash + proceeds, realizedPnl: p.realizedPnl + gain, positions },
    journals: journal ? [journal] : [],
    result: {
      orderId: order.id, uid: order.uid, status: 'executed', side: 'sell', symbol: order.symbol,
      fillPrice: price, rate: reportedRate(ctx), filledUnits: sold, filledIls: proceeds, realizedPnl: gain, position,
    },
    closed,
  };
}

// ---------- helpers ----------

function reportedRate(ctx: Ctx): bigint | null {
  return ctx.event.market === 'US' ? ctx.rate : null;
}

function findPosition(p: PortfolioState, symbol: string): PositionState | undefined {
  return p.positions.find((x) => x.symbol === symbol);
}

// Replaces the open position of the same symbol, or adds it.
function putPosition(positions: readonly PositionState[], next: PositionState): PositionState[] {
  const i = positions.findIndex((x) => x.symbol === next.symbol);
  return i < 0 ? [...positions, next] : positions.map((x, j) => (j === i ? next : x));
}

function copyPortfolio(p: PortfolioState): PortfolioState {
  return { ...p, positions: p.positions.map((x) => ({ ...x })) };
}

// ---------- input checks ----------
// These are programming errors, not player mistakes: a bad input throws and stops the event,
// instead of quietly writing wrong money.

function checkEvent(event: EventInput): void {
  if (event.market !== 'TASE' && event.market !== 'US') throw new Error(`unknown market ${String(event.market)}`);
  if (!(event.at instanceof Date) || Number.isNaN(event.at.getTime())) throw new Error('event.at is not a valid date');
  if (event.market === 'US' && !(typeof event.rate === 'bigint' && event.rate > 0n)) {
    throw new Error(`US event needs a positive USD/ILS rate, got ${event.rate}`);
  }
  for (const [symbol, price] of event.prices) {
    if (typeof price !== 'bigint' || price <= 0n) throw new Error(`bad price for ${symbol}: ${price}`);
  }
}

function checkOrders(event: EventInput, orders: readonly DueOrder[], portfolios: Map<string, PortfolioState>): void {
  const ids = new Set<string>();
  const checked = new Set<string>();
  for (const o of orders) {
    if (typeof o.id !== 'string' || !/^\d+$/.test(o.id)) throw new Error(`order id must be a decimal string, got ${o.id}`);
    // A duplicate would run the same order twice.
    if (ids.has(o.id)) throw new Error(`order ${o.id} appears twice`);
    ids.add(o.id);
    if (o.market !== event.market) throw new Error(`order ${o.id} is for ${o.market}, the event is ${event.market}`);
    if (!(o.executesAt instanceof Date) || Number.isNaN(o.executesAt.getTime())) {
      throw new Error(`order ${o.id} has no valid executesAt`);
    }
    if (o.side === 'buy') {
      if (o.units !== null || typeof o.amountIls !== 'bigint' || o.amountIls <= 0n) {
        throw new Error(`buy order ${o.id} needs a positive amountIls and no units`);
      }
    } else if (o.side === 'sell') {
      if (o.amountIls !== null || typeof o.units !== 'bigint' || o.units <= 0n) {
        throw new Error(`sell order ${o.id} needs positive units and no amountIls`);
      }
    } else {
      throw new Error(`order ${o.id} has unknown side ${String(o.side)}`);
    }
    const p = portfolios.get(o.uid);
    if (!p) throw new Error(`no portfolio for ${o.uid} (order ${o.id})`);
    if (!checked.has(o.uid)) {
      checkPortfolio(o.uid, p);
      checked.add(o.uid);
    }
    const pos = p.positions.find((x) => x.symbol === o.symbol);
    if (pos && pos.market !== o.market) throw new Error(`order ${o.id}: ${o.symbol} is held as ${pos.market}`);
  }
}

// The same invariants as the database CHECKs; a state that breaks them would make the math below wrong.
function checkPortfolio(uid: string, p: PortfolioState): void {
  if (p.uid !== uid) throw new Error(`portfolio under ${uid} belongs to ${p.uid}`);
  if (p.reservedCash < 0n || p.reservedCash > p.cash) throw new Error(`${uid}: reserved cash ${p.reservedCash} outside 0..${p.cash}`);
  const symbols = new Set<string>();
  for (const pos of p.positions) {
    if (pos.status !== 'open') throw new Error(`${uid}: ${pos.symbol} is not open`);
    if (symbols.has(pos.symbol)) throw new Error(`${uid}: two open positions in ${pos.symbol}`);
    symbols.add(pos.symbol);
    if (pos.units <= 0n || pos.reservedUnits < 0n || pos.reservedUnits > pos.units || pos.costBasis < 0n || pos.avgCost < 0n) {
      throw new Error(`${uid}: ${pos.symbol} has units ${pos.units}, reserved ${pos.reservedUnits}, cost ${pos.costBasis}, avg ${pos.avgCost}`);
    }
  }
}
