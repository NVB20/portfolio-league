// The rules checked when an order is SENT (D-014, D-018, D-020, D-021, D-028). Pure: no database.
// Sending only reserves cash or units; the runner checks cash, units and the 20% limit again at the
// execution price (engine.ts). These checks catch what is already certain when the player presses send,
// so they hear about it now instead of in a rejection toast after the close.
// Money and units are bigint fixed-point (fixed.ts), never floats.

import { costAtAvg, parse, RATE_ONE, SCALE, valueIls } from './fixed.js';
import { LIMIT_PCT, overLimitReason, REASONS } from './engine.js';

// The smallest order, ₪100.00 (D-014).
export const MIN_ORDER_ILS = 10_000n;

// 5 orders per real minute per player (D-021).
export const RATE_LIMIT = { orders: 5, windowSeconds: 60 } as const;

export type SendRuleCode = 'BELOW_MIN' | 'INSUFFICIENT_CASH' | 'NO_POSITION' | 'INSUFFICIENT_UNITS' | 'OVER_LIMIT' | 'GAME_OVER';
export type SendRefusal = { code: SendRuleCode; reason: string };

// Shown to the player (Hebrew first). The app can show English from the code.
export const SEND_REASONS = {
  BELOW_MIN_BUY: 'הסכום המינימלי להזמנה הוא ₪100',
  BELOW_MIN_SELL: 'מכירה בשווי של פחות מ־₪100 אפשרית רק אם מוכרים את כל היחידות הפנויות',
  INSUFFICIENT_CASH: REASONS.INSUFFICIENT_CASH,
  NO_POSITION: 'אין לך יחידות של נייר הערך הזה',
  INSUFFICIENT_UNITS: REASONS.INSUFFICIENT_UNITS,
  GAME_OVER: 'המשחק הגיע לסוף נתוני המחירים: אין עוד מועד שבו ההזמנה תוכל להתבצע',
  NO_WORLD: 'העולם עוד לא התחיל, אי אפשר לשלוח הזמנות',
  RATE_LIMITED: 'יותר מדי הזמנות: עד 5 בדקה. נסו שוב בעוד רגע',
} as const;

// ---------- the request body ----------

export type SendRequest = {
  symbol: string;
  side: 'buy' | 'sell';
  amount: bigint | null;        // ILS, buys only (D-018)
  units: bigint | null;         // UNITS, sells only
  clientOrderId: string | null;
};

const SYMBOL = /^[A-Z0-9-]{1,10}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PLAIN_DECIMAL = /^\d+(?:\.(\d+))?$/;
const MAX_SIZE_CHARS = 20;

// A size as the player sent it: a decimal string, or a JSON number read through String(n). Nothing is
// rounded: a number we would have to round (too many decimals, 0.1 + 0.2, an exponent) is refused, so the
// order stored is exactly the order sent. null = not a valid size.
function readSize(v: unknown, scale: number): bigint | null {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || s.length > MAX_SIZE_CHARS) return null;
  const m = PLAIN_DECIMAL.exec(s);
  if (!m || (m[1] ?? '').length > scale) return null;
  const n = parse(s, scale);
  return n > 0n ? n : null;
}

const absent = (v: unknown) => v === undefined || v === null;

export function parseSendBody(body: unknown): { ok: true; order: SendRequest } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail('the body must be a JSON object');
  const b = body as Record<string, unknown>;

  if (typeof b.symbol !== 'string' || !SYMBOL.test(b.symbol)) return fail('symbol must match ^[A-Z0-9-]{1,10}$');
  if (b.side !== 'buy' && b.side !== 'sell') return fail('side must be "buy" or "sell"');

  let clientOrderId: string | null = null;
  if (!absent(b.clientOrderId)) {
    if (typeof b.clientOrderId !== 'string' || !CLIENT_ID.test(b.clientOrderId)) {
      return fail('clientOrderId must match ^[A-Za-z0-9_-]{1,64}$');
    }
    clientOrderId = b.clientOrderId;
  }

  // D-018: a buy is a ₪ amount, a sell is a number of units.
  if (b.side === 'buy') {
    if (!absent(b.units)) return fail('a buy is sized by amountIls only; units are for sells');
    const amount = readSize(b.amountIls, SCALE.ILS);
    if (amount === null) return fail(`amountIls must be a positive decimal with at most ${SCALE.ILS} decimals (at most ${MAX_SIZE_CHARS} characters)`);
    return { ok: true, order: { symbol: b.symbol, side: 'buy', amount, units: null, clientOrderId } };
  }
  if (!absent(b.amountIls)) return fail('a sell is sized by units only; amountIls is for buys');
  const units = readSize(b.units, SCALE.UNITS);
  if (units === null) return fail(`units must be a positive decimal with at most ${SCALE.UNITS} decimals (at most ${MAX_SIZE_CHARS} characters)`);
  return { ok: true, order: { symbol: b.symbol, side: 'sell', amount: null, units, clientOrderId } };
}

// ---------- the checks ----------

// The player's open position in the order's stock, from the `positions` row.
export type HeldPosition = {
  units: bigint;                // UNITS
  reservedUnits: bigint;        // UNITS locked by pending sells
  costBasis: bigint;            // ILS
  avgCost: bigint;              // AVG_COST
  lastPrice: bigint | null;     // PRICE, the last mark
  lastRate: bigint | null;      // RATE of the mark; null for TASE
  marketValue: bigint | null;   // ILS at the last mark
};

export type SendCheck =
  | {
      side: 'buy';
      amount: bigint;           // ILS
      availableCash: bigint;    // ILS: cash − reserved cash
      equity: bigint;           // ILS: the stored portfolio value, reserved cash included
      pendingBuys: bigint;      // ILS: this player's pending buys of the same stock
      position: HeldPosition | null;
    }
  | { side: 'sell'; units: bigint; position: HeldPosition | null };

// null = the order may be sent.
export function checkSend(input: SendCheck): SendRefusal | null {
  return input.side === 'buy' ? checkBuy(input) : checkSell(input);
}

function checkBuy(b: Extract<SendCheck, { side: 'buy' }>): SendRefusal | null {
  if (b.amount < MIN_ORDER_ILS) return { code: 'BELOW_MIN', reason: SEND_REASONS.BELOW_MIN_BUY };
  if (b.amount > b.availableCash) return { code: 'INSUFFICIENT_CASH', reason: SEND_REASONS.INSUFFICIENT_CASH };
  // D-020 "when sent", with the last known price. The holding counts the pending buys of the same stock
  // too (D-028): otherwise several orders, each under 20% alone, could be sent together, and the player
  // would only learn at the close that all but one were rejected. Exact bigint comparison, no rounding.
  const holding = (b.position ? (b.position.marketValue ?? b.position.costBasis) : 0n) + b.pendingBuys;
  if ((holding + b.amount) * 100n > LIMIT_PCT * b.equity) {
    return { code: 'OVER_LIMIT', reason: overLimitReason(holding + b.amount, b.equity) };
  }
  return null;
}

function checkSell(s: Extract<SendCheck, { side: 'sell' }>): SendRefusal | null {
  const p = s.position;
  if (!p) return { code: 'NO_POSITION', reason: SEND_REASONS.NO_POSITION };
  const free = p.units - p.reservedUnits;
  if (s.units > free) return { code: 'INSUFFICIENT_UNITS', reason: SEND_REASONS.INSUFFICIENT_UNITS };
  // D-014 for sells, at the last mark (never-marked: at average cost). Selling every free unit is always
  // allowed, so a position worth under ₪100 can still be closed (D-028).
  const value = p.lastPrice !== null
    ? valueIls(s.units, p.lastPrice, p.lastRate ?? RATE_ONE)
    : costAtAvg(s.units, p.avgCost);
  if (value < MIN_ORDER_ILS && s.units !== free) return { code: 'BELOW_MIN', reason: SEND_REASONS.BELOW_MIN_SELL };
  return null;
}

// An order that would run after the world's end (world_clock.ends_at) can never run, and its cash or units
// would stay locked for good (D-028). endsAt null = no end.
export function checkTiming(now: Date, executesAt: Date, endsAt: Date | null): SendRefusal | null {
  if (endsAt !== null && (now >= endsAt || executesAt > endsAt)) return { code: 'GAME_OVER', reason: SEND_REASONS.GAME_OVER };
  return null;
}

// The rate limit (D-021). `recent` = when this player's orders of the last minute were sent (real time),
// newest first; only the first RATE_LIMIT.orders matter. null = may send. Otherwise the seconds until the
// oldest of the last 5 is a minute old, rounded up and at least 1: the moment one more order is allowed.
export function retryAfterSeconds(recent: readonly Date[], now: Date): number | null {
  if (recent.length < RATE_LIMIT.orders) return null;
  const oldest = recent[RATE_LIMIT.orders - 1];
  const waitMs = oldest.getTime() + RATE_LIMIT.windowSeconds * 1000 - now.getTime();
  return Math.max(1, Math.ceil(waitMs / 1000));
}
