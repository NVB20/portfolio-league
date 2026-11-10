// The rejection toasts (D-023, D-031): the orders the runner refused at an open or close since the player
// last looked, each with what it was and why. Pure: the screen shows these, then reports the ids it showed.

import type { HoldingView, RejectionCode, RejectionView } from '../../api/src/contract';
import { dayLabel, orderSize } from './format';

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
