// Words of the trading screen that depend on the data. Hebrew first.

import type { ExecutionView, MarketSession, SecurityView, SendOrderResult, WorldTime } from '../../api/src/contract';
import { dayLabel, ils, ilsExact } from '../dashboard/format';
import type { Check } from './orderCheck';
import { MIN_ORDER_ILS, shortfallIls } from './orderCheck';

export const CITY: Record<SecurityView['market'], string> = { TASE: 'תל אביב', US: 'ניו יורק' };
export const EXCHANGE: Record<SecurityView['exchange'], string> = { TASE: 'ת״א', NASDAQ: 'NASDAQ', NYSE: 'NYSE' };
const MARKET_SHORT: Record<SecurityView['market'], string> = { TASE: 'ת״א', US: 'ניו יורק' };

// The end of the price history: an order sent now could never run (ExecutionView.gameOver, D-022, D-028).
export const GAME_OVER_LINE = 'נתוני המחירים נגמרו: אין עוד מועד ביצוע';

const PRICE_KIND: Record<ExecutionView['priceType'], string> = { close: 'שער הסגירה', open: 'שער הפתיחה' };

function day(at: WorldTime, today: string | null): string {
  return at.date === today ? '' : `${dayLabel(at.weekday)} `;
}

// ₪131.80 or $418.20: a price in the security's own currency.
export function money(value: number, currency: 'ILS' | 'USD', digits = 2): string {
  const sign = value < 0 ? '−' : '';
  const sym = currency === 'USD' ? '$' : '₪';
  return `${sign}${sym}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// "שער הסגירה · 17:30" / "שער הפתיחה · יום ב׳ 10:00" / "אין · נתוני המחירים נגמרו"
export function executionShort(e: ExecutionView, today: string | null): string {
  if (e.gameOver) return 'אין · נתוני המחירים נגמרו';
  return `${PRICE_KIND[e.priceType]} · ${day(e.at, today)}${e.at.time}`;
}

// "תתבצע בשער הסגירה 17:30" / "תתבצע בשער הפתיחה יום ב׳ 10:00"
export function runsAt(priceType: ExecutionView['priceType'], at: WorldTime, today: string | null): string {
  return `תתבצע ב${PRICE_KIND[priceType]} ${day(at, today)}${at.time}`;
}

// "ניו יורק סגור · תתבצע בשער הפתיחה 16:30"; on a day its market doesn't open at all (D-022):
// "ת״א סגורה: פסח · תתבצע בשער הפתיחה יום ב׳ 10:00". `session` = that market in data.clock.markets.
export function marketLine(s: SecurityView, today: string | null, session: MarketSession | null): string {
  const closedDay = !s.isOpen && (session?.state === 'holiday' || session?.state === 'weekend');
  const state = closedDay
    ? `${MARKET_SHORT[s.market]} סגורה: ${session?.reason ?? (session?.state === 'weekend' ? 'סוף שבוע' : 'חג')}`
    : `${CITY[s.market]} ${s.isOpen ? 'פתוח' : 'סגור'}`;
  if (!s.execution) return `${state} · השעון עוד לא התחיל`;
  if (s.execution.gameOver) return `${state} · ${GAME_OVER_LINE}`;
  return `${state} · ${runsAt(s.execution.priceType, s.execution.at, today)}`;
}

// The toast after a send: "הפקודה נשלחה · תתבצע בשער הסגירה 17:30". A replay (the same order sent again after
// a lost answer) shows the order as it is now (D-028), which may have run already, and says it was already sent.
export function sentToast({ order, replay }: SendOrderResult, today: string | null): string {
  if (order.status === 'executed') return 'הפקודה כבר בוצעה';
  if (order.status === 'rejected') return 'הפקודה כבר נדחתה בביצוע';
  return `${replay ? 'הפקודה כבר נשלחה' : 'הפקודה נשלחה'} · ${runsAt(order.priceType, order.executesAt, today)}`;
}

// The chip and the note under the weight bar in the preview card. Limits are whole ₪ rounded down (Check.maxIls),
// a shortfall is exact to the agora, and when the pending list was cut the cap room is only an upper bound.
export function checkChip(c: Check): { label: string; variant: 'up' | 'down' | 'ghost' } {
  switch (c.status) {
    case 'ok': return { label: 'מותר', variant: 'up' };
    case 'empty': return { label: 'הזן סכום', variant: 'ghost' };
    case 'gameOver': return { label: 'המשחק הסתיים', variant: 'down' };
    case 'noPrice': return { label: 'אין מחיר עדיין', variant: 'down' };
    case 'noCash': return { label: 'אין מספיק מזומן', variant: 'down' };
    case 'overCap': return { label: 'חסום · עובר 20%', variant: 'down' };
    case 'nothingToSell': return { label: 'אין מה למכור', variant: 'down' };
    case 'locked': return { label: 'אין יחידות פנויות', variant: 'down' };
    case 'overHolding': return { label: 'יותר ממה שיש', variant: 'down' };
    case 'belowMin': return { label: `מינימום ${ils(MIN_ORDER_ILS)}`, variant: 'down' };
  }
}

export function checkNote(c: Check, side: 'buy' | 'sell', amount: number, availableCash: number, symbol: string): string {
  switch (c.status) {
    case 'gameOver': return GAME_OVER_LINE;
    case 'noCash': return `חסר ${ilsExact(shortfallIls(amount, availableCash))}`;
    case 'overCap': return `מקסימום ${ils(c.maxIls)} בנייר הזה${c.capExact ? '' : ', אולי פחות'}`;
    case 'nothingToSell': return `אתה לא מחזיק ${symbol}`;
    case 'locked': return 'כל היחידות כבר בפקודות מכירה';
    case 'overHolding': return `מקסימום ${ils(c.maxIls)} פנויים (אין שורט)`;
    case 'belowMin': return side === 'sell' ? 'פחות מזה רק במכירת הכל' : '';
    case 'empty':
    case 'noPrice': return '';
    case 'ok':
      if (side === 'buy') return `נשאר מקום ל־${ils(c.leftIls)}${c.capExact ? '' : ' לכל היותר'}`;
      return c.sell?.all ? 'מוכר את כל היחידות הפנויות' : `נשאר בתיק ${ils(c.leftIls)}`;
  }
}
