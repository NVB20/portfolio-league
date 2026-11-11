// What the player reads when POST /me/orders fails. Pure: no React, no network.
// The server's Hebrew `reason` wins; otherwise a fallback per SendOrderErrorCode (D-028).
// A failure where the order may still have been stored (no answer, a timeout, a 5xx) keeps the clientOrderId
// and the exact body sent (SendMemory), so pressing again can't make a second order: the server answers the same
// order with replay: true.
//
// Any 4xx is a definite answer that nothing was stored under that id: the server checks a known clientOrderId
// (and answers with the replay) before the rate limit and every rule (api/src/orders.ts). The one exception is
// CLIENT_ID_CONFLICT: that id belongs to another order.
//
// The import is type-only and ends in .js: see orderBody.ts.

import type { SendOrderErrorCode } from '../../api/src/contract.js';

// unknown = no answer, the order may be stored; refused = nothing stored under that id; conflict = the id is taken.
export type SendOutcomeKind = 'unknown' | 'refused' | 'conflict';

export type SendFailure = {
  message: string;            // Hebrew, for the toast
  retry: boolean;             // pressing again with the same order makes sense: keep the confirm step open
  outcome: SendOutcomeKind;   // what the answer says about the clientOrderId (SendMemory.settle)
  reload: boolean;            // the trade data may be out of date: load it again
};

export const NETWORK_FAILURE = 'לא בטוח שהפקודה הגיעה. אפשר ללחוץ שוב: היא לא תישלח פעמיים.';
const GENERIC = 'הפקודה לא נשלחה. נסו שוב בעוד רגע.';

const FALLBACK: Record<SendOrderErrorCode, string> = {
  BAD_REQUEST: 'הפקודה לא תקינה. בדקו את הסכום ונסו שוב.',
  UNKNOWN_SYMBOL: 'נייר הערך הזה לא קיים במשחק.',
  NO_USER: 'החשבון עוד לא מוכן. רעננו את הדף ונסו שוב.',
  NO_WORLD: 'העולם עוד לא התחיל. אי אפשר לשלוח פקודות.',
  GAME_OVER: 'נתוני המחירים נגמרו. אין עוד מועד שבו הפקודה תתבצע.',
  CLIENT_ID_CONFLICT: 'משהו בפקודה השתנה. לחצו שוב כדי לשלוח אותה.',
  BELOW_MIN: 'הסכום המינימלי לפקודה הוא ₪100.',
  INSUFFICIENT_CASH: 'אין מספיק מזומן זמין.',
  NO_POSITION: 'אין לך יחידות של נייר הערך הזה.',
  INSUFFICIENT_UNITS: 'אין מספיק יחידות פנויות.',
  OVER_LIMIT: 'הקנייה תעביר את הנייר מעל 20% מהתיק.',
  RATE_LIMITED: 'יותר מדי פקודות: עד 5 בדקה. נסו שוב בעוד רגע.',
  STOP_NOT_BELOW_PRICE: 'הסטופ לוס חייב להיות נמוך מהמחיר האחרון.',
  STOP_NO_PRICE: 'אין עדיין מחיר למניה, אי אפשר לקבוע סטופ לוס.',
};

// err = the API's answer (status + parsed JSON body), or null when there was none (network, timeout).
// reload: a refusal means the preview's inputs were out of date (the app checks the same rules), and after no
// answer the order may be stored and pending. Only a rate limit changes nothing.
export function sendFailure(err: { status: number; body: unknown } | null): SendFailure {
  if (!err || err.status >= 500) return { message: NETWORK_FAILURE, retry: true, outcome: 'unknown', reload: true };
  const body = typeof err.body === 'object' && err.body !== null ? (err.body as { code?: unknown; reason?: unknown }) : {};
  const code = typeof body.code === 'string' && Object.prototype.hasOwnProperty.call(FALLBACK, body.code)
    ? (body.code as SendOrderErrorCode)
    : null;
  const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason : null;
  return {
    message: reason ?? (code ? FALLBACK[code] : GENERIC),
    retry: code === 'RATE_LIMITED' || code === 'CLIENT_ID_CONFLICT',
    outcome: code === 'CLIENT_ID_CONFLICT' ? 'conflict' : 'refused',
    reload: code !== 'RATE_LIMITED',
  };
}
