// The rejection toasts (D-023, D-031): the orders the runner refused at an open or close since the player
// last looked, each with what it was and why. The stop-loss toasts (D-037) are the same kind of notice: the sales
// a stop loss made since the player last looked. Pure: the screen shows these, then reports the ids it showed.

import type { HoldingView, RejectionCode, RejectionView, StopSaleView } from '../../api/src/contract';
import { dayLabel, ilsExact, orderSize } from './format';

export type RejectionNotice = {
  id: string;        // the order id: what POST /me/rejections/seen gets back once it was on screen
  title: string;     // 'קנייה טבע · ₪5,000'
  reason: string;    // the server's Hebrew reason, or ours when it's missing
  when: string;      // the open or close that refused it: 'יום ג׳ 17:30'
};

// The server always sends its own Hebrew reason. These cover an empty one, by code.
export const REJECTION_FALLBACK: Record<RejectionCode, string> = {
  NO_PRICE: 'אין מחיר למניה בזמן הביצוע',
  INSUFFICIENT_CASH: 'אין מספיק מזומן פנוי',
  OVER_LIMIT: 'ההחזקה הייתה עוברת 20% מהתיק',
  INSUFFICIENT_UNITS: 'אין מספיק יחידות למכירה',
};
const NO_CODE = 'הפקודה לא עמדה בכללים בזמן הביצוע';

// The API refuses more than 5 ids in one call (and never sends more than 5 rejections at once).
export const MAX_SEEN_IDS = 5;

// One notice per rejection, in the API's order (newest first). The Hebrew name comes from the holdings;
// a security the player doesn't hold (most rejected buys) shows its symbol.
export function rejectionNotices(rejections: RejectionView[], holdings: Pick<HoldingView, 'symbol' | 'nameHe'>[]): RejectionNotice[] {
  const names = new Map(holdings.map((h) => [h.symbol, h.nameHe]));
  return rejections.map((r) => {
    const size = orderSize(r);
    return {
      id: r.id,
      title: `${r.side === 'buy' ? 'קנייה' : 'מכירה'} ${names.get(r.symbol) ?? r.symbol}${size ? ` · ${size}` : ''}`,
      reason: r.reason.trim() || (r.code ? REJECTION_FALLBACK[r.code] : NO_CODE),
      when: `${dayLabel(r.at.weekday)} ${r.at.time}`,
    };
  });
}

export function rejectionsHeading(count: number): string {
  return count === 1 ? 'פקודה נדחתה' : `${count} פקודות נדחו`;
}

// The ids to report as seen: exactly the ones on screen, each once, none already reported, at most 5.
// Anything left out stays unseen on the server and simply shows again on the next load.
export function idsToMark(shown: string[], sent: ReadonlySet<string>): string[] {
  return [...new Set(shown)].filter((id) => !sent.has(id)).slice(0, MAX_SEEN_IDS);
}

// ---------- the stop-loss toasts (D-037) ----------

// A price in its own currency, two decimals: ₪94.00 / $180.50.
function price(value: number, currency: 'ILS' | 'USD'): string {
  return `${currency === 'USD' ? '$' : '₪'}${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// One notice per sale, in the API's order (newest first): what was sold, at which price against the stop (a gap
// sells below it), the ₪ received and the result, and the open or close that sold it.
export function stopSaleNotices(sales: StopSaleView[]): RejectionNotice[] {
  return sales.map((s) => {
    const result = s.realizedPnlIls < 0 ? `הפסד ${ilsExact(-s.realizedPnlIls)}` : `רווח ${ilsExact(s.realizedPnlIls)}`;
    return {
      id: s.id,
      title: `${s.symbol} · נמכרו ${s.units.toLocaleString('en-US', { maximumFractionDigits: 4 })} יח׳`,
      reason: `בשער ${price(s.fillPrice, s.currency)} (הסטופ: ${price(s.stopPrice, s.currency)}) · ${ilsExact(s.ils)} · ${result}`,
      when: `${dayLabel(s.at.weekday)} ${s.at.time}`,
    };
  });
}

export function stopSalesHeading(count: number): string {
  return count === 1 ? 'הסטופ לוס הופעל' : `${count} סטופ לוס הופעלו`;
}

