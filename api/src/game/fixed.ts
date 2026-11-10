// Exact fixed-point math on bigint. Pure functions: no database, no framework.
// Money, units, prices and rates are never floats: a float can't hold 0.1 exactly, and a game that
// creates or loses an agora is broken. Each quantity is a bigint with an implied number of decimals
// (its scale) that matches the Postgres NUMERIC column it is stored in. Every helper rounds once, at the end.

// Digits after the point for each kind of quantity.
export const SCALE = {
  ILS: 2,        // agorot: cash, amounts, values, cost basis, P&L
  UNITS: 8,
  PRICE: 4,      // a security's price, in its own currency
  RATE: 4,       // USD/ILS
  AVG_COST: 8,   // ₪ per unit
  PCT: 4,        // 2.3456 = 2.3456 %
} as const;

// USD/ILS 1.0000: TASE prices are already in ₪.
export const RATE_ONE = 10_000n;

export type Rounding = 'down' | 'half_up';

const MAX_SCALE = 30;

function checkScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) throw new RangeError(`bad scale: ${scale}`);
}

export function pow10(n: number): bigint {
  checkScale(n);
  return 10n ** BigInt(n);
}

// Plain decimals only, the way Postgres prints NUMERIC: '131.0000', '-4256.76', '1000000'.
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

// Exact parse of a decimal string. Fewer decimals than `scale` are padded. Extra decimals are accepted only
// when they are all zeros, because then the number is unchanged: portfolios.cash (and the generated
// available_cash and equity) are NUMERIC(16,4), so pg prints '1000000.0000', yet they only ever hold whole
// agorot (D-019). A non-zero extra digit is refused, because dropping it would silently change the number.
export function parse(s: string, scale: number): bigint {
  checkScale(scale);
  const m = typeof s === 'string' ? DECIMAL.exec(s) : null;
  if (!m) throw new Error(`not a decimal number: ${JSON.stringify(s)}`);
  const [, sign, whole, frac = ''] = m;
  if (/[^0]/.test(frac.slice(scale))) throw new Error(`${s} has more than ${scale} decimals`);
  const v = BigInt(whole + frac.slice(0, scale).padEnd(scale, '0'));
  return sign ? -v : v;
}

// The inverse of parse: always exactly `scale` decimals. 0n has no sign, so '-0.00' can't happen.
export function format(v: bigint, scale: number): string {
  checkScale(scale);
  const digits = (v < 0n ? -v : v).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return (v < 0n ? '-' : '') + (scale > 0 ? `${whole}.${frac}` : whole);
}

// a × b ÷ c with one rounding.
//   'down'    = toward zero
//   'half_up' = half away from zero, the same as Postgres round()
export function mulDiv(a: bigint, b: bigint, c: bigint, mode: Rounding): bigint {
  if (c === 0n) throw new RangeError('mulDiv: division by zero');
  if (mode !== 'down' && mode !== 'half_up') throw new Error(`mulDiv: unknown rounding ${String(mode)}`);
  const n = a * b;
  const q = n / c;   // bigint division truncates toward zero, which is 'down'
  const r = n % c;
  if (mode === 'down' || r === 0n) return q;
  if (2n * abs(r) < abs(c)) return q;
  return (n < 0n) !== (c < 0n) ? q - 1n : q + 1n;
}

// units(8) × price(4) × rate(4) → ₪(2).
export function valueIls(units: bigint, price: bigint, rate: bigint): bigint {
  return mulDiv(units * price, rate, pow10(SCALE.UNITS + SCALE.PRICE + SCALE.RATE - SCALE.ILS), 'half_up');
}

// ₪(2) ÷ (price(4) × rate(4)) → units(8), rounded DOWN: on a buy the ₪ paid is exact and the player
// never gets a fraction of a unit they didn't pay for (D-019).
export function unitsFor(amountIls: bigint, price: bigint, rate: bigint): bigint {
  if (price <= 0n || rate <= 0n) throw new RangeError(`unitsFor: price and rate must be positive (${price}, ${rate})`);
  return mulDiv(amountIls, pow10(SCALE.UNITS + SCALE.PRICE + SCALE.RATE - SCALE.ILS), price * rate, 'down');
}

// Cost basis ₪(2) ÷ units(8) → ₪ per unit (8).
export function avgCost(costBasis: bigint, units: bigint): bigint {
  if (units === 0n) throw new RangeError('avgCost: no units');
  return mulDiv(costBasis, pow10(SCALE.AVG_COST + SCALE.UNITS - SCALE.ILS), units, 'half_up');
}

// Units(8) × average cost(8) → ₪(2), half up: the cost a sale releases. D-019 measures a sale's gain at
// average cost: units sold × (price × rate − average cost per unit).
export function costAtAvg(units: bigint, avgCostPerUnit: bigint): bigint {
  return mulDiv(units, avgCostPerUnit, pow10(SCALE.UNITS + SCALE.AVG_COST - SCALE.ILS), 'half_up');
}

// part ÷ whole × 100, at `scale` decimals (PCT by default). part and whole share one scale.
export function pct(part: bigint, whole: bigint, scale: number = SCALE.PCT): bigint {
  return mulDiv(part, 100n * pow10(scale), whole, 'half_up');
}

// amount × num ÷ den, in amount's scale, with one half-up rounding. (A partial sale releases
// costAtAvg(units, avgCost), not a proportion of the cost basis: D-019 measures gains at average cost.)
export function proportion(amount: bigint, num: bigint, den: bigint): bigint {
  return mulDiv(amount, num, den, 'half_up');
}

export function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
