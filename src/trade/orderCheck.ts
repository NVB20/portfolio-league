// The order rules, checked in the app BEFORE sending, for the live preview (brief, rules 4–5):
// no leverage (enough cash), no short selling (enough units), one security ≤ 20% of the portfolio
// at the moment of buying. Pure: no React, no network.
//
// This is a first gate for a friendly preview, not the last: the API checks everything again when
// the order runs (game engine), because anyone can call the API directly.

export const CAP = 0.2;            // one security ≤ 20% of the portfolio when buying
export const MIN_ORDER_ILS = 100;  // smaller orders are noise (D-014)
export const MAX_DIGITS = 7;       // ₪9,999,999 is more than anyone can have

export type Side = 'buy' | 'sell';

export type CheckInput = {
  side: Side;
  amount: number;          // ₪ typed by the player
  cash: number;
  totalValue: number;      // cash + holdings, ₪
  heldIls: number;         // current value of this security in the portfolio, ₪
  priceIls: number | null; // latest known price in ₪ (US converted at today's rate), null = no price yet
};

export type CheckStatus = 'empty' | 'ok' | 'noPrice' | 'noCash' | 'overCap' | 'nothingToSell' | 'overHolding' | 'belowMin';

export type Check = {
  ok: boolean;
  status: CheckStatus;
  units: number;           // estimated units at the latest price
  cashAfter: number;
  weightAfterPct: number;  // this security's weight after the order, %
  maxIls: number;          // the most this order may be: cap room (buy) or the holding (sell)
  leftIls: number;         // cap room left after a buy, or holding left after a sell
};

// The most the player may send right now.
export function maxAllowed(side: Side, cash: number, totalValue: number, heldIls: number): number {
  if (side === 'sell') return Math.max(0, heldIls);
  return Math.max(0, Math.min(cash, CAP * totalValue - heldIls));
}

export function checkOrder({ side, amount, cash, totalValue, heldIls, priceIls }: CheckInput): Check {
  const maxIls = maxAllowed(side, cash, totalValue, heldIls);
  const units = priceIls ? amount / priceIls : 0;
  const base = { units, maxIls };

  if (side === 'buy') {
    const weightAfterPct = totalValue > 0 ? ((heldIls + amount) / totalValue) * 100 : 0;
    const r = { ...base, cashAfter: cash - amount, weightAfterPct, leftIls: Math.max(0, CAP * totalValue - heldIls - amount) };
    if (amount <= 0) return { ...r, ok: false, status: 'empty' };
    if (priceIls === null) return { ...r, ok: false, status: 'noPrice' };
    if (amount > cash) return { ...r, ok: false, status: 'noCash' };
    if (weightAfterPct > CAP * 100 + 1e-9) return { ...r, ok: false, status: 'overCap' };
    if (amount < MIN_ORDER_ILS) return { ...r, ok: false, status: 'belowMin' };
    return { ...r, ok: true, status: 'ok' };
  }

  const sold = Math.min(amount, heldIls);
  const r = {
    ...base,
    cashAfter: cash + sold,
    weightAfterPct: totalValue > 0 ? (Math.max(0, heldIls - amount) / totalValue) * 100 : 0,
    leftIls: Math.max(0, heldIls - amount),
  };
  if (amount <= 0) return { ...r, ok: false, status: 'empty' };
  if (heldIls <= 0) return { ...r, ok: false, status: 'nothingToSell' };
  if (amount > heldIls + 0.5) return { ...r, ok: false, status: 'overHolding' };   // 0.5: rounding of the shown value
  if (amount < MIN_ORDER_ILS) return { ...r, ok: false, status: 'belowMin' };
  return { ...r, ok: true, status: 'ok' };
}

// Digits only, no leading zeros, at most MAX_DIGITS: what the amount field may contain.
export function cleanAmount(text: string): string {
  return text.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, MAX_DIGITS);
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
