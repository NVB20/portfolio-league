// PATCH /me/stops/:id: moving a stop loss (D-041).
// One short transaction on one pool connection, with the locks in the order sending takes them (orders.ts, D-021):
//   1. this player's portfolio row, FOR UPDATE: one player's moves run one at a time, so the rate limit can't be
//      beaten in parallel. Other players never wait.
//   2. the clock row, FOR SHARE: no open or close can start (the runner's startEvent locks it exclusively) until
//      this commits.
//   3. the stop row, FOR UPDATE, last, and only once its market's latest open or close is known to be checked. The
//      runner locks stops before portfolios (triggerStops), but only while that event is 'pending', and a move then
//      refuses before it touches the stop. So the two never wait on each other.
// Every rule lives in game/stopMove.ts; this file loads, calls and writes.

import type { Pool, PoolClient } from 'pg';
import type { MoveStopError, MoveStopErrorCode, MoveStopResult, StopView } from './contract.js';
import { loadCalendar } from './calendar.js';
import { CLOCK_COLUMNS, type ClockSqlRow, effectiveNow } from './dashboard.js';
import { latestClose } from './trade.js';
import { format, parse, SCALE } from './game/fixed.js';
import { type Calendar, executionFor, lastClosedDay, type Market } from './game/marketHours.js';
import { checkTiming } from './game/orderRules.js';
import {
  checkMove, checkRunning, type EventStatus, lastEventOf, MOVE_REASONS, moveRetryAfter, parseMoveBody, parseStopId,
  STOP_MOVE_LIMIT, type MoveRuleCode, type StopStatus,
} from './game/stopMove.js';

type MoveFailure = { status: 400 | 404 | 409 | 422 | 429; body: MoveStopError; retryAfter?: number };
export type MoveOutcome = { status: 200; body: MoveStopResult } | MoveFailure;

// The runner ticks about once a minute (D-030) and checks the stops first, so a few seconds is usually enough.
const CHECK_RETRY_SECONDS = 15;

// English, for the app's English mode; `reason` carries the Hebrew the player sees.
const RULE_ERRORS: Record<MoveRuleCode, string> = {
  STOP_NOT_ACTIVE: 'the stop loss is no longer active: it fired or expired',
  STOP_NOT_BELOW_PRICE: 'the stop loss must be below the latest price',
  STOP_NO_PRICE: 'no price is known yet for this security, so no stop loss can be set',
};

function fail(status: MoveFailure['status'], code: MoveStopErrorCode, error: string, reason?: string): MoveFailure {
  return { status, body: reason === undefined ? { error, code } : { error, code, reason } };
}

export async function moveStop(db: Pool, uid: string, rawId: string, body: unknown): Promise<MoveOutcome> {
  const id = parseStopId(rawId);
  if (id === null) return fail(400, 'BAD_REQUEST', 'the stop id must be a string of digits');
  const parsed = parseMoveBody(body);
  if (!parsed.ok) return fail(400, 'BAD_REQUEST', parsed.error);

  // Loaded BEFORE taking a connection, as in sendOrder: a cold cache needs a second one.
  const calendar = await loadCalendar(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');   // READ COMMITTED: each statement sees what committed before it started
    const out = await moveIn(client, uid, id, parsed.price, calendar);
    await client.query(out.status === 200 ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

type StopRow = {
  id: string;
  status: StopStatus;
  symbol: string;
  market: Market;
  stop_price: string;
  original_price: string;
  units: string;
};

async function moveIn(c: PoolClient, uid: string, id: string, price: bigint, calendar: Calendar): Promise<MoveOutcome> {
  // 1. The player's portfolio, FOR UPDATE.
  const portfolio = await c.query('SELECT 1 FROM portfolios WHERE uid = $1 FOR UPDATE', [uid]);
  if (portfolio.rowCount === 0) return fail(404, 'NO_USER', 'user not found, call POST /me first');

  // 2. The stop, the caller's only: someone else's is "not found", never "not yours". Not locked yet (see the top).
  const stop = await loadStop(c, id, uid);
  if (!stop) return fail(404, 'STOP_NOT_FOUND', 'no such stop loss', MOVE_REASONS.STOP_NOT_FOUND);
  if (stop.status !== 'active') return fail(409, 'STOP_NOT_ACTIVE', RULE_ERRORS.STOP_NOT_ACTIVE, MOVE_REASONS.STOP_NOT_ACTIVE);

  // 3. The same price again (a retry after a lost answer) changes nothing and isn't counted. Only this player's
  //    moves change a stop's price, and they wait for each other on the portfolio row, so this read is current.
  if (parse(stop.stop_price, SCALE.PRICE) === price) return { status: 200, body: { stop: toView(stop), changed: false } };

  // 4. The rate limit, in real time. Only stored moves count: a refused move writes nothing.
  const recent = (await c.query<{ created_at: Date; real_now: Date }>(
    `SELECT created_at, now() AS real_now FROM stop_moves
     WHERE uid = $1 AND created_at > now() - make_interval(secs => $2)
     ORDER BY created_at DESC LIMIT $3`,
    [uid, STOP_MOVE_LIMIT.windowSeconds, STOP_MOVE_LIMIT.moves],
  )).rows;
  const wait = recent.length > 0 ? moveRetryAfter(recent.map((r) => r.created_at), recent[0].real_now) : null;
  if (wait !== null) {
    return { ...fail(429, 'RATE_LIMITED', `too many stop moves: at most ${STOP_MOVE_LIMIT.moves} per minute`, MOVE_REASONS.RATE_LIMITED), retryAfter: wait };
  }

  // 5. The clock, shared lock, held until COMMIT. "Now" by the same formula as the screens and sending.
  const clock = (await c.query<ClockSqlRow>(`SELECT ${CLOCK_COLUMNS} FROM world_clock FOR SHARE`)).rows[0];
  if (!clock) return fail(409, 'NO_WORLD', 'the world has not started yet', MOVE_REASONS.NO_WORLD);
  const now = effectiveNow(clock, calendar);

  // 6. Past the end of the prices its market never opens or closes again, so the stop is never checked again.
  if (checkTiming(now, executionFor(stop.market, now, calendar).at, clock.ends_at)) {
    return fail(409, 'GAME_OVER', 'the game is over: this stop will never be checked again', MOVE_REASONS.GAME_OVER);
  }

  // 7. Its market's latest open or close must be checked already: the screens show that price, the runner may not
  //    have checked the stops at it yet. No new one can start while the clock is held.
  const last = lastEventOf(stop.market, now, calendar);
  const event = last
    ? (await c.query<{ status: EventStatus }>(
        'SELECT status FROM market_events WHERE market = $1 AND kind = $2 AND day = $3',
        [last.market, last.kind, last.day],
      )).rows[0]
    : undefined;
  if (checkRunning(last, event?.status)) {
    return {
      ...fail(409, 'STOP_CHECK_RUNNING', "the stop's market is being checked right now; try again in a moment", MOVE_REASONS.STOP_CHECK_RUNNING),
      retryAfter: CHECK_RETRY_SECONDS,
    };
  }

  // 8. Now the stop row: nothing else can be checking it. It may have fired or expired since step 2.
  const locked = (await c.query<{ status: StopStatus; stop_price: string }>(
    'SELECT status, stop_price::text AS stop_price FROM stop_orders WHERE id = $1 FOR UPDATE',
    [id],
  )).rows[0];
  const close = await latestClose(c, stop.symbol, lastClosedDay(stop.market, now, calendar));
  const refusal = checkMove({ status: locked.status, price, latestClose: close === null ? null : parse(close, SCALE.PRICE) });
  if (refusal) return fail(refusal.code === 'STOP_NOT_ACTIVE' ? 409 : 422, refusal.code, RULE_ERRORS[refusal.code], refusal.reason);

  // 9. The move and its history row.
  const to = format(price, SCALE.PRICE);
  await c.query('UPDATE stop_orders SET stop_price = $2::numeric, moved_at = $3 WHERE id = $1', [id, to, now]);
  await c.query(
    `INSERT INTO stop_moves (stop_id, uid, from_price, to_price, world_at) VALUES ($1, $2, $3::numeric, $4::numeric, $5)`,
    [id, uid, locked.stop_price, to, now],
  );
  return { status: 200, body: { stop: toView({ ...stop, stop_price: to }), changed: true } };
}

async function loadStop(c: PoolClient, id: string, uid: string): Promise<StopRow | undefined> {
  const { rows } = await c.query<StopRow>(
    `SELECT so.id::text AS id, so.status, so.symbol, s.market, so.stop_price::text AS stop_price,
            o.stop_price::text AS original_price, so.units::text AS units
     FROM stop_orders so
     JOIN securities s ON s.symbol = so.symbol
     JOIN orders o ON o.id = so.buy_order_id
     WHERE so.id = $1 AND so.uid = $2`,
    [id, uid],
  );
  return rows[0];
}

// Numbers for the JSON, like every view (the contract uses numbers; the exact values stay in Postgres).
function toView(r: StopRow): StopView {
  return { id: r.id, price: Number(r.stop_price), originalPrice: Number(r.original_price), units: Number(r.units) };
}
