// Moving a stop loss (D-041), as pure rules: what a move request may say, when its market is being checked, and
// what a move may set. Nothing here touches the database: stopMoves.ts loads, calls and writes.
//
// A stop whose buy has filled can be moved, up or down, while it is active (its position is open, fully or partly).
// The new price must be below the latest close the player sees, like a new stop (checkStop, D-037). A stop can't be
// moved while its market's latest open or close is waiting for the runner: the screens show that close as soon as
// the world clock passes it, but the runner checks the stops up to a minute later (D-030). A move in between could
// dodge a stop the close had already reached.

import { eventsBetween } from './clock.js';
import { SCALE } from './fixed.js';
import type { Calendar, Market, MarketEvent } from './marketHours.js';
import { checkStop, readSize, SEND_REASONS, waitForLimit } from './orderRules.js';

// 5 moves per real minute per player, apart from the 5 orders a minute (D-021).
export const STOP_MOVE_LIMIT = { moves: 5, windowSeconds: 60 } as const;

// What the app shows (Hebrew first). The app can show English from the code.
export const MOVE_REASONS = {
  STOP_NOT_FOUND: 'הסטופ לוס לא נמצא',
  STOP_NOT_ACTIVE: 'הסטופ לוס כבר לא פעיל: הוא הופעל או פג',
  STOP_CHECK_RUNNING: 'הסטופ נבדק עכשיו בשער הפתיחה או הסגירה. נסו שוב בעוד רגע',
  RATE_LIMITED: 'יותר מדי שינויים בסטופ: עד 5 בדקה. נסו שוב בעוד רגע',
  GAME_OVER: 'המשחק הגיע לסוף נתוני המחירים: הסטופ לא ייבדק שוב',
  NO_WORLD: 'העולם עוד לא התחיל',
  STOP_NOT_BELOW_PRICE: SEND_REASONS.STOP_NOT_BELOW_PRICE,
  STOP_NO_PRICE: SEND_REASONS.STOP_NO_PRICE,
} as const;

export type MoveRuleCode = 'STOP_NOT_ACTIVE' | 'STOP_NOT_BELOW_PRICE' | 'STOP_NO_PRICE';
export type MoveRefusal = { code: MoveRuleCode; reason: string };

export type StopStatus = 'active' | 'triggered' | 'expired';
export type EventStatus = 'pending' | 'orders_done' | 'done';

// ---------- the request ----------

const STOP_ID = /^[1-9]\d{0,18}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;   // stop_orders.id is a BIGINT

// The :id of PATCH /me/stops/:id. null = not a stop id (answered with 400 before it reaches SQL).
export function parseStopId(id: string): string | null {
  return STOP_ID.test(id) && BigInt(id) <= MAX_BIGINT ? id : null;
}

// The body: { stopPrice }, a price in the security's own currency, exactly as sent (a JSON number keeps its digits
// through parseOrderJson, like a new stop's). Any other key is ignored.
export function parseMoveBody(body: unknown): { ok: true; price: bigint } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'the body must be a JSON object' };
  const price = readSize((body as Record<string, unknown>).stopPrice, SCALE.PRICE);
  if (price === null) return { ok: false, error: `stopPrice must be a positive decimal with at most ${SCALE.PRICE} decimals` };
  return { ok: true, price };
}

// ---------- is its market being checked? ----------

// Longer than any run of closed days (MAX_CLOSED_RUN in marketHours.ts is 30).
const LOOK_BACK_MS = 35 * 86_400_000;

// The latest open or close of `market` at or before `now`: the one whose price the screens may already show.
// null = none in the look-back (a market closed for over a month).
export function lastEventOf(market: Market, now: Date, calendar: Calendar): MarketEvent | null {
  const mine = eventsBetween(new Date(now.getTime() - LOOK_BACK_MS), now, calendar).filter((e) => e.market === market);
  return mine[mine.length - 1] ?? null;
}

// `status` = that event's market_events row; undefined = the runner hasn't started it yet. Once the event is
// 'orders_done' its stops have been checked (the runner checks them first, triggerStops), so a move is safe again.
// A stop exists only after an event of its market ran, so an event with no row really is still to come.
export function checkRunning(last: MarketEvent | null, status: EventStatus | undefined): boolean {
  return last !== null && status !== 'orders_done' && status !== 'done';
}

// ---------- the move ----------

export type MoveCheck = {
  status: StopStatus;          // the stop's status now (locked)
  price: bigint;               // PRICE, the new stop
  latestClose: bigint | null;  // PRICE, the latest close of its market's last closed day; null = none known
};

// null = the stop may be moved. Up or down: only the latest close bounds it, as when it was set.
export function checkMove(c: MoveCheck): MoveRefusal | null {
  if (c.status !== 'active') return { code: 'STOP_NOT_ACTIVE', reason: MOVE_REASONS.STOP_NOT_ACTIVE };
  const bad = checkStop(c.price, c.latestClose);
  if (bad === null) return null;
  return { code: bad.code === 'STOP_NO_PRICE' ? 'STOP_NO_PRICE' : 'STOP_NOT_BELOW_PRICE', reason: bad.reason };
}

// The rate limit. `recent` = when this player's moves of the last minute were made (real time), newest first.
export function moveRetryAfter(recent: readonly Date[], now: Date): number | null {
  return waitForLimit(recent, now, STOP_MOVE_LIMIT.moves, STOP_MOVE_LIMIT.windowSeconds);
}
