// POST /me/orders: sending an order (D-018, D-019, D-020, D-021, D-028).
// One short transaction per send, on one pool connection. It locks only this player's portfolio row, so
// players never wait for each other, and takes a SHARED lock on the clock row, so an order can't slip past
// an event the runner has already started (a clock move takes the row FOR UPDATE). Nothing executes here:
// the order waits as `pending` for its open or close, with its cash (buy) or units (sell) set aside.
// Every rule lives in game/orderRules.ts; this file loads, calls and writes.

import type { Pool, PoolClient } from 'pg';
import type { SendOrderError, SendOrderErrorCode, SendOrderResult, SentOrderView } from './contract.js';
import { loadCalendar } from './calendar.js';
import { CLOCK_COLUMNS, type ClockSqlRow, effectiveNow, worldTime } from './dashboard.js';
import { format, parse, SCALE } from './game/fixed.js';
import { type Journal, reserveJournal } from './game/ledger.js';
import { type Calendar, executionFor, type Market } from './game/marketHours.js';
import {
  checkSend, checkTiming, type HeldPosition, parseSendBody, RATE_LIMIT, retryAfterSeconds, SEND_REASONS,
  type SendRequest, type SendRuleCode,
} from './game/orderRules.js';

type SendFailure = { status: 400 | 404 | 409 | 422 | 429; body: SendOrderError; retryAfter?: number };
export type SendOutcome = { status: 200 | 201; body: SendOrderResult } | SendFailure;

// English, for the app's English mode; `reason` carries the Hebrew the player sees.
const RULE_ERRORS: Record<SendRuleCode, string> = {
  BELOW_MIN: 'the smallest order is ₪100',
  INSUFFICIENT_CASH: 'not enough available cash',
  NO_POSITION: 'you hold no units of this security',
  INSUFFICIENT_UNITS: 'not enough free units',
  OVER_LIMIT: 'the holding would be over 20% of the portfolio',
  GAME_OVER: 'the game is over: this order could never execute',
};

function fail(status: SendFailure['status'], code: SendOrderErrorCode, error: string, reason?: string): SendFailure {
  return { status, body: reason === undefined ? { error, code } : { error, code, reason } };
}

// The order as the screens show it. float8 only here, for the JSON (the contract uses numbers).
const VIEW_COLUMNS = `id::text AS id, symbol, side, status, amount_ils::float8 AS amount_ils, units::float8 AS units,
  price_type, placed_at, executes_at, client_order_id`;

type ViewRow = {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  status: SentOrderView['status'];
  amount_ils: number | null;
  units: number | null;
  price_type: 'open' | 'close';
  placed_at: Date;
  executes_at: Date;
  client_order_id: string | null;
};

function toView(r: ViewRow, market: Market): SentOrderView {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    amountIls: r.amount_ils,
    units: r.units,
    priceType: r.price_type,
    market,
    executesAt: worldTime(r.executes_at),
    status: r.status,
    placedAt: worldTime(r.placed_at),
    clientOrderId: r.client_order_id,
  };
}

export async function sendOrder(db: Pool, uid: string, body: unknown): Promise<SendOutcome> {
  const parsed = parseSendBody(body);
  if (!parsed.ok) return fail(400, 'BAD_REQUEST', parsed.error);

  // Loaded BEFORE taking a connection: a cold cache needs a second one, and a burst of sends that each hold
  // a connection while waiting for another would stall the pool.
  const calendar = await loadCalendar(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');   // READ COMMITTED: each statement sees what committed before it started
    const out = await sendIn(client, uid, parsed.order, calendar);
    await client.query(out.status === 201 ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function sendIn(c: PoolClient, uid: string, req: SendRequest, calendar: Calendar): Promise<SendOutcome> {
  // 1. The clock, shared lock (D-021). A clock move holds it FOR UPDATE, so this send either commits before
  //    the runner starts the next event, or waits and then sees that event as started (events_through).
  const clock = (await c.query<ClockSqlRow>(`SELECT ${CLOCK_COLUMNS} FROM world_clock FOR SHARE`)).rows[0];
  if (!clock) return fail(409, 'NO_WORLD', 'the world has not started yet', SEND_REASONS.NO_WORLD);

  // 2. The player's portfolio, FOR UPDATE: one player's sends run one at a time, so the cash, units, rate
  //    limit and client id checks below can't be beaten by sending in parallel. Other players never wait.
  const portfolio = (await c.query<{ available_cash: string; equity: string }>(
    'SELECT available_cash, equity FROM portfolios WHERE uid = $1 FOR UPDATE',
    [uid],
  )).rows[0];
  if (!portfolio) return fail(404, 'NO_USER', 'user not found, call POST /me first');

  const security = (await c.query<{ market: Market }>('SELECT market FROM securities WHERE symbol = $1', [req.symbol])).rows[0];
  if (!security) return fail(404, 'UNKNOWN_SYMBOL', 'unknown symbol');

  // 3. A retried request (the response was lost): the same id and the same order get the stored order back,
  //    with no new row and no second reserve, whatever has happened to it since.
  if (req.clientOrderId !== null) {
    const prior = (await c.query<ViewRow & { amount_exact: string | null; units_exact: string | null }>(
      `SELECT ${VIEW_COLUMNS}, amount_ils AS amount_exact, units AS units_exact
       FROM orders WHERE uid = $1 AND client_order_id = $2`,
      [uid, req.clientOrderId],
    )).rows[0];
    if (prior) {
      const same = prior.symbol === req.symbol && prior.side === req.side
        && sameSize(prior.amount_exact, req.amount, SCALE.ILS) && sameSize(prior.units_exact, req.units, SCALE.UNITS);
      return same
        ? { status: 200, body: { order: toView(prior, security.market), replay: true } }
        : fail(409, 'CLIENT_ID_CONFLICT', 'clientOrderId was already used for a different order');
    }
  }

  // 4. The rate limit, in real time (D-021). Only stored orders count: a refused send writes nothing.
  const recent = (await c.query<{ created_at: Date; real_now: Date }>(
    `SELECT created_at, now() AS real_now FROM orders
     WHERE uid = $1 AND created_at > now() - make_interval(secs => $2)
     ORDER BY created_at DESC LIMIT $3`,
    [uid, RATE_LIMIT.windowSeconds, RATE_LIMIT.orders],
  )).rows;
  const wait = recent.length > 0 ? retryAfterSeconds(recent.map((r) => r.created_at), recent[0].real_now) : null;
  if (wait !== null) {
    return { ...fail(429, 'RATE_LIMITED', `too many orders: at most ${RATE_LIMIT.orders} per minute`, SEND_REASONS.RATE_LIMITED), retryAfter: wait };
  }

  // 5. When it would run, from the effective now: the same formula as the screens (loadNow), on the row we
  //    hold locked. An event the runner has started is already in the past.
  const now = effectiveNow(clock, calendar);
  const exec = executionFor(security.market, now, calendar);
  const late = checkTiming(now, exec.at, clock.ends_at);
  if (late) return fail(409, 'GAME_OVER', RULE_ERRORS.GAME_OVER, late.reason);

  // 6. What the rules need: the open position (locked for a sell: its units are about to be set aside),
  //    and for a buy, this player's pending buys of the same stock (D-028).
  const position = await loadPosition(c, uid, req.symbol, req.side === 'sell');
  const refusal = req.side === 'buy'
    ? checkSend({
        side: 'buy',
        amount: req.amount!,
        availableCash: parse(portfolio.available_cash, SCALE.ILS),
        equity: parse(portfolio.equity, SCALE.ILS),
        pendingBuys: await pendingBuys(c, uid, req.symbol),
        position: position?.held ?? null,
      })
    : checkSend({ side: 'sell', units: req.units!, position: position?.held ?? null });
  if (refusal) return fail(422, refusal.code, RULE_ERRORS[refusal.code], refusal.reason);

  // 7. The order, then what it sets aside: a reserve journal + reserved_cash (buy, D-019), or reserved_units (sell).
  const row = (await c.query<ViewRow>(
    `INSERT INTO orders (uid, symbol, side, amount_ils, units, placed_at, executes_at, price_type, client_order_id)
     VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $8, $9)
     RETURNING ${VIEW_COLUMNS}`,
    [
      uid, req.symbol, req.side,
      req.amount === null ? null : format(req.amount, SCALE.ILS),
      req.units === null ? null : format(req.units, SCALE.UNITS),
      now, exec.at, exec.priceType, req.clientOrderId,
    ],
  )).rows[0];

  if (req.side === 'buy') {
    const amount = format(req.amount!, SCALE.ILS);
    await insertJournal(c, uid, reserveJournal(row.id, req.amount!), now);
    await c.query('UPDATE portfolios SET reserved_cash = reserved_cash + $2::numeric WHERE uid = $1', [uid, amount]);
  } else {
    await c.query('UPDATE positions SET reserved_units = reserved_units + $2::numeric WHERE id = $1', [
      position!.id, format(req.units!, SCALE.UNITS),
    ]);
  }
  return { status: 201, body: { order: toView(row, security.market), replay: false } };
}

// Exact: the stored NUMERIC string against the requested bigint (both null for the side's other size).
function sameSize(stored: string | null, requested: bigint | null, scale: number): boolean {
  if (stored === null || requested === null) return stored === null && requested === null;
  return parse(stored, scale) === requested;
}

type PositionRow = {
  id: string;
  units: string;
  reserved_units: string;
  cost_basis_ils: string;
  avg_cost_ils: string;
  last_price: string | null;
  last_fx: string | null;
  market_value_ils: string | null;
};

async function loadPosition(c: PoolClient, uid: string, symbol: string, lock: boolean) {
  const { rows } = await c.query<PositionRow>(
    `SELECT id::text AS id, units, reserved_units, cost_basis_ils, avg_cost_ils, last_price, last_fx, market_value_ils
     FROM positions WHERE uid = $1 AND symbol = $2 AND status = 'open'${lock ? ' FOR UPDATE' : ''}`,
    [uid, symbol],
  );
  const r = rows[0];
  if (!r) return null;
  const maybe = (s: string | null, scale: number) => (s === null ? null : parse(s, scale));
  const held: HeldPosition = {
    units: parse(r.units, SCALE.UNITS),
    reservedUnits: parse(r.reserved_units, SCALE.UNITS),
    costBasis: parse(r.cost_basis_ils, SCALE.ILS),
    avgCost: parse(r.avg_cost_ils, SCALE.AVG_COST),
    lastPrice: maybe(r.last_price, SCALE.PRICE),
    lastRate: maybe(r.last_fx, SCALE.RATE),
    marketValue: maybe(r.market_value_ils, SCALE.ILS),
  };
  return { id: r.id, held };
}

async function pendingBuys(c: PoolClient, uid: string, symbol: string): Promise<bigint> {
  const { rows } = await c.query<{ total: string }>(
    `SELECT coalesce(sum(amount_ils), 0) AS total FROM orders
     WHERE uid = $1 AND symbol = $2 AND side = 'buy' AND status = 'pending'`,
    [uid, symbol],
  );
  return parse(rows[0].total, SCALE.ILS);
}

// One journal and its lines in one statement. The deferred trigger checks the balance at COMMIT (D-019).
async function insertJournal(c: PoolClient, uid: string, j: Journal, worldAt: Date): Promise<void> {
  await c.query(
    `WITH j AS (INSERT INTO journals (uid, kind, order_id, world_at) VALUES ($1, $2, $3, $4) RETURNING id)
     INSERT INTO ledger_entries (journal_id, uid, account, symbol, amount)
     SELECT j.id, $1, e.account, e.symbol, e.amount
     FROM j CROSS JOIN unnest($5::text[], $6::text[], $7::numeric[]) AS e (account, symbol, amount)`,
    [
      uid, j.kind, j.orderId, worldAt,
      j.entries.map((e) => e.account),
      j.entries.map((e) => e.symbol),
      j.entries.map((e) => format(e.amount, SCALE.ILS)),
    ],
  );
}
