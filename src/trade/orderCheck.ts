// The order rules, checked in the app BEFORE sending, for the live preview (brief, rules 4–5): no leverage
// (enough available cash), no short selling (enough free units), one security ≤ 20% of the portfolio at the
// moment of buying, and ₪100 at least. Pure: no React, no network, no imports (api/test/app-trade.test.ts
// loads this file under the API's own type check).
//
// It mirrors what POST /me/orders checks when an order is sent (api/src/game/orderRules.ts, D-028), so the
// preview and the server agree. It is a first gate for a friendly preview, not the last: the server checks
// everything again, and the runner again at the execution price (D-020).

export const CAP = 0.2;            // one security ≤ 20% of the portfolio when buying
export const MIN_ORDER_ILS = 100;  // smaller orders are noise (D-014)
export const MAX_DIGITS = 7;       // ₪9,999,999 is more than anyone can have

const CAP_PCT = 20;                // CAP as a whole percent, for the exact comparison in agorot
const UNIT = 1e8;                  // units have 8 decimals (D-018)

// GET /me/trade sends at most this many pending orders (PENDING_LIMIT in api/src/trade.ts), the ones that run
// first. A full list may be cut, so pending buys added up from it can be short of what the server counts.
export const PENDING_LIST_MAX = 50;

export type Side = 'buy' | 'sell';

// The player's holding in the security, as GET /me/trade sends it (SecurityView.holding).
export type HoldingInput = { units: number; freeUnits: number; valueIls: number } | null;

export type CheckInput = {
  side: Side;
  amount: number;          // ₪ typed by the player
  availableCash: number;   // cash − cash locked by pending buys: what a new buy can spend
  totalValue: number;      // the stored equity, reserved cash included (the 20% is of this)
  holding: HoldingInput;
  pendingBuysIls: number;  // this player's pending buys of the same security (they count toward 20%, D-028)
  pendingCut: boolean;     // the pending list may be cut (pendingListCut): pendingBuysIls may be too low
  priceIls: number | null; // latest known price in ₪ (US converted at today's rate), null = no price yet
  gameOver: boolean;       // the order would run after the end of the price history (ExecutionView.gameOver)
};

export type CheckStatus =
  | 'empty' | 'ok' | 'gameOver' | 'noPrice' | 'noCash' | 'overCap' | 'nothingToSell' | 'locked' | 'overHolding' | 'belowMin';

// What a ₪ sell becomes (D-018): the units sent, as a decimal string with 8 decimals.
export type SellPlan = {
  units: string;           // '2.50000000': never 0, never more than the free units, never a float's tail
  all: boolean;            // every free unit (then the ₪100 minimum doesn't apply, D-028)
  valueIls: number;        // those units at the last mark
};

export type Check = {
  ok: boolean;
  status: CheckStatus;
  units: number;           // buy: estimated at the latest price; sell: exactly the units that will be sent
  cashAfter: number;       // available cash after (a sell's cash is an estimate: it arrives at execution)
  weightAfterPct: number;  // this security's weight after the order (and the pending buys), %
  maxIls: number;          // the most this order may be, in whole ₪ (what the amount field can hold): cash and
                           // cap room rounded DOWN (buy), the free units' value as shown (sell)
  leftIls: number;         // cap room left after a buy (whole ₪, rounded down), or holding left after a sell
  capExact: boolean;       // false = the pending list was cut, so the cap room is an upper bound (buy only)
  sell: SellPlan | null;   // what a sell sends; null for a buy or when there is nothing to sell
};

const agorot = (ils: number) => Math.round(ils * 100);

// The free units' value at the last mark (the holding's value per unit × free units).
function freeValueIls(h: HoldingInput): number {
  if (!h || !(h.units > 0) || !(h.freeUnits > 0)) return 0;
  return Math.max(0, h.valueIls) * (h.freeUnits / h.units);
}

// The free units' value in whole ₪, as the screen shows it and the amount field can hold it: the most a sell
// may be, and the amount that sells everything. At least ₪1 while any unit is free, so a holding worth
// under ₪1 can still be closed.
export function shownFreeIls(h: HoldingInput): number {
  if (!h || !(h.units > 0) || !(h.freeUnits > 0)) return 0;
  return Math.max(1, Math.round(freeValueIls(h)));
}

// The units a ₪ sell sends. Reaching the free value as shown sells every free unit, exactly (freeUnits
// with 8 decimals); less is ₪ ÷ value per unit, rounded DOWN to 8 decimals. null = nothing to sell.
export function sellPlan(amount: number, h: HoldingInput): SellPlan | null {
  if (!h || !(amount > 0) || !(h.units > 0)) return null;
  const free = Math.round(h.freeUnits * UNIT);   // the stored NUMERIC has 8 decimals: this recovers it exactly
  if (!(free > 0)) return null;
  if (amount >= shownFreeIls(h) || !(h.valueIls > 0)) return { units: unitsText(free), all: true, valueIls: freeValueIls(h) };
  const want = Math.max(1, Math.floor((amount * h.units * UNIT) / h.valueIls));
  const scaled = Math.min(free, want);
  return { units: unitsText(scaled), all: scaled === free, valueIls: (scaled * h.valueIls) / h.units / UNIT };
}

// 250000000 → '2.50000000'.
function unitsText(scaled: number): string {
  const s = String(scaled).padStart(9, '0');
  return `${s.slice(0, -8)}.${s.slice(-8)}`;
}

// This player's pending buys of one security, ₪ (TradeView.pendingOrders), added up in whole agorot.
export function pendingBuysIls(orders: { symbol: string; side: Side; amountIls: number | null }[], symbol: string): number {
  let sum = 0;
  for (const o of orders) if (o.symbol === symbol && o.side === 'buy' && o.amountIls !== null) sum += agorot(o.amountIls);
  return sum / 100;
}

// A full pending list (PENDING_LIST_MAX) may have been cut by the API.
export function pendingListCut(orders: readonly unknown[]): boolean {
  return orders.length >= PENDING_LIST_MAX;
}

// How much cash a buy is short by, exact to the agora (never "₪0" for a few agorot).
export function shortfallIls(amount: number, availableCash: number): number {
  return Math.max(0, agorot(amount) - agorot(availableCash)) / 100;
}

export function checkOrder(input: CheckInput): Check {
  return input.side === 'buy' ? checkBuy(input) : checkSell(input);
}

function checkBuy({ amount, availableCash, totalValue, holding, pendingBuysIls: pending, pendingCut, priceIls, gameOver }: CheckInput): Check {
  const held = holding?.valueIls ?? 0;
  // Exact, in whole agorot, the way the server compares: (holding + pending buys + this buy) × 100 ≤ 20 × equity.
  const capA = Math.floor((CAP_PCT * agorot(totalValue)) / 100);
  const roomA = capA - agorot(held) - agorot(pending);
  const over = (agorot(held) + agorot(pending) + agorot(amount)) * 100 > CAP_PCT * agorot(totalValue);

  const r = {
    units: priceIls ? amount / priceIls : 0,
    cashAfter: availableCash - amount,
    weightAfterPct: totalValue > 0 ? ((held + pending + amount) / totalValue) * 100 : 0,
    // Limits are shown and offered in whole ₪, rounded DOWN, so the screen never offers an agora too many.
    maxIls: wholeIls(Math.min(agorot(availableCash), roomA)),
    leftIls: wholeIls(roomA - agorot(amount)),
    capExact: !pendingCut,
    sell: null,
  };
  if (gameOver) return { ...r, ok: false, status: 'gameOver' };
  if (amount <= 0) return { ...r, ok: false, status: roomA <= 0 ? 'overCap' : 'empty' };   // at the cap: say so at once
  if (priceIls === null) return { ...r, ok: false, status: 'noPrice' };
  if (agorot(amount) > agorot(availableCash)) return { ...r, ok: false, status: 'noCash' };
  if (over) return { ...r, ok: false, status: 'overCap' };
  if (amount < MIN_ORDER_ILS) return { ...r, ok: false, status: 'belowMin' };
  return { ...r, ok: true, status: 'ok' };
}

function checkSell({ amount, availableCash, totalValue, holding, gameOver }: CheckInput): Check {
  const held = holding?.valueIls ?? 0;
  const maxIls = shownFreeIls(holding);
  const plan = sellPlan(amount, holding);
  const sold = plan?.valueIls ?? 0;

  const r = {
    units: plan ? Number(plan.units) : 0,
    cashAfter: availableCash + sold,
    weightAfterPct: totalValue > 0 ? (Math.max(0, held - sold) / totalValue) * 100 : 0,
    maxIls,
    leftIls: Math.max(0, held - sold),
    capExact: true,
    sell: plan,
  };
  // Nothing held or nothing free is said before "enter an amount": no amount could change it.
  if (gameOver) return { ...r, ok: false, status: 'gameOver' };
  if (!holding || !(holding.units > 0)) return { ...r, ok: false, status: 'nothingToSell' };
  if (!(Math.round(holding.freeUnits * UNIT) > 0)) return { ...r, ok: false, status: 'locked' };   // all in pending sells
  if (amount <= 0 || !plan) return { ...r, ok: false, status: 'empty' };
  if (amount > maxIls) return { ...r, ok: false, status: 'overHolding' };
  if (amount < MIN_ORDER_ILS && !plan.all) return { ...r, ok: false, status: 'belowMin' };
  return { ...r, ok: true, status: 'ok' };
}

// Agorot → whole ₪, rounded down, never below 0.
function wholeIls(a: number): number {
  return Math.max(0, Math.floor(a / 100));
}

// Digits only, no leading zeros, at most MAX_DIGITS: what the amount field may contain.
export function cleanAmount(text: string): string {
  return text.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, MAX_DIGITS);
}

// The amount field as the player sees it: '100000' → '100,000'. What the screen keeps is cleanAmount's digits.
export function groupAmount(digits: string): string {
  return digits === '' ? '' : Number(digits).toLocaleString('en-US');
}

// The amount slider under the amount field: from the ₪100 minimum to the most this order may be (Check.maxIls:
// a buy's available cash and the 20% room left in the security, a sell's free units). It moves in ₪100 steps;
// its far end is the exact maximum.
export const SLIDER_STEP = 100;
export type SliderRange = { lo: number; hi: number };

// null = there is nothing it could pick (a buy with less than ₪100 of room or cash, a sell with no free unit).
// A sell worth under ₪100 may still sell everything, so its range is that one amount.
export function sliderRange(side: Side, maxIls: number): SliderRange | null {
  const hi = Math.floor(maxIls);
  if (side === 'buy') return hi >= MIN_ORDER_ILS ? { lo: MIN_ORDER_ILS, hi } : null;
  return hi >= 1 ? { lo: Math.min(MIN_ORDER_ILS, hi), hi } : null;
}

// Where an amount sits along the slider, 0 to 1. An amount outside the range sits at its end.
export function sliderRatio(amount: number, { lo, hi }: SliderRange): number {
  if (hi <= lo) return amount >= hi ? 1 : 0;
  return Math.min(1, Math.max(0, (amount - lo) / (hi - lo)));
}

// The amount at a point along the slider (0 to 1): whole ₪100 steps in between, exactly lo and hi at the ends.
export function sliderAmount(ratio: number, { lo, hi }: SliderRange): number {
  if (ratio >= 1 || hi <= lo) return hi;
  if (ratio <= 0) return lo;
  const v = Math.round((lo + ratio * (hi - lo)) / SLIDER_STEP) * SLIDER_STEP;
  return Math.min(hi, Math.max(lo, v));
}

// A price field: digits and one dot, two decimals, at most 10 characters.
export function cleanPrice(text: string): string {
  let s = text.replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  return s.slice(0, 10);
}

// Position tool math (planning only: the game has no stop or target orders).
export type Levels = { entry: number; target: number; stop: number };

export function positionMath(amountIls: number, levels: Levels) {
  const { entry, target, stop } = levels;
  const tp = target / entry - 1;           // gain to the target, as a fraction
  const sl = 1 - stop / entry;             // loss to the stop, as a fraction
  const reward = amountIls * tp;
  const risk = amountIls * sl;
  return { tp, sl, reward, risk, rr: risk > 0 ? reward / risk : 0 };
}

// Keeps stop < entry < target when one level moves (a long position).
export function clampLevel(levels: Levels, key: keyof Levels, value: number): Levels {
  if (!(value > 0)) return levels;
  let v = value;
  if (key === 'entry') v = Math.min(Math.max(v, levels.stop * 1.001), levels.target * 0.999);
  if (key === 'target') v = Math.max(v, levels.entry * 1.001);
  if (key === 'stop') v = Math.min(v, levels.entry * 0.999);
  return { ...levels, [key]: v };
}

export function defaultLevels(price: number): Levels {
  return { entry: price, target: price * 1.08, stop: price * 0.96 };
}
