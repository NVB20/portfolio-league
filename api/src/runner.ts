// The runner (D-021, D-029): runs every market open and close in time order. At each one it executes the
// orders due then (checking the ledger of the players it trades), re-values only the players that event
// affects, and closes the event with the daily chart rows, the median player line and the leaderboard.
//
// Postgres is the queue. One runner at a time (a session advisory lock). Every step is a short transaction
// that can be re-run after a crash at any point and changes nothing twice:
//   start   the market_events row exists; world_clock.events_through moves up to the event
//   step 1  orders, while the event is 'pending': first the stops this event's price reached become sells due
//           now (D-037, triggerStops); then due orders in batches through the pure engine; their money,
//           positions and status change in one transaction, so a re-run never finds them pending again; each
//           batch checks its own players' ledger in that transaction
//   step 2  affected players, while 'orders_done': re-mark and fold into the week, online players first;
//           portfolios.last_event_at is the guard that makes a re-run skip players already done
//   step 3  finish: the daily chart rows in pages, then ONE transaction: the median, the scoring (scoring.ts,
//           D-034: the day's standings, and weekly_scores at the week's last event) and → 'done'. A crash before
//           its commit leaves the event 'orders_done', and the re-run scores it again. After the commit, ANALYZE
//           of the board when it wrote a new day or weekly rows (a failure is logged, not thrown)
// The game rules live in game/ (engine.ts, week.ts, clock.ts, score.ts); this file loads, calls and writes.

import type { Pool, PoolClient } from 'pg';
import { eventsBetween } from './game/clock.js';
import {
  type DueOrder,
  type EventInput,
  executeOrders,
  type ExecuteResult,
  type OrderResult,
  type PortfolioState,
  type PositionState,
} from './game/engine.js';
import { format, parse, RATE_ONE, SCALE } from './game/fixed.js';
import { type Calendar, makeCalendar, type Market, type MarketEvent } from './game/marketHours.js';
import { isLastEventOfWeek } from './game/score.js';
import { type ActiveStop, planStops, stopFires, type StopPosition } from './game/stops.js';
import { addDays, ISRAEL, zonedToInstant } from './game/time.js';
import { applyEvent, markPositions, median, startWeek, totals, type WeekState, weekOf } from './game/week.js';
import { ONLINE_MINUTES } from './presence.js';
import { analyzeBoard, scoreEvent } from './scoring.js';

// The pg_advisory_lock key of the runner. Any fixed number; nothing else in the app takes advisory locks.
export const RUNNER_LOCK_KEY = 20_261_110;

const DEFAULT_ORDER_BATCH = 500;
const DEFAULT_PLAYER_BATCH = 5_000;
// eventsBetween scans at most ~400 days; a far target is listed in slices so no event is ever dropped.
const LIST_SLICE_MS = 60 * 86_400_000;
// market_events.duration_ms is an INTEGER; a run resumed weeks after a crash must not overflow it.
const MAX_DURATION_MS = 2_147_483_647;
// The statement timeout of a run (withRunnerLock). The API's pool cancels any statement after 10 s, which is
// right for a player's request. A runner step that grows past that at scale would fail on every tick, and every
// later event waits behind an unfinished one: the game would stop for good. Minutes still end a stuck statement.
const RUNNER_STATEMENT_TIMEOUT = '5min';

export type RunOptions = { orderBatch?: number; playerBatch?: number };
export type RunSummary = { events: number; ordersExecuted: number; ordersRejected: number; playersUpdated: number };

export type EventStatus = 'pending' | 'orders_done' | 'done';
export type EventRow = { id: string; market: Market; kind: 'open' | 'close'; day: string; at: Date; status: EventStatus };
// An event with its prices (D-029): this market's open or close of the day, and the USD/ILS rate for a US event.
export type PricedEvent = EventRow & { prices: Map<string, bigint>; rate: bigint };

type Db = Pool | PoolClient;

// ---------- the lock ----------

// Holds a session advisory lock on ONE dedicated client for the whole run; null when another runner holds it.
// The run gets its own statement timeout (RUNNER_STATEMENT_TIMEOUT) on that client.
export async function withRunnerLock<T>(db: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T | null> {
  const client = await db.connect();
  let broken = false;
  // The run holds this connection for minutes. If the database ends the session (a restart, a failover),
  // node-postgres emits 'error' on the client, and the pool doesn't listen while a client is checked out:
  // unheard, Node would throw it and end the whole API process. Heard, the run's query simply fails, the
  // ticker logs it and the next tick resumes the event (D-021, D-030). The server drops the lock with the
  // session. The API's own pool listens to every client too (db.ts); this one doesn't depend on that.
  const onError = (err: Error) => {
    broken = true;
    console.error('runner: the database connection was lost', err.message);
  };
  client.on('error', onError);
  try {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [RUNNER_LOCK_KEY]);
    if (!rows[0].ok) return null;
    try {
      await client.query(`SET statement_timeout = '${RUNNER_STATEMENT_TIMEOUT}'`);
      return await fn(client);
    } finally {
      // The pool's own timeout comes back (RESET = the value the connection started with), and the session lock,
      // which outlives transactions, is let go by hand. If either fails, the connection is thrown away instead of
      // going back to the pool: closing the session drops the lock and the setting.
      await client.query('RESET statement_timeout').catch(() => {
        broken = true;
      });
      await client.query('SELECT pg_advisory_unlock($1)', [RUNNER_LOCK_KEY]).catch(() => {
        broken = true;
      });
    }
  } finally {
    client.removeListener('error', onError);
    client.release(broken);
  }
}

// ---------- running events ----------

// Finishes any unfinished event first, then starts and runs every event up to `target`, in time order.
// The listing starts 1 ms before world_clock.events_through (or now_at when nothing has run yet), so an event
// at the same instant as the last one started still runs; one already done is skipped by its status.
// Never runs past world_clock.ends_at: there are no prices after it.
export async function runUntil(client: PoolClient, target: Date, opts: RunOptions = {}): Promise<RunSummary> {
  const total = emptySummary();
  const clock = await client.query<{ now_at: Date; ends_at: Date | null; events_through: Date | null }>(
    'SELECT now_at, ends_at, events_through FROM world_clock',
  );
  if (clock.rows.length === 0) return total;   // the world hasn't started
  const calendar = await loadCalendarWith(client);

  const unfinished = await client.query<EventSqlRow>(
    `SELECT ${EVENT_COLUMNS} FROM market_events WHERE status <> 'done' ORDER BY at, kind = 'open', market_events.id`,
  );
  for (const row of unfinished.rows) addTo(total, await runEvent(client, toEventRow(row), opts, calendar));

  const { now_at: nowAt, ends_at: endsAt, events_through: through } = clock.rows[0];
  const end = endsAt !== null && endsAt < target ? endsAt : target;
  let cursor = new Date((through ?? nowAt).getTime() - 1);
  while (cursor < end) {
    const sliceEnd = new Date(Math.min(end.getTime(), cursor.getTime() + LIST_SLICE_MS));
    for (const e of eventsBetween(cursor, sliceEnd, calendar)) {
      if (through !== null && e.at <= through && (await findEvent(client, e))?.status === 'done') continue;
      const row = await startEvent(client, e);
      addTo(total, await runEvent(client, row, opts, calendar));
    }
    cursor = sliceEnd;
  }
  return total;
}

// The exclusive side of the clock lock (D-021), for every writer of the clock row: the event start, the admin's
// clock moves and the ticker's heartbeat. Order sending holds the row FOR SHARE. A row lock alone isn't queued
// fairly: Postgres grants a new FOR SHARE on a row that only share lockers hold even while a FOR UPDATE waits,
// so overlapping sends could keep a writer waiting for ever (until the statement timeout cancels it). A table
// lock in EXCLUSIVE mode is queued in the regular lock manager: a send that arrives after it (FOR SHARE needs
// ROW SHARE on the table) waits behind it, so a writer waits only for the sends already in flight. Plain
// SELECTs of the clock (the screens) take ACCESS SHARE and never wait. Inside a transaction only.
export async function lockClock(client: PoolClient): Promise<void> {
  await client.query('LOCK TABLE world_clock IN EXCLUSIVE MODE');
}

// Start (one short transaction): the event's row exists and events_through covers it. The clock is locked
// exclusively (lockClock), and order sending holds it FOR SHARE (D-021): an order being sent right now either
// commits before this (and runs at this event) or sees the new events_through (and runs after it).
export async function startEvent(client: PoolClient, e: MarketEvent): Promise<EventRow> {
  return inTransaction(client, async () => {
    await lockClock(client);
    const clock = await client.query('SELECT 1 FROM world_clock');
    if (clock.rowCount === 0) throw new Error('no world_clock row: the world has not started');
    const { rows } = await client.query<EventSqlRow>(
      `INSERT INTO market_events (market, kind, day, at, started_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (market, kind, day) DO UPDATE SET started_at = COALESCE(market_events.started_at, EXCLUDED.started_at)
       RETURNING ${EVENT_COLUMNS}`,
      [e.market, e.kind, e.day, e.at],
    );
    await client.query('UPDATE world_clock SET events_through = GREATEST(events_through, $1)', [rows[0].at]);
    return toEventRow(rows[0]);
  });
}

// Runs one started event from wherever it stopped: its status in the database decides the step.
export async function runEvent(
  client: PoolClient,
  eventRow: EventRow,
  opts: RunOptions = {},
  calendar?: Calendar,
): Promise<RunSummary> {
  const summary = emptySummary();
  const fresh = await client.query<EventSqlRow>(`SELECT ${EVENT_COLUMNS} FROM market_events WHERE id = $1`, [eventRow.id]);
  if (fresh.rows.length === 0) throw new Error(`market event ${eventRow.id} does not exist`);
  const row = toEventRow(fresh.rows[0]);
  if (row.status === 'done') return summary;

  summary.events = 1;
  const orderBatch = batchSize(opts.orderBatch, DEFAULT_ORDER_BATCH);
  const playerBatch = batchSize(opts.playerBatch, DEFAULT_PLAYER_BATCH);
  const event = await loadEventPrices(client, row);

  if (event.status === 'pending') {
    // Stops first (D-037): a stop this event's price reached becomes a sell due now, which the batches below run.
    await triggerStops(client, event, orderBatch);
    for (;;) {
      const r = await runOrderBatch(client, event, orderBatch);
      summary.ordersExecuted += r.executed;
      summary.ordersRejected += r.rejected;
      if (r.done) break;
    }
  }
  summary.playersUpdated += await updateAffectedPlayers(client, event, playerBatch);
  await finishEvent(client, event, calendar ?? (await loadCalendarWith(client)), playerBatch);
  return summary;
}

// ---------- prices ----------

// D-029: this market's open (open event) or close (close event) of the day. US: the USD/ILS open or close of
// the same day; a day with no rate row uses the latest earlier close; no rate at all = no prices for the event
// (its orders are rejected NO_PRICE and nobody is re-marked). TASE prices are already in ₪.
export async function loadEventPrices(db: Db, e: EventRow): Promise<PricedEvent> {
  const noPrices = { ...e, prices: new Map<string, bigint>(), rate: RATE_ONE };
  let rate = RATE_ONE;
  if (e.market === 'US') {
    const fx = await db.query<{ rate: string }>(
      `SELECT (CASE WHEN day = $1::date AND $2 = 'open' THEN open ELSE close END)::text AS rate
       FROM usd_ils WHERE day <= $1::date ORDER BY day DESC LIMIT 1`,
      [e.day, e.kind],
    );
    if (fx.rows.length === 0) return noPrices;
    rate = parse(fx.rows[0].rate, SCALE.RATE);
  }
  const { rows } = await db.query<{ symbol: string; price: string }>(
    `SELECT p.symbol, (CASE WHEN $3 = 'open' THEN p.open ELSE p.close END)::text AS price
     FROM prices p JOIN securities s ON s.symbol = p.symbol
     WHERE s.market = $1 AND p.day = $2::date`,
    [e.market, e.day, e.kind],
  );
  return { ...e, prices: new Map(rows.map((r) => [r.symbol, parse(r.price, SCALE.PRICE)])), rate };
}

// ---------- step 1: orders ----------

// One batch of due orders in one transaction. `done` = no due order is left, and the event is now 'orders_done'
// (set in the same transaction as the last batch). Orders whose executes_at is earlier than this event (a missed
// one) run here, late, rather than never.
export async function runOrderBatch(
  client: PoolClient,
  event: PricedEvent,
  batch: number,
): Promise<{ executed: number; rejected: number; done: boolean }> {
  return inTransaction(client, async () => {
    const due = await client.query<OrderSqlRow>(
      `SELECT o.id::text AS id, o.uid, o.symbol, s.market, o.side, o.amount_ils::text AS amount_ils,
              o.units::text AS units, o.executes_at, o.stop_price::text AS stop_price
       FROM orders o JOIN securities s ON s.symbol = o.symbol
       WHERE o.status = 'pending' AND o.executes_at <= $1 AND s.market = $2
       ORDER BY o.executes_at, o.id
       LIMIT $3
       FOR UPDATE OF o`,
      [event.at, event.market, batch],
    );
    const done = due.rows.length < batch;
    if (due.rows.length === 0) {
      await markOrdersDone(client, event.id);
      return { executed: 0, rejected: 0, done };
    }

    const orders = due.rows.map(toDueOrder);
    const uids = [...new Set(orders.map((o) => o.uid))].sort();
    // uid order, so two transactions locking the same players can't deadlock.
    const locked = await client.query<PortfolioSqlRow>(
      `SELECT ${PORTFOLIO_COLUMNS} FROM portfolios WHERE uid = ANY($1) ORDER BY uid FOR UPDATE`,
      [uids],
    );
    // ALL open positions, both markets: the 20% check needs the whole portfolio.
    const held = await loadOpenPositions(client, uids);

    const before = new Map<string, PortfolioState>();
    const weeks = new Map<string, WeekState>();
    for (const r of locked.rows) {
      before.set(r.uid, toPortfolio(r, held.get(r.uid) ?? []));
      // A trade at the first event of a week starts the week from the value BEFORE the trade (D-024).
      weeks.set(r.uid, startWeek(toWeek(r), event.at, parse(r.equity, SCALE.ILS)));
    }

    const out = executeOrders(toEventInput(event), orders, before);
    const executed = out.results.filter((r) => r.status === 'executed').length;
    const rejected = out.results.length - executed;

    await writeJournals(client, event, out);
    const positionIds = await writePositions(client, out, held);
    await writeOrders(client, event, out.results, positionIds);
    // A position that closed here (sold by hand, or by one of its stops) takes its other stops with it: the
    // database expires them as the position closes (trigger positions_close_stops, D-037).
    await writeStops(client, event, out.results, stopPrices(due.rows), positionIds);
    await writeTradedPortfolios(client, out, weeks);

    // The ledger check (D-019, D-029) for this batch's players, in its transaction: their rows are locked, so
    // nothing else can change them in between, and the check costs at most `batch` players' history however
    // big the event is (one statement over every player of a big event passed the statement timeout). A
    // mismatch is logged and stored, and the game carries on. It stays false; a clean batch never resets it.
    const bad = await ledgerMismatches(client, uids);
    if (bad.length > 0) {
      console.error(`ledger check failed at the ${event.market} ${event.kind} of ${event.day} for: ${bad.join(', ')}`);
    }
    await client.query(
      `UPDATE market_events
       SET orders_executed = orders_executed + $2, orders_rejected = orders_rejected + $3,
           status = CASE WHEN $4 AND status = 'pending' THEN 'orders_done' ELSE status END,
           ledger_balanced = CASE WHEN $5 THEN FALSE ELSE ledger_balanced END
       WHERE id = $1`,
      [event.id, executed, rejected, done, bad.length > 0],
    );
    return { executed, rejected, done };
  });
}

async function markOrdersDone(client: PoolClient, eventId: string): Promise<void> {
  await client.query(`UPDATE market_events SET status = 'orders_done' WHERE id = $1 AND status = 'pending'`, [eventId]);
}

// ---------- step 1, first: stops (D-037) ----------

type StopSqlRow = {
  id: string; uid: string; symbol: string; position_id: string; stop_price: string; units: string; activation_price: string;
};

// The stops this event fires become pending sells due at this event (origin 'stop'); runOrderBatch then runs them
// at this event's price like any other sell. A stop fires when this event's open or close is at or below it
// (stopFires, game/stops.ts): checked only at the open and the close. Only stops activated by an EARLIER event: a
// stop made at this event (its buy filled here) is first checked at the next one, also when this runs again after a
// crash. A batch of `batch` stops per transaction; a fired or expired stop is no longer active, so a re-run never
// fires it twice. Paged by id, so the stops that wait don't keep coming back. Returns how many stops fired.
//
// The stops are planned once per event, before its orders: once an order batch of the event has committed, a re-run
// (after a crash, a restart, a failed batch) skips this step. Planning again then would see positions those batches
// already changed (a buy merged in, a hand sell gone) and could fire a stop that rightly waited the first time, so the
// same event would give a different result after a crash (D-021). Re-running between two pages of this step, before
// any batch, plans the same: these pages only lock more units, so a stop that waited still waits.
export async function triggerStops(client: PoolClient, event: PricedEvent, batch: number): Promise<number> {
  if (event.prices.size === 0) return 0;   // no prices (a US day with no rate): nothing to compare
  // An order batch commits its counts with its orders (runOrderBatch), so counts above 0 = the stops were planned.
  const ran = await client.query<{ n: number }>(
    'SELECT (orders_executed + orders_rejected)::int AS n FROM market_events WHERE id = $1',
    [event.id],
  );
  if ((ran.rows[0]?.n ?? 0) > 0) return 0;
  const symbols = [...event.prices.keys()];
  const prices = symbols.map((s) => format(event.prices.get(s)!, SCALE.PRICE));
  let after = '0';
  let fired = 0;
  for (;;) {
    const page = await inTransaction(client, async () => {
      const { rows } = await client.query<StopSqlRow>(
        `SELECT so.id::text AS id, so.uid, so.symbol, so.position_id::text AS position_id,
                so.stop_price::text AS stop_price, so.units::text AS units, so.activation_price::text AS activation_price
         FROM stop_orders so
         JOIN unnest($1::text[], $2::numeric[]) AS ep (symbol, price) ON ep.symbol = so.symbol
         WHERE so.status = 'active' AND so.activated_at < $3 AND so.id > $4::bigint
           AND (ep.price <= so.stop_price OR so.activation_price <= so.stop_price)
         ORDER BY so.id
         LIMIT $5
         FOR UPDATE OF so`,
        [symbols, prices, event.at, after, batch],
      );
      if (rows.length === 0) return { count: 0, last: after, sold: 0 };
      const stops = rows.map(toActiveStop).filter((s) => stopFires(s.stopPrice, s.activationPrice, event.prices.get(s.symbol)));

      // The players first, in uid order, like runOrderBatch and order sending: their positions are about to change.
      const uids = [...new Set(stops.map((s) => s.uid))].sort();
      await client.query('SELECT 1 FROM portfolios WHERE uid = ANY($1) ORDER BY uid FOR UPDATE', [uids]);
      const held = await client.query<{ id: string; status: 'open' | 'closed'; units: string; reserved_units: string }>(
        `SELECT id::text AS id, status, units::text AS units, reserved_units::text AS reserved_units
         FROM positions WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
        [[...new Set(stops.map((s) => s.positionId))]],
      );
      const positions = new Map<string, StopPosition>(held.rows.map((r) => [
        r.id,
        { status: r.status, units: parse(r.units, SCALE.UNITS), reservedUnits: parse(r.reserved_units, SCALE.UNITS) },
      ]));

      const plans = planStops(stops, positions);
      const byId = new Map(stops.map((s) => [s.id, s]));
      const sells = plans.flatMap((p) => (p.action === 'sell' ? [{ stop: byId.get(p.stopId)!, units: p.units }] : []));
      const expired = plans.flatMap((p) => (p.action === 'expire' ? [p.stopId] : []));

      if (sells.length > 0) {
        const made = await client.query<{ id: string; stop_id: string }>(
          `INSERT INTO orders (uid, symbol, side, units, placed_at, executes_at, price_type, origin, stop_id)
           SELECT t.uid, t.symbol, 'sell', t.units, $5, $5, $6, 'stop', t.stop_id
           FROM unnest($1::text[], $2::text[], $3::numeric[], $4::bigint[]) AS t (uid, symbol, units, stop_id)
           RETURNING id::text AS id, stop_id::text AS stop_id`,
          [
            sells.map((s) => s.stop.uid),
            sells.map((s) => s.stop.symbol),
            sells.map((s) => format(s.units, SCALE.UNITS)),
            sells.map((s) => s.stop.id),
            event.at,
            event.kind,
          ],
        );
        // The sold units are locked like a hand sell's (orders.ts): no selling them twice.
        const lock = new Map<string, bigint>();
        for (const s of sells) lock.set(s.stop.positionId, (lock.get(s.stop.positionId) ?? 0n) + s.units);
        await client.query(
          `UPDATE positions p SET reserved_units = p.reserved_units + t.units
           FROM unnest($1::bigint[], $2::numeric[]) AS t (id, units) WHERE p.id = t.id`,
          [[...lock.keys()], [...lock.values()].map((u) => format(u, SCALE.UNITS))],
        );
        const res = await client.query(
          `UPDATE stop_orders so SET status = 'triggered', sell_order_id = t.order_id, ended_at = $3, event_id = $4
           FROM unnest($1::bigint[], $2::bigint[]) AS t (id, order_id)
           WHERE so.id = t.id AND so.status = 'active'`,
          [made.rows.map((r) => r.stop_id), made.rows.map((r) => r.id), event.at, event.id],
        );
        if (res.rowCount !== sells.length) throw new Error(`expected ${sells.length} active stops to fire, found ${res.rowCount}`);
      }
      if (expired.length > 0) {
        await client.query(
          `UPDATE stop_orders SET status = 'expired', ended_at = $2, event_id = $3 WHERE id = ANY($1::bigint[]) AND status = 'active'`,
          [expired, event.at, event.id],
        );
      }
      return { count: rows.length, last: rows[rows.length - 1].id, sold: sells.length };
    });
    fired += page.sold;
    after = page.last;
    if (page.count < batch) return fired;
  }
}

function toActiveStop(r: StopSqlRow): ActiveStop {
  return {
    id: r.id,
    uid: r.uid,
    symbol: r.symbol,
    positionId: r.position_id,
    stopPrice: parse(r.stop_price, SCALE.PRICE),
    units: parse(r.units, SCALE.UNITS),
    activationPrice: parse(r.activation_price, SCALE.PRICE),
  };
}

// One INSERT for the journals and their entries, joined by order id (the runner writes at most one journal per
// order: buy, sell or release). The deferred trigger checks at commit that each one balances.
async function writeJournals(client: PoolClient, event: EventRow, out: ExecuteResult): Promise<void> {
  if (out.journals.length === 0) return;
  const j = { uid: [] as string[], kind: [] as string[], order: [] as string[] };
  const e = { order: [] as string[], account: [] as string[], symbol: [] as (string | null)[], amount: [] as string[] };
  const seen = new Set<string>();
  for (const { uid, journal } of out.journals) {
    const orderId = journal.orderId;
    if (orderId === null || seen.has(orderId)) throw new Error(`order ${orderId} has more than one journal in one run`);
    seen.add(orderId);
    j.uid.push(uid);
    j.kind.push(journal.kind);
    j.order.push(orderId);
    for (const entry of journal.entries) {
      e.order.push(orderId);
      e.account.push(entry.account);
      e.symbol.push(entry.symbol);
      e.amount.push(format(entry.amount, SCALE.ILS));
    }
  }
  await client.query(
    `WITH j AS (
       INSERT INTO journals (uid, kind, order_id, world_at)
       SELECT t.uid, t.kind, t.order_id, $4 FROM unnest($1::text[], $2::text[], $3::bigint[]) AS t (uid, kind, order_id)
       RETURNING id, uid, order_id
     )
     INSERT INTO ledger_entries (journal_id, uid, account, symbol, amount)
     SELECT j.id, j.uid, x.account, x.symbol, x.amount
     FROM unnest($5::bigint[], $6::text[], $7::text[], $8::numeric[]) AS x (order_id, account, symbol, amount)
     JOIN j ON j.order_id = x.order_id`,
    [j.uid, j.kind, j.order, event.at, e.order, e.account, e.symbol, e.amount],
  );
}

// A position's life within one run: from its first fill (an existing row, or a buy from 0 units) until it
// closes. A sale of everything followed by a new buy of the same stock is two lives: two rows.
type Life = { uid: string; symbol: string; dbId: string | null; orderIds: string[]; last: PositionState };

function lives(results: readonly OrderResult[]): Life[] {
  const all: Life[] = [];
  const current = new Map<string, Life>();
  for (const r of results) {
    if (r.status !== 'executed') continue;
    const key = `${r.uid}|${r.symbol}`;
    let life = current.get(key);
    if (!life || life.last.status === 'closed' || life.dbId !== r.position.id) {
      life = { uid: r.uid, symbol: r.symbol, dbId: r.position.id, orderIds: [], last: r.position };
      all.push(life);
      current.set(key, life);
    }
    life.orderIds.push(r.orderId);
    life.last = r.position;
  }
  return all;
}

// Writes every position the batch changed. Existing rows (incl. the ones closing) are updated FIRST, then new
// ones inserted: the unique open (uid, symbol) index needs the old row closed before a new one opens. A position
// opened and closed in the same run is inserted as closed. Returns order id → position id for the fills.
async function writePositions(
  client: PoolClient,
  out: ExecuteResult,
  held: Map<string, PositionState[]>,
): Promise<Map<string, string>> {
  const loaded = new Map<string, PositionState>();
  for (const list of held.values()) for (const p of list) loaded.set(p.id!, p);

  // Existing rows: their final state is the open one in the new portfolio, or the closed one.
  const changed: PositionState[] = [];
  for (const portfolio of out.portfolios.values()) {
    for (const p of portfolio.positions) if (p.id !== null && !samePosition(loaded.get(p.id), p)) changed.push(p);
  }
  for (const p of out.closed) if (p.id !== null) changed.push(p);
  if (changed.length > 0) {
    const c = await positionArrays(changed);
    await client.query(
      `UPDATE positions p SET
         status = t.status, units = t.units, reserved_units = t.reserved_units, avg_cost_ils = t.avg_cost,
         cost_basis_ils = t.cost_basis, realized_pnl_ils = t.realized, last_price = t.last_price, last_fx = t.last_fx,
         market_value_ils = t.market_value, unrealized_pnl_ils = t.unrealized, marked_at = t.marked_at,
         closed_at = t.closed_at
       FROM unnest($1::bigint[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[],
                   $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::timestamptz[], $13::timestamptz[])
         AS t (id, status, units, reserved_units, avg_cost, cost_basis, realized, last_price, last_fx, market_value,
               unrealized, marked_at, closed_at)
       WHERE p.id = t.id`,
      [c.id, c.status, c.units, c.reserved, c.avgCost, c.costBasis, c.realized, c.lastPrice, c.lastFx, c.marketValue,
        c.unrealized, c.markedAt, c.closedAt],
    );
  }

  // New rows: one per life that started from 0 units. Their final state is the closed fill, or the open position
  // left in the portfolio (a later rejected sell may have touched it).
  const all = lives(out.results);
  const fresh = all.filter((l) => l.dbId === null).map((l) => {
    if (l.last.status === 'closed') return { life: l, p: l.last };
    const open = out.portfolios.get(l.uid)?.positions.find((p) => p.id === null && p.symbol === l.symbol);
    if (!open) throw new Error(`new ${l.symbol} position of ${l.uid} is missing from the portfolio`);
    return { life: l, p: open };
  });
  const ids = new Map<Life, string>();
  if (fresh.length > 0) {
    // Ids are taken from the identity's sequence first, so each new row's id is known without matching rows back.
    const seq = await client.query<{ id: string }>(
      `SELECT nextval(pg_get_serial_sequence('positions', 'id'))::text AS id FROM generate_series(1, $1)`,
      [fresh.length],
    );
    fresh.forEach((f, i) => ids.set(f.life, seq.rows[i].id));
    const c = await positionArrays(fresh.map((f) => f.p));
    await client.query(
      `INSERT INTO positions (id, uid, symbol, status, units, reserved_units, avg_cost_ils, cost_basis_ils,
                              realized_pnl_ils, last_price, last_fx, market_value_ils, unrealized_pnl_ils, marked_at,
                              opened_at, closed_at)
       OVERRIDING SYSTEM VALUE
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[],
                            $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[],
                            $13::numeric[], $14::timestamptz[], $15::timestamptz[], $16::timestamptz[])`,
      [fresh.map((f) => ids.get(f.life)!), fresh.map((f) => f.life.uid), fresh.map((f) => f.p.symbol), c.status,
        c.units, c.reserved, c.avgCost, c.costBasis, c.realized, c.lastPrice, c.lastFx, c.marketValue, c.unrealized,
        c.markedAt, c.openedAt, c.closedAt],
    );
  }

  const byOrder = new Map<string, string>();
  for (const l of all) for (const orderId of l.orderIds) byOrder.set(orderId, l.dbId ?? ids.get(l)!);
  return byOrder;
}

async function writeOrders(
  client: PoolClient,
  event: EventRow,
  results: readonly OrderResult[],
  positionIds: Map<string, string>,
): Promise<void> {
  const executed = results.filter((r): r is Extract<OrderResult, { status: 'executed' }> => r.status === 'executed');
  const rejected = results.filter((r): r is Extract<OrderResult, { status: 'rejected' }> => r.status === 'rejected');
  if (executed.length > 0) {
    const res = await client.query(
      `UPDATE orders o SET status = 'executed', fill_price = t.fill_price, fx_rate = t.fx_rate,
         filled_units = t.filled_units, filled_ils = t.filled_ils, realized_pnl_ils = t.realized,
         position_id = t.position_id, executed_at = $8, event_id = $9
       FROM unnest($1::bigint[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::bigint[])
         AS t (id, fill_price, fx_rate, filled_units, filled_ils, realized, position_id)
       WHERE o.id = t.id AND o.status = 'pending'`,
      [
        executed.map((r) => r.orderId),
        executed.map((r) => format(r.fillPrice, SCALE.PRICE)),
        executed.map((r) => fmt(r.rate, SCALE.RATE)),
        executed.map((r) => format(r.filledUnits, SCALE.UNITS)),
        executed.map((r) => format(r.filledIls, SCALE.ILS)),
        executed.map((r) => fmt(r.realizedPnl, SCALE.ILS)),
        executed.map((r) => {
          const id = positionIds.get(r.orderId);
          if (!id) throw new Error(`order ${r.orderId} filled into no position`);
          return id;
        }),
        event.at,
        event.id,
      ],
    );
    if (res.rowCount !== executed.length) throw new Error(`expected ${executed.length} pending orders to execute, found ${res.rowCount}`);
  }
  if (rejected.length > 0) {
    const res = await client.query(
      `UPDATE orders o SET status = 'rejected', reject_reason = t.reason, reject_code = t.code, event_id = $4
       FROM unnest($1::bigint[], $2::text[], $3::text[]) AS t (id, reason, code)
       WHERE o.id = t.id AND o.status = 'pending'`,
      [rejected.map((r) => r.orderId), rejected.map((r) => r.reason), rejected.map((r) => r.code), event.id],
    );
    if (res.rowCount !== rejected.length) throw new Error(`expected ${rejected.length} pending orders to reject, found ${res.rowCount}`);
  }
}

// D-037: a filled buy that carried a stop makes the stop, for the units it got, active from the next event on.
// A rejected buy makes none. In the batch's transaction, so a re-run never finds the buy pending again. A stop on
// a position that already closed in this batch is stored expired (trigger stop_orders_closed_position).
async function writeStops(
  client: PoolClient,
  event: EventRow,
  results: readonly OrderResult[],
  stops: ReadonlyMap<string, string>,   // buy order id → its stop_price, as stored
  positionIds: Map<string, string>,
): Promise<void> {
  const made = results.filter((r): r is Extract<OrderResult, { status: 'executed' }> =>
    r.status === 'executed' && r.side === 'buy' && stops.has(r.orderId) && r.filledUnits > 0n);
  if (made.length === 0) return;
  await client.query(
    `INSERT INTO stop_orders (uid, symbol, buy_order_id, position_id, stop_price, units, activation_price, activated_at)
     SELECT t.uid, t.symbol, t.buy_order_id, t.position_id, t.stop_price, t.units, t.activation_price, $8
     FROM unnest($1::text[], $2::text[], $3::bigint[], $4::bigint[], $5::numeric[], $6::numeric[], $7::numeric[])
       AS t (uid, symbol, buy_order_id, position_id, stop_price, units, activation_price)
     ON CONFLICT (buy_order_id) DO NOTHING`,
    [
      made.map((r) => r.uid),
      made.map((r) => r.symbol),
      made.map((r) => r.orderId),
      made.map((r) => positionIds.get(r.orderId)!),
      made.map((r) => stops.get(r.orderId)!),
      made.map((r) => format(r.filledUnits, SCALE.UNITS)),
      made.map((r) => format(r.fillPrice, SCALE.PRICE)),
      event.at,
    ],
  );
}

function stopPrices(rows: readonly OrderSqlRow[]): Map<string, string> {
  return new Map(rows.flatMap((r): [string, string][] => (r.side === 'buy' && r.stop_price !== null ? [[r.id, r.stop_price]] : [])));
}

// Cash, reserved cash, realized gain, the totals of the new open positions and the started week. Not
// last_event_at: step 2 re-marks the player at this event and sets it.
async function writeTradedPortfolios(
  client: PoolClient,
  out: ExecuteResult,
  weeks: Map<string, WeekState>,
): Promise<void> {
  const rows = [...out.portfolios.values()].map((p) => ({ p, t: totals(p.cash, p.positions), w: weeks.get(p.uid)! }));
  await client.query(
    `UPDATE portfolios p SET cash = t.cash, reserved_cash = t.reserved_cash, realized_pnl = t.realized,
       holdings_value = t.holdings_value, unrealized_pnl = t.unrealized, week_start = t.week_start,
       week_start_value = t.week_start_value, peak_value = t.peak_value, max_drawdown_pct = t.max_drawdown_pct
     FROM unnest($1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::date[],
                 $8::numeric[], $9::numeric[], $10::numeric[])
       AS t (uid, cash, reserved_cash, realized, holdings_value, unrealized, week_start, week_start_value, peak_value,
             max_drawdown_pct)
     WHERE p.uid = t.uid`,
    [
      rows.map((r) => r.p.uid),
      rows.map((r) => format(r.p.cash, SCALE.ILS)),
      rows.map((r) => format(r.p.reservedCash, SCALE.ILS)),
      rows.map((r) => format(r.p.realizedPnl, SCALE.ILS)),
      rows.map((r) => format(r.t.holdingsValue, SCALE.ILS)),
      rows.map((r) => format(r.t.unrealizedPnl, SCALE.ILS)),
      rows.map((r) => r.w.weekStart),
      rows.map((r) => fmt(r.w.weekStartValue, SCALE.ILS)),
      rows.map((r) => fmt(r.w.peakValue, SCALE.ILS)),
      rows.map((r) => format(r.w.maxDrawdownPct, SCALE.PCT)),
    ],
  );
}

// ---------- step 2: affected players ----------

// Everyone with an open position in this market, plus everyone whose order executed at this event (a sale of
// everything leaves no position but changes the value). Cash-only players and players holding only the other
// market are never touched (D-021, D-024). Two passes, online players first; the second pass skips players the
// first already updated through the last_event_at guard. Returns the players updated.
export async function updateAffectedPlayers(client: PoolClient, event: PricedEvent, batch: number): Promise<number> {
  let updated = 0;
  for (const onlineOnly of [true, false]) {
    let after = '';
    for (;;) {
      const uids = await affectedPage(client, event, after, batch, onlineOnly);
      if (uids.length === 0) break;
      updated += await updatePlayers(client, event, uids);
      if (uids.length < batch) break;
      after = uids[uids.length - 1];
    }
  }
  return updated;
}

// One page of affected players with uid > `after`, in uid order (never every id at once). The everyone pass
// takes at most `limit` uids from each stock's slice of positions_open_symbol_idx, so a page reads about
// (stocks + 1) × limit index rows however many players there are. The online pass starts from the few players
// online now (users_last_seen_idx) and keeps those the same rule affects.
export async function affectedPage(
  db: Db,
  event: EventRow,
  after: string,
  limit: number,
  onlineOnly: boolean,
): Promise<string[]> {
  const sql = onlineOnly
    ? `SELECT u.uid FROM users u
       WHERE u.last_seen_at > now() - make_interval(mins => $5) AND u.uid > $3
         AND (EXISTS (SELECT 1 FROM positions p JOIN securities s ON s.symbol = p.symbol
                      WHERE p.uid = u.uid AND p.status = 'open' AND s.market = $1)
              OR EXISTS (SELECT 1 FROM orders o WHERE o.uid = u.uid AND o.event_id = $2 AND o.status = 'executed'))
       ORDER BY u.uid LIMIT $4`
    : `SELECT uid FROM (
         SELECT x.uid FROM securities s
         CROSS JOIN LATERAL (
           SELECT p.uid FROM positions p
           WHERE p.symbol = s.symbol AND p.status = 'open' AND p.uid > $3
           ORDER BY p.uid LIMIT $4
         ) x
         WHERE s.market = $1
         UNION
         (SELECT DISTINCT o.uid FROM orders o
          WHERE o.event_id = $2 AND o.status = 'executed' AND o.uid > $3
          ORDER BY o.uid LIMIT $4)
       ) a
       ORDER BY uid LIMIT $4`;
  const params: unknown[] = [event.market, event.id, after, limit];
  if (onlineOnly) params.push(ONLINE_MINUTES);
  const { rows } = await db.query<{ uid: string }>(sql, params);
  return rows.map((r) => r.uid);
}

// One page of players in one transaction: re-mark this market's positions at the event's prices, work out the
// totals, fold the new value into the week (D-024) and set last_event_at. Players already at or past this event
// are skipped (the retry guard, D-021), in the lock query and again in the UPDATE. So is a player a LATER event
// has already traded (see playersAhead). Returns how many changed.
//
// `catchUp` is a player's read bringing themselves up to date (D-025, catchUpPlayer). It must never make a
// request wait for a lock: a burst of reads right after a close each held a pool connection while waiting, the
// pool ran dry and reads failed. So it skips a row someone else holds (the runner's batch, which updates the
// player anyway, or the player's own send), and it doesn't add to market_events.players_updated: that one row
// is shared by every catch-up of the event, and each would wait for the one before to commit. The count is the
// runner's own pages.
export async function updatePlayers(
  client: PoolClient,
  event: PricedEvent,
  uids: string[],
  opts: { catchUp?: boolean } = {},
): Promise<number> {
  if (uids.length === 0) return 0;
  return inTransaction(client, async () => {
    const locked = await client.query<PortfolioSqlRow>(
      `SELECT ${PORTFOLIO_COLUMNS} FROM portfolios
       WHERE uid = ANY($1) AND (last_event_at IS NULL OR last_event_at < $2)
       ORDER BY uid FOR UPDATE${opts.catchUp ? ' SKIP LOCKED' : ''}`,
      [uids, event.at],
    );
    if (locked.rows.length === 0) return 0;
    // Statements after the lock see everything committed while we waited for it (READ COMMITTED takes a new
    // snapshot per statement), including a runner batch that held these rows.
    const lockedUids = locked.rows.map((r) => r.uid);
    const held = await loadOpenPositions(client, lockedUids);
    const ahead = await playersAhead(client, event.at, lockedUids, held);

    const marks: PositionState[] = [];
    const p = {
      uid: [] as string[], holdings: [] as string[], unrealized: [] as string[], weekStart: [] as (string | null)[],
      weekStartValue: [] as (string | null)[], peak: [] as (string | null)[], drawdown: [] as string[],
    };
    await eachSlice(locked.rows, (r) => {
      if (ahead.has(r.uid)) return;
      const own = held.get(r.uid) ?? [];
      const marked = markPositions(own, event.market, event.prices, event.rate, event.at);
      const t = totals(parse(r.cash, SCALE.ILS), marked);
      const week = applyEvent(toWeek(r), event.at, parse(r.equity, SCALE.ILS), t.equity);
      if (week === null) return;   // can't happen after the WHERE above; kept so a bad row is never applied twice
      for (const m of marked) if (m.market === event.market && event.prices.has(m.symbol)) marks.push(m);
      p.uid.push(r.uid);
      p.holdings.push(format(t.holdingsValue, SCALE.ILS));
      p.unrealized.push(format(t.unrealizedPnl, SCALE.ILS));
      p.weekStart.push(week.weekStart);
      p.weekStartValue.push(fmt(week.weekStartValue, SCALE.ILS));
      p.peak.push(fmt(week.peakValue, SCALE.ILS));
      p.drawdown.push(format(week.maxDrawdownPct, SCALE.PCT));
    });

    if (marks.length > 0) {
      const c = await positionArrays(marks);
      await client.query(
        `UPDATE positions p SET last_price = t.last_price, last_fx = t.last_fx, market_value_ils = t.market_value,
           unrealized_pnl_ils = t.unrealized, marked_at = t.marked_at
         FROM unnest($1::bigint[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[], $6::timestamptz[])
           AS t (id, last_price, last_fx, market_value, unrealized, marked_at)
         WHERE p.id = t.id`,
        [c.id, c.lastPrice, c.lastFx, c.marketValue, c.unrealized, c.markedAt],
      );
    }
    if (p.uid.length === 0) return 0;
    const res = await client.query(
      `UPDATE portfolios p SET holdings_value = t.holdings_value, unrealized_pnl = t.unrealized, marked_at = $8,
         week_start = t.week_start, week_start_value = t.week_start_value, peak_value = t.peak_value,
         max_drawdown_pct = t.max_drawdown_pct, last_event_at = $8
       FROM unnest($1::text[], $2::numeric[], $3::numeric[], $4::date[], $5::numeric[], $6::numeric[], $7::numeric[])
         AS t (uid, holdings_value, unrealized, week_start, week_start_value, peak_value, max_drawdown_pct)
       WHERE p.uid = t.uid AND (p.last_event_at IS NULL OR p.last_event_at < $8)`,
      [p.uid, p.holdings, p.unrealized, p.weekStart, p.weekStartValue, p.peak, p.drawdown, event.at],
    );
    const n = res.rowCount ?? 0;
    if (n > 0 && !opts.catchUp) {
      await client.query('UPDATE market_events SET players_updated = players_updated + $2 WHERE id = $1', [event.id, n]);
    }
    return n;
  });
}

// Players a later event has already traded: an open position marked or opened after `at`, or an order executed
// at a later event (a sale of everything leaves no position behind). Their row already holds that later
// event's prices, so folding this older event in would re-mark a position at a price from before it was bought
// and put a value that never existed into the week's peak, drawdown or start (D-024). The runner's own step 2
// never meets one (events run in time order, and a fill is marked at exactly its event); the catch-up can,
// when the next event starts while it runs (D-025).
async function playersAhead(
  client: PoolClient,
  at: Date,
  uids: string[],
  held: Map<string, PositionState[]>,
): Promise<Set<string>> {
  const ahead = new Set<string>();
  const after = (d: Date | null) => d !== null && d.getTime() > at.getTime();
  for (const [uid, list] of held) if (list.some((p) => after(p.markedAt) || after(p.openedAt))) ahead.add(uid);
  // The orders are only looked at when a later event exists at all, so the runner's own step 2 pays one index
  // probe (market_events_at_idx) per page and never scans players' order history.
  const later = await client.query<{ id: string }>('SELECT id::text AS id FROM market_events WHERE at > $1', [at]);
  if (later.rows.length === 0) return ahead;
  const traded = await client.query<{ uid: string }>(
    `SELECT DISTINCT uid FROM orders WHERE event_id = ANY($1::bigint[]) AND status = 'executed' AND uid = ANY($2)`,
    [later.rows.map((r) => r.id), uids],
  );
  for (const r of traded.rows) ahead.add(r.uid);
  return ahead;
}

// D-025: brings one player up to the latest event whose prices are in effect, when they are behind it and it
// affects them. Same function and same guard as the batch, so the batch skips them later. Called before the
// dashboard and the trading screen read. Returns true when the player changed.
//
// "The latest event" is the latest one the runner has STARTED, whatever its status (a row exists only once
// started). While it is still running its orders ('pending'), its prices aren't in effect yet, and every event
// before it is done, so nobody is behind one of those. The event before is no longer "the latest in effect": a
// player filled in an earlier batch of this one already holds this event's prices, and step 2 will update them.
// A race with the next event starting after this read is caught under the row lock (updatePlayers,
// playersAhead). One statement decides it all, because every read pays for it: a burst of thousands of
// players opening the app shares a 10-connection pool.
export async function catchUpPlayer(db: Pool, uid: string): Promise<boolean> {
  const { rows } = await db.query<EventSqlRow & { due: boolean }>(
    `WITH e AS (
       SELECT id, market, kind, day, at, status FROM market_events
       ORDER BY at DESC, kind = 'open' DESC, id DESC LIMIT 1
     )
     SELECT e.id::text AS id, e.market, e.kind, e.day::text AS day, e.at, e.status,
            e.status <> 'pending'
            AND (p.last_event_at IS NULL OR p.last_event_at < e.at)
            AND (EXISTS (SELECT 1 FROM positions x JOIN securities s ON s.symbol = x.symbol
                         WHERE x.uid = p.uid AND x.status = 'open' AND s.market = e.market)
                 OR EXISTS (SELECT 1 FROM orders o WHERE o.uid = p.uid AND o.event_id = e.id AND o.status = 'executed')) AS due
     FROM e JOIN portfolios p ON p.uid = $1`,
    [uid],
  );
  if (!rows[0]?.due) return false;
  const priced = await loadEventPrices(db, toEventRow(rows[0]));
  const client = await db.connect();
  try {
    return (await updatePlayers(client, priced, [uid], { catchUp: true })) > 0;
  } finally {
    client.release();
  }
}

// ---------- step 3: finish ----------

// The daily chart rows first (at the last event of the day, in pages), then one transaction: the median player
// line, the scoring (D-034) and 'done'. The ledger check already ran in each order batch: ledger_balanced is
// false if any batch found a mismatch, and true otherwise (also for an event with no orders: nothing to check).
// The median comes first: it is the one statement that must see a single set of portfolios (see medians).
// After the commit, ANALYZE gives the planner a new day (analyzeBoard: only after a new day or weekly rows; a
// failure there is only logged).
export async function finishEvent(
  client: PoolClient,
  event: EventRow,
  calendar: Calendar,
  playerBatch = DEFAULT_PLAYER_BATCH,
): Promise<void> {
  if (isLastEventOfDay(event, calendar)) await writeDailyRows(client, event, batchSize(playerBatch, DEFAULT_PLAYER_BATCH));
  const scored = await inTransaction(client, async () => {
    const m = await medians(client, event.at);
    // The week also ends at the world's end: the runner never runs an event after ends_at (runUntil).
    const clock = await client.query<{ ends_at: Date | null }>('SELECT ends_at FROM world_clock');
    const weekEnds = isLastEventOfWeek(event, calendar, clock.rows[0]?.ends_at ?? null);
    const s = await scoreEvent(client, { day: event.day, at: event.at, weekEnds });
    await client.query(
      `UPDATE market_events SET status = 'done', finished_at = now(),
         duration_ms = LEAST(round(extract(epoch FROM now() - COALESCE(started_at, now())) * 1000), $4)::int,
         median_value = $2, median_return_pct = $3, ledger_balanced = COALESCE(ledger_balanced, TRUE)
       WHERE id = $1 AND status = 'orders_done'`,
      [event.id, m.value, m.returnPct, MAX_DURATION_MS],
    );
    return s;
  });
  await analyzeBoard(client, scored);
}

// D-024 / D-029: the daily chart rows, for every player whose last_event_at falls on this event's Israel day. In
// pages of players by uid (portfolios_pkey), each one statement on its own: a single statement over everyone
// touched that day passes the statement timeout at scale (its per-row foreign key check alone is seconds at a
// million), and the event would never finish. Safe to re-run: ON CONFLICT DO NOTHING, and no value changes
// before the next event (step 2 is over). The cursor is the page's last uid, not RETURNING: a re-run inserts
// nothing and must still move on.
async function writeDailyRows(client: PoolClient, event: EventRow, batch: number): Promise<void> {
  const dayStart = zonedToInstant(event.day, 0, ISRAEL);
  const nextDay = zonedToInstant(addDays(event.day, 1), 0, ISRAEL);
  let after = '';
  for (;;) {
    const { rows } = await client.query<{ n: number; last: string | null }>(
      `WITH page AS (
         SELECT uid, equity FROM portfolios
         WHERE uid > $4 AND last_event_at >= $2 AND last_event_at < $3
         ORDER BY uid LIMIT $5
       ), written AS (
         INSERT INTO portfolio_snapshots (uid, at, value_ils) SELECT uid, $1, equity FROM page
         ON CONFLICT DO NOTHING
       )
       SELECT count(*)::int AS n, max(uid) AS last FROM page`,
      [event.at, dayStart, nextDay, after, batch],
    );
    const { n, last } = rows[0];
    if (n < batch || last === null) return;
    after = last;
  }
}

// D-024: the exact median over ALL portfolios of the value, and of the week return in % to 4 decimals (0 for a
// row whose week isn't the event's week). Only the middle one or two rows come back from SQL; the mean of two is
// taken by week.ts's median(), half up, in the value's own scale. No floats, no percentile_cont.
// The return of one row is round_half_away(10^6 × (equity − week_start_value) / week_start_value), in 0.0001 %
// units: the same number as weekReturnPct() in week.ts, computed with the exact numeric div().
// ONE statement, so the count and both middles come from one snapshot. finishEvent runs at READ COMMITTED,
// where each statement sees what committed before it started: a player signing up (POST /me) between a count
// and an OFFSET read would shift the rows under the offset and give the median of neither set of players.
// Every subquery of one statement shares its snapshot. The middle ranks of n rows are (n + 1) / 2 and n / 2 + 1
// in integer division: one rank when n is odd, two when it is even, none when there are no portfolios.
export async function medians(db: Db, eventAt: Date): Promise<{ value: string | null; returnPct: string | null }> {
  // The return column is cast to text only at the end: `ORDER BY` on the TEXT would sort it with a collation
  // that may ignore the minus sign and put −10 between 0 and 1.
  const { rows } = await db.query<{ k: 'value' | 'return'; x: string }>(
    `WITH n AS (SELECT count(*) AS c FROM portfolios),
     v AS (SELECT equity, row_number() OVER (ORDER BY equity) AS rn FROM portfolios),
     w AS (
       SELECT r, row_number() OVER (ORDER BY r) AS rn FROM (
         SELECT CASE WHEN week_start = $1::date AND week_start_value > 0
                     THEN sign(equity - week_start_value)
                          * div(2000000 * abs(equity - week_start_value) + week_start_value, 2 * week_start_value)
                     ELSE 0 END AS r
         FROM portfolios
       ) t
     )
     SELECT 'value' AS k, v.equity::text AS x FROM v, n WHERE v.rn IN ((n.c + 1) / 2, n.c / 2 + 1)
     UNION ALL
     SELECT 'return' AS k, w.r::text AS x FROM w, n WHERE w.rn IN ((n.c + 1) / 2, n.c / 2 + 1)`,
    [weekOf(eventAt)],
  );
  const pick = (k: 'value' | 'return', scale: number) => rows.filter((r) => r.k === k).map((r) => parse(r.x, scale));
  if (rows.length === 0) return { value: null, returnPct: null };
  return {
    value: fmt(median(pick('value', SCALE.ILS)), SCALE.ILS),
    returnPct: fmt(median(pick('return', 0)), SCALE.PCT),
  };
}

// D-019 / D-029: for these players (an order batch's), every stored balance must equal its ledger account:
// cash = cash_free + cash_locked, reserved_cash = cash_locked, realized_pnl = −realized_pnl, and per stock the
// open position's cost basis = stock_cost (0 when there is no open position). Returns the uids that don't match.
export async function ledgerMismatches(db: Db, uids: readonly string[]): Promise<string[]> {
  if (uids.length === 0) return [];
  const { rows } = await db.query<{ uid: string }>(
    `WITH u AS (SELECT DISTINCT uid FROM unnest($1::text[]) AS t (uid)),
     led AS (
       SELECT e.uid,
              sum(e.amount) FILTER (WHERE e.account IN ('cash_free', 'cash_locked')) AS cash,
              sum(e.amount) FILTER (WHERE e.account = 'cash_locked') AS locked,
              sum(e.amount) FILTER (WHERE e.account = 'realized_pnl') AS realized
       FROM ledger_entries e JOIN u ON u.uid = e.uid
       GROUP BY e.uid
     ),
     stock AS (
       SELECT e.uid, e.symbol, sum(e.amount) AS cost
       FROM ledger_entries e JOIN u ON u.uid = e.uid
       WHERE e.account = 'stock_cost'
       GROUP BY e.uid, e.symbol
     ),
     pos AS (
       SELECT p.uid, p.symbol, p.cost_basis_ils AS cost
       FROM positions p JOIN u ON u.uid = p.uid
       WHERE p.status = 'open'
     )
     SELECT p.uid FROM portfolios p JOIN u ON u.uid = p.uid LEFT JOIN led ON led.uid = p.uid
     WHERE p.cash <> COALESCE(led.cash, 0)
        OR p.reserved_cash <> COALESCE(led.locked, 0)
        OR p.realized_pnl <> -COALESCE(led.realized, 0)
     UNION
     SELECT COALESCE(s.uid, x.uid) FROM stock s FULL JOIN pos x ON x.uid = s.uid AND x.symbol = s.symbol
     WHERE COALESCE(s.cost, 0) <> COALESCE(x.cost, 0)
     ORDER BY 1`,
    [uids],
  );
  return rows.map((r) => r.uid);
}

// Is this the last open or close of its Israel day (D-024: the daily chart row is written then)?
// At the same instant a close comes before an open, like eventsBetween.
export function isLastEventOfDay(
  event: { market: Market; kind: 'open' | 'close'; day: string; at: Date },
  calendar: Calendar,
): boolean {
  const dayEnd = new Date(zonedToInstant(addDays(event.day, 1), 0, ISRAEL).getTime() - 1);
  const t = event.at.getTime();
  return !eventsBetween(new Date(t - 1), dayEnd, calendar).some(
    (e) => e.at.getTime() > t || (e.at.getTime() === t && e.kind === 'open' && event.kind === 'close'),
  );
}

// ---------- loading ----------

const EVENT_COLUMNS = `id::text AS id, market, kind, day::text AS day, at, status`;

type EventSqlRow = { id: string; market: Market; kind: 'open' | 'close'; day: string; at: Date; status: EventStatus };

function toEventRow(r: EventSqlRow): EventRow {
  return { id: r.id, market: r.market, kind: r.kind, day: r.day, at: r.at, status: r.status };
}

async function findEvent(db: Db, e: MarketEvent): Promise<EventRow | null> {
  const { rows } = await db.query<EventSqlRow>(
    `SELECT ${EVENT_COLUMNS} FROM market_events WHERE market = $1 AND kind = $2 AND day = $3::date`,
    [e.market, e.kind, e.day],
  );
  return rows[0] ? toEventRow(rows[0]) : null;
}

// The calendar (D-016) on the runner's own client: calendar.ts caches per Pool, and the runner holds a client.
async function loadCalendarWith(db: Db): Promise<Calendar> {
  const { rows } = await db.query<{ market: Market; day: string; reason_he: string }>(
    'SELECT market, day::text AS day, reason_he FROM market_closures',
  );
  return makeCalendar(rows.map((r) => ({ market: r.market, day: r.day, reason: r.reason_he })));
}

const PORTFOLIO_COLUMNS = `uid, cash::text AS cash, reserved_cash::text AS reserved_cash,
  realized_pnl::text AS realized_pnl, equity::text AS equity, week_start::text AS week_start,
  week_start_value::text AS week_start_value, peak_value::text AS peak_value,
  max_drawdown_pct::text AS max_drawdown_pct, last_event_at`;

type PortfolioSqlRow = {
  uid: string;
  cash: string;
  reserved_cash: string;
  realized_pnl: string;
  equity: string;
  week_start: string | null;
  week_start_value: string | null;
  peak_value: string | null;
  max_drawdown_pct: string;
  last_event_at: Date | null;
};

function toPortfolio(r: PortfolioSqlRow, positions: PositionState[]): PortfolioState {
  return {
    uid: r.uid,
    cash: parse(r.cash, SCALE.ILS),
    reservedCash: parse(r.reserved_cash, SCALE.ILS),
    realizedPnl: parse(r.realized_pnl, SCALE.ILS),
    positions,
  };
}

function toWeek(r: PortfolioSqlRow): WeekState {
  return {
    weekStart: r.week_start,
    weekStartValue: r.week_start_value === null ? null : parse(r.week_start_value, SCALE.ILS),
    peakValue: r.peak_value === null ? null : parse(r.peak_value, SCALE.ILS),
    maxDrawdownPct: parse(r.max_drawdown_pct, SCALE.PCT),
    lastEventAt: r.last_event_at,
  };
}

type PositionSqlRow = {
  id: string;
  uid: string;
  symbol: string;
  market: Market;
  units: string;
  reserved_units: string;
  avg_cost_ils: string;
  cost_basis_ils: string;
  realized_pnl_ils: string;
  last_price: string | null;
  last_fx: string | null;
  market_value_ils: string | null;
  marked_at: Date | null;
  opened_at: Date | null;
};

// Open positions of these players, grouped by uid. A page of 5,000 players is about 27,000 rows to parse, so
// the loop gives the event loop back now and then (eachSlice).
async function loadOpenPositions(db: Db, uids: string[]): Promise<Map<string, PositionState[]>> {
  const { rows } = await db.query<PositionSqlRow>(
    `SELECT p.id::text AS id, p.uid, p.symbol, s.market, p.units::text AS units,
            p.reserved_units::text AS reserved_units, p.avg_cost_ils::text AS avg_cost_ils,
            p.cost_basis_ils::text AS cost_basis_ils, p.realized_pnl_ils::text AS realized_pnl_ils,
            p.last_price::text AS last_price, p.last_fx::text AS last_fx,
            p.market_value_ils::text AS market_value_ils, p.marked_at, p.opened_at
     FROM positions p JOIN securities s ON s.symbol = p.symbol
     WHERE p.uid = ANY($1) AND p.status = 'open'
     ORDER BY p.uid, p.symbol`,
    [uids],
  );
  const out = new Map<string, PositionState[]>();
  await eachSlice(rows, (r) => {
    const list = out.get(r.uid) ?? [];
    list.push({
      id: r.id,
      symbol: r.symbol,
      market: r.market,
      status: 'open',
      units: parse(r.units, SCALE.UNITS),
      reservedUnits: parse(r.reserved_units, SCALE.UNITS),
      costBasis: parse(r.cost_basis_ils, SCALE.ILS),
      avgCost: parse(r.avg_cost_ils, SCALE.AVG_COST),
      realizedPnl: parse(r.realized_pnl_ils, SCALE.ILS),
      lastPrice: r.last_price === null ? null : parse(r.last_price, SCALE.PRICE),
      lastRate: r.last_fx === null ? null : parse(r.last_fx, SCALE.RATE),
      marketValue: r.market_value_ils === null ? null : parse(r.market_value_ils, SCALE.ILS),
      markedAt: r.marked_at,
      openedAt: r.opened_at,
      closedAt: null,
    });
    out.set(r.uid, list);
  });
  return out;
}

type OrderSqlRow = {
  id: string;
  uid: string;
  symbol: string;
  market: Market;
  side: 'buy' | 'sell';
  amount_ils: string | null;
  units: string | null;
  executes_at: Date;
  stop_price: string | null;   // a buy's stop (D-037); not part of the engine's input
};

function toDueOrder(r: OrderSqlRow): DueOrder {
  return {
    id: r.id,
    uid: r.uid,
    symbol: r.symbol,
    market: r.market,
    side: r.side,
    amountIls: r.amount_ils === null ? null : parse(r.amount_ils, SCALE.ILS),
    units: r.units === null ? null : parse(r.units, SCALE.UNITS),
    executesAt: r.executes_at,
  };
}

function toEventInput(e: PricedEvent): EventInput {
  return { market: e.market, kind: e.kind, at: e.at, prices: e.prices, rate: e.rate };
}

// ---------- writing ----------

// The columns of many positions as parallel string arrays, for one UPDATE/INSERT … FROM unnest. One pass, giving
// the event loop back now and then (eachSlice): a page of players can be tens of thousands of positions.
async function positionArrays(list: readonly PositionState[]) {
  const c = {
    id: [] as (string | null)[], status: [] as string[], units: [] as string[], reserved: [] as string[],
    avgCost: [] as string[], costBasis: [] as string[], realized: [] as string[], lastPrice: [] as (string | null)[],
    lastFx: [] as (string | null)[], marketValue: [] as (string | null)[], unrealized: [] as (string | null)[],
    markedAt: [] as (string | null)[], openedAt: [] as (string | null)[], closedAt: [] as (string | null)[],
  };
  await eachSlice(list, (p) => {
    c.id.push(p.id);
    c.status.push(p.status);
    c.units.push(format(p.units, SCALE.UNITS));
    c.reserved.push(format(p.reservedUnits, SCALE.UNITS));
    c.avgCost.push(format(p.avgCost, SCALE.AVG_COST));
    c.costBasis.push(format(p.costBasis, SCALE.ILS));
    c.realized.push(format(p.realizedPnl, SCALE.ILS));
    c.lastPrice.push(fmt(p.lastPrice, SCALE.PRICE));
    c.lastFx.push(fmt(p.lastRate, SCALE.RATE));
    c.marketValue.push(fmt(p.marketValue, SCALE.ILS));
    // Market value − cost basis (D-019): not a ledger entry, nothing was paid or received.
    c.unrealized.push(p.marketValue === null ? null : format(p.marketValue - p.costBasis, SCALE.ILS));
    c.markedAt.push(p.markedAt?.toISOString() ?? null);
    c.openedAt.push(p.openedAt?.toISOString() ?? null);
    c.closedAt.push(p.closedAt?.toISOString() ?? null);
  });
  return c;
}

function samePosition(a: PositionState | undefined, b: PositionState): boolean {
  if (!a) return false;
  return a.status === b.status && a.units === b.units && a.reservedUnits === b.reservedUnits
    && a.costBasis === b.costBasis && a.avgCost === b.avgCost && a.realizedPnl === b.realizedPnl
    && a.lastPrice === b.lastPrice && a.lastRate === b.lastRate && a.marketValue === b.marketValue
    && a.markedAt?.getTime() === b.markedAt?.getTime() && a.closedAt?.getTime() === b.closedAt?.getTime();
}

function fmt(v: bigint | null, scale: number): string | null {
  return v === null ? null : format(v, scale);
}

// ---------- helpers ----------

// The runner runs inside the API's process (D-030), so its JavaScript shares the event loop with players'
// requests. A page of 5,000 players is a few hundred milliseconds of parsing, marking and formatting with no
// await in between, and every request on the instance waited behind it. Long loops go through eachSlice: it
// gives the loop back (setImmediate, after any I/O that is waiting) every `size` items, so a request waits
// behind a few milliseconds of the runner at most.
const SLICE = 500;

export async function eachSlice<T>(items: readonly T[], fn: (item: T, i: number) => void, size = SLICE): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && i % size === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    fn(items[i], i);
  }
}

// BEGIN … COMMIT on the given client; any error rolls back and is thrown again, so the client is always clean.
async function inTransaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

function batchSize(n: number | undefined, fallback: number): number {
  if (n === undefined) return fallback;
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`batch size must be a whole number ≥ 1, got ${n}`);
  return n;
}

function emptySummary(): RunSummary {
  return { events: 0, ordersExecuted: 0, ordersRejected: 0, playersUpdated: 0 };
}

function addTo(total: RunSummary, s: RunSummary): void {
  total.events += s.events;
  total.ordersExecuted += s.ordersExecuted;
  total.ordersRejected += s.ordersRejected;
  total.playersUpdated += s.playersUpdated;
}
