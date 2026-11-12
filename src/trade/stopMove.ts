// Moving a stop loss from the holding cards and the journal (D-041): the body of PATCH /me/stops/:id, the editor's
// words, and what the player reads when it fails. Pure: no React, no network (useMoveStop.ts sends it).
// A move is safe to send again: the same price twice is answered with changed: false and writes nothing, so after
// no answer the player can simply press save again.
//
// The imports are type-only and end in .js: see orderBody.ts. copy.ts imports src/dashboard, which that check sees
// as CommonJS, so the one price format this file needs is written here (as in src/journal/journal.ts).

import type { MoveStopBody, MoveStopErrorCode } from '../../api/src/contract.js';
import type { StopCheck } from './orderCheck.js';

// ₪95.00 / $418.20: a price in the security's own currency (copy.ts's money).
function money(value: number, currency: 'ILS' | 'USD'): string {
  const n = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0 ? '−' : ''}${currency === 'USD' ? '$' : '₪'}${n}`;
}

// A stop on a holding card: "סטופ ₪98.00 · הוזז מ־₪95.00", or "סטופ ₪95.00" when it was never moved.
export function stopNowText(price: number, originalPrice: number, currency: 'ILS' | 'USD'): string {
  const now = `סטופ ${money(price, currency)}`;
  return price === originalPrice ? now : `${now} · הוזז מ־${money(originalPrice, currency)}`;
}

// Under the editor's price field: how far under the latest close the new stop is, or why it can't be saved.
// `c` = checkStop(new price, lastClose, 0) from orderCheck.ts: the same rule the server checks.
export function stopEditLine(c: StopCheck, lastClose: number | null, currency: 'ILS' | 'USD'): string {
  switch (c.status) {
    case 'ok': return `−${c.belowPct.toFixed(1)}% מהסגירה האחרונה (${money(lastClose ?? 0, currency)})`;
    case 'notBelow': return `חייב להיות נמוך מ־${money(lastClose ?? 0, currency)}, הסגירה האחרונה`;
    case 'noPrice': return 'אין עדיין מחיר למניה';
    case 'empty': return 'הזן מחיר לסטופ';
    case 'off': return '';
  }
}

// Save is allowed for a valid price that differs from the stop now.
export function canSaveStop(c: StopCheck, current: number): boolean {
  return c.ok && c.stop !== null && c.stop !== current;
}

// The price as the ticket sends a stop: 2 decimals (stopSent).
export function moveStopBody(price: number): MoveStopBody {
  return { stopPrice: price.toFixed(2) };
}

export type MoveFailure = {
  message: string;     // Hebrew, under the editor
  reload: boolean;     // the card or the row may be out of date (the stop fired, the close moved): load it again
};

export const MOVE_NETWORK_FAILURE = 'אין תשובה מהשרת. אפשר ללחוץ שוב: שינוי לאותו מחיר לא נרשם פעמיים.';
const GENERIC = 'הסטופ לא הוזז. נסו שוב בעוד רגע.';

const FALLBACK: Record<MoveStopErrorCode, string> = {
  BAD_REQUEST: 'המחיר לא תקין. בדקו אותו ונסו שוב.',
  NO_USER: 'החשבון עוד לא מוכן. רעננו את הדף ונסו שוב.',
  STOP_NOT_FOUND: 'הסטופ לוס לא נמצא.',
  NO_WORLD: 'העולם עוד לא התחיל.',
  GAME_OVER: 'נתוני המחירים נגמרו: הסטופ לא ייבדק שוב.',
  STOP_NOT_ACTIVE: 'הסטופ לוס כבר לא פעיל: הוא הופעל או פג.',
  STOP_CHECK_RUNNING: 'הסטופ נבדק עכשיו בשער הפתיחה או הסגירה. נסו שוב בעוד רגע.',
  STOP_NOT_BELOW_PRICE: 'הסטופ לוס חייב להיות נמוך מהמחיר האחרון.',
  STOP_NO_PRICE: 'אין עדיין מחיר למניה.',
  RATE_LIMITED: 'יותר מדי שינויים בסטופ: עד 5 בדקה. נסו שוב בעוד רגע.',
};

// err = the API's answer (status + parsed JSON body), or null when there was none (network, timeout).
// The server's Hebrew `reason` wins. A stop that is no longer active, or a price the latest close no longer allows,
// means the screen is out of date: load it again. Waiting (the check, the rate limit) changes nothing on screen.
export function moveFailure(err: { status: number; body: unknown } | null): MoveFailure {
  if (!err || err.status >= 500) return { message: MOVE_NETWORK_FAILURE, reload: false };
  const body = typeof err.body === 'object' && err.body !== null ? (err.body as { code?: unknown; reason?: unknown }) : {};
  const code = typeof body.code === 'string' && Object.prototype.hasOwnProperty.call(FALLBACK, body.code)
    ? (body.code as MoveStopErrorCode)
    : null;
  const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason : null;
  return {
    message: reason ?? (code ? FALLBACK[code] : GENERIC),
    reload: code === 'STOP_NOT_ACTIVE' || code === 'STOP_NOT_FOUND' || code === 'STOP_NOT_BELOW_PRICE' || code === 'STOP_NO_PRICE',
  };
}
