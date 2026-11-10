// Number and time formatting for the dashboard. One place, so every card writes ₪ and % the same way.

const MINUS = '−';   // a real minus sign, wider than a hyphen, so +/− line up in tabular numbers

// ₪1,023,450 (or ₪3.72 with digits = 2).
export function ils(value: number, digits = 0): string {
  const sign = value < 0 ? MINUS : '';
  return `${sign}₪${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// ₪5,000 for a whole amount, ₪1,234.50 when there are agorot: for exact figures (an order's size, cash),
// where rounding to whole shekels would show a number that isn't the stored one.
export function ilsExact(value: number): string {
  return ils(value, Math.round(Math.abs(value) * 100) % 100 === 0 ? 0 : 2);
}

// An order's size (D-018): a buy is a ₪ amount, a sell a number of units ("12.5 יח׳", up to 4 decimals).
export function orderSize(o: { side: 'buy' | 'sell'; amountIls: number | null; units: number | null }): string | null {
  if (o.side === 'buy') return o.amountIls === null ? null : ilsExact(o.amountIls);
  return o.units === null ? null : `${o.units.toLocaleString('en-US', { maximumFractionDigits: 4 })} יח׳`;
}

// The whole shekels and the agorot apart, for the headline: "1,023,450" + ".32".
export function splitIls(value: number): { whole: string; agorot: string } {
  const [whole, agorot] = Math.abs(value)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .split('.');
  return { whole, agorot: `.${agorot}` };
}

// +2.35% / −1.80%. `signed: false` drops the + (for values that are never negative, like weights).
export function pct(value: number, { digits = 2, signed = true } = {}): string {
  const sign = value < 0 ? MINUS : signed && value > 0 ? '+' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

// Sunday = 0. Hebrew day letters as used in the design: א׳ ... ש׳.
export const WEEKDAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

export function dayLabel(weekday: number): string {
  return `יום ${WEEKDAY_LETTERS[weekday]}`;
}

// Minutes since midnight -> 'HH:MM'.
export function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// Score numbers: one decimal, the way the leaderboard shows them (78.4).
export function score(value: number): string {
  return value.toFixed(1);
}
