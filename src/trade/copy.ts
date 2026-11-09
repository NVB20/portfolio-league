// Words of the trading screen that depend on the data. Hebrew first.

import type { ExecutionView, SecurityView } from '../../api/src/contract';
import { dayLabel, ils } from '../dashboard/format';
import type { Check } from './orderCheck';
import { MIN_ORDER_ILS } from './orderCheck';

export const CITY: Record<SecurityView['market'], string> = { TASE: 'תל אביב', US: 'ניו יורק' };
export const EXCHANGE: Record<SecurityView['exchange'], string> = { TASE: 'ת״א', NASDAQ: 'NASDAQ', NYSE: 'NYSE' };

// ₪131.80 or $418.20: a price in the security's own currency.
export function money(value: number, currency: 'ILS' | 'USD', digits = 2): string {
  const sign = value < 0 ? '−' : '';
  const sym = currency === 'USD' ? '$' : '₪';
  return `${sign}${sym}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// "שער הסגירה · 17:30" / "שער הפתיחה · יום ב׳ 10:00"
export function executionShort(e: ExecutionView, today: string | null): string {
  const kind = e.priceType === 'close' ? 'שער הסגירה' : 'שער הפתיחה';
  const day = e.at.date === today ? '' : `${dayLabel(e.at.weekday)} `;
  return `${kind} · ${day}${e.at.time}`;
}

// "ניו יורק סגור · תתבצע בשער הפתיחה 16:30"
export function marketLine(s: SecurityView, today: string | null): string {
  const state = `${CITY[s.market]} ${s.isOpen ? 'פתוח' : 'סגור'}`;
  if (!s.execution) return `${state} · השעון עוד לא התחיל`;
  const kind = s.execution.priceType === 'close' ? 'בשער הסגירה' : 'בשער הפתיחה';
  const day = s.execution.at.date === today ? '' : ` ${dayLabel(s.execution.at.weekday)}`;
  return `${state} · תתבצע ${kind}${day} ${s.execution.at.time}`;
}

// The chip and the note under the weight bar in the preview card.
export function checkChip(c: Check): { label: string; variant: 'up' | 'down' | 'ghost' } {
  switch (c.status) {
    case 'ok': return { label: 'מותר', variant: 'up' };
    case 'empty': return { label: 'הזן סכום', variant: 'ghost' };
    case 'noPrice': return { label: 'אין מחיר עדיין', variant: 'down' };
    case 'noCash': return { label: 'אין מספיק מזומן', variant: 'down' };
    case 'overCap': return { label: 'חסום · עובר 20%', variant: 'down' };
    case 'nothingToSell': return { label: 'אין מה למכור', variant: 'down' };
    case 'overHolding': return { label: 'יותר ממה שיש', variant: 'down' };
    case 'belowMin': return { label: `מינימום ${ils(MIN_ORDER_ILS)}`, variant: 'down' };
  }
}

export function checkNote(c: Check, side: 'buy' | 'sell', amount: number, cash: number, symbol: string): string {
  switch (c.status) {
    case 'noCash': return `חסר ${ils(amount - cash)}`;
    case 'overCap': return `מקסימום ${ils(c.maxIls)} בנייר הזה`;
    case 'nothingToSell': return `אתה לא מחזיק ${symbol}`;
    case 'overHolding': return `מקסימום ${ils(c.maxIls)} (אין שורט)`;
    case 'empty':
    case 'belowMin':
    case 'noPrice': return '';
    case 'ok': return side === 'buy' ? `נשאר מקום ל־${ils(c.leftIls)}` : `נשאר בתיק ${ils(c.leftIls)}`;
  }
}
