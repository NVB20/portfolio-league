// The runner (api/src/runner.ts; D-021, D-024, D-025, D-029) against a real Postgres (TEST_DATABASE_URL).
// Pending orders and their reserve journals are written here with SQL, exactly as POST /me/orders writes them
// (reserveJournal amounts; the ledger triggers require balanced journals). Holdings bought "before" a test are
// kept ledger-true with a reversal journal that moves their cost from cash to stock.
// Every money check compares the exact NUMERIC strings Postgres returns.
//
// Calendar: November 2026. Israel is UTC+2 and New York UTC−5, so (Israel time / UTC):
//   TASE open 10:00 / 08:00Z, US open 16:30 / 14:30Z, TASE close 17:30 / 15:30Z, US close 23:00 / 21:00Z.
//   Friday 13.11 the TASE closes at 13:50 / 11:50Z.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { runner as migrate } from 'node-pg-migrate';
import {
  affectedPage, catchUpPlayer, isLastEventOfDay, ledgerMismatches, loadEventPrices, medians, RUNNER_LOCK_KEY,
  runEvent, runOrderBatch, type RunOptions, runUntil, startEvent, updatePlayers, withRunnerLock,
} from '../src/runner.js';
import { avgCost, format, parse, SCALE } from '../src/game/fixed.js';
import { reserveJournal } from '../src/game/ledger.js';
import { REASONS } from '../src/game/engine.js';
import { eventsBetween } from '../src/game/clock.js';
import { makeCalendar, type Market, type MarketEvent, NO_CLOSURES } from '../src/game/marketHours.js';
import { addDays, ISRAEL, zonedToInstant } from '../src/game/time.js';
import { weekReturnPct } from '../src/game/week.js';
import { upsertUser } from '../src/users.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

const db = new pg.Pool({ connectionString: DATABASE_URL });

beforeAll(async () => {
  await migrate({ databaseUrl: DATABASE_URL, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
});

beforeEach(async () => {
  await db.query('TRUNCATE users, securities, usd_ils, world_clock, market_events, market_closures CASCADE');
  await db.query(
    `INSERT INTO securities (symbol, name_he, market, exchange, currency) VALUES
       ('TEVA', 'טבע', 'TASE', 'TASE', 'ILS'), ('LUMI', 'לאומי', 'TASE', 'TASE', 'ILS'),
       ('NVDA', 'אנבידיה', 'US', 'NASDAQ', 'USD'), ('AAPL', 'אפל', 'US', 'NASDAQ', 'USD')`,
  );
});

afterAll(async () => {
  await db.end();
});

// ---------- the calendar ----------

const MON = '2026-11-09';
const TUE = '2026-11-10';
const WED = '2026-11-11';
const FRI = '2026-11-13';
const NEXT_MON = '2026-11-16';

// The open or close of a market on an Israel date (weekend rule only).
function ev(market: Market, kind: 'open' | 'close', day: string): MarketEvent {
  const e = eventsBetween(zonedToInstant(day, 0, ISRAEL), zonedToInstant(addDays(day, 1), 0, ISRAEL), NO_CLOSURES)
    .find((x) => x.market === market && x.kind === kind);
  if (!e) throw new Error(`no ${market} ${kind} on ${day}`);
  return e;
}

const israel = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedToInstant(day, h * 60 + m, ISRAEL);
};
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ---------- fixtures ----------

async function world(nowAt: Date, eventsThrough: Date | null = null) {
  await db.query('INSERT INTO world_clock (now_at, events_through) VALUES ($1, $2)', [nowAt, eventsThrough]);
}

async function player(uid: string, opts: { online?: boolean } = {}) {
  await upsertUser(db, uid, `${uid}@example.com`);
  if (opts.online) await db.query('UPDATE users SET last_seen_at = now() WHERE uid = $1', [uid]);
}

async function price(symbol: string, day: string, open: string, close: string) {
  await db.query('INSERT INTO prices (symbol, day, open, close) VALUES ($1, $2, $3, $4)', [symbol, day, open, close]);
}

async function fx(day: string, open: string, close: string) {
  await db.query('INSERT INTO usd_ils (day, open, close) VALUES ($1, $2, $3)', [day, open, close]);
}

async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

type Mark = { price: string; fx?: string; value: string; at: Date };

// A position bought before the test, kept ledger-true: a reversal journal moves the cost from cash_free to
// stock_cost, and the stored totals move with it. Returns the position id.
async function holding(uid: string, symbol: string, units: string, cost: string, mark?: Mark): Promise<string> {
  return inTx(async (c) => {
    const j = await c.query<{ id: string }>(`INSERT INTO journals (uid, kind) VALUES ($1, 'reversal') RETURNING id::text AS id`, [uid]);
    await c.query(
      `INSERT INTO ledger_entries (journal_id, uid, account, symbol, amount)
       VALUES ($1, $2, 'cash_free', NULL, -($3::numeric)), ($1, $2, 'stock_cost', $4, $3::numeric)`,
      [j.rows[0].id, uid, cost, symbol],
    );
    const avg = format(avgCost(parse(cost, SCALE.ILS), parse(units, SCALE.UNITS)), SCALE.AVG_COST);
    const value = mark?.value ?? null;
    const p = await c.query<{ id: string }>(
      `INSERT INTO positions (uid, symbol, units, avg_cost_ils, cost_basis_ils, last_price, last_fx, market_value_ils,
                              unrealized_pnl_ils, marked_at, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $8::numeric - $5::numeric, $9, '2026-11-02T08:00:00Z')
       RETURNING id::text AS id`,
      [uid, symbol, units, avg, cost, mark?.price ?? null, mark?.fx ?? null, value, mark?.at ?? null],
    );
    await c.query(
      `UPDATE portfolios SET cash = cash - $2::numeric, holdings_value = holdings_value + $3::numeric,
         unrealized_pnl = unrealized_pnl + ($3::numeric - $2::numeric)
       WHERE uid = $1`,
      [uid, cost, value ?? cost],
    );
    return p.rows[0].id;
  });
}

// A pending buy and its reserve journal, as POST /me/orders writes them. Returns the order id.
async function sendBuy(uid: string, symbol: string, amount: string, at: MarketEvent, placedAt?: Date): Promise<string> {
  return inTx(async (c) => {
    const placed = placedAt ?? new Date(at.at.getTime() - 3_600_000);
    const o = await c.query<{ id: string }>(
      `INSERT INTO orders (uid, symbol, side, amount_ils, placed_at, executes_at, price_type)
       VALUES ($1, $2, 'buy', $3, $4, $5, $6) RETURNING id::text AS id`,
      [uid, symbol, amount, placed, at.at, at.kind],
    );
    const id = o.rows[0].id;
    const journal = reserveJournal(id, parse(amount, SCALE.ILS));
    const j = await c.query<{ id: string }>(
      `INSERT INTO journals (uid, kind, order_id, world_at) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
      [uid, journal.kind, id, placed],
    );
    await c.query(
      `INSERT INTO ledger_entries (journal_id, uid, account, symbol, amount)
       SELECT $1, $2, x.account, x.symbol, x.amount FROM unnest($3::text[], $4::text[], $5::numeric[]) AS x (account, symbol, amount)`,
      [j.rows[0].id, uid, journal.entries.map((e) => e.account), journal.entries.map((e) => e.symbol),
        journal.entries.map((e) => format(e.amount, SCALE.ILS))],
    );
    await c.query('UPDATE portfolios SET reserved_cash = reserved_cash + $2::numeric WHERE uid = $1', [uid, amount]);
    return id;
  });
}

// A pending sell: its units are locked on the open position, as POST /me/orders does.
async function sendSell(uid: string, symbol: string, units: string, at: MarketEvent): Promise<string> {
  return inTx(async (c) => {
    const o = await c.query<{ id: string }>(
      `INSERT INTO orders (uid, symbol, side, units, placed_at, executes_at, price_type)
       VALUES ($1, $2, 'sell', $3, $4, $5, $6) RETURNING id::text AS id`,
      [uid, symbol, units, new Date(at.at.getTime() - 3_600_000), at.at, at.kind],
    );
    const r = await c.query(
      `UPDATE positions SET reserved_units = reserved_units + $3::numeric WHERE uid = $1 AND symbol = $2 AND status = 'open'`,
      [uid, symbol, units],
    );
    if (r.rowCount !== 1) throw new Error(`${uid} holds no ${symbol}`);
    return o.rows[0].id;
  });
}

// ---------- reading ----------

async function portfolio(uid: string) {
  const { rows } = await db.query(
    `SELECT cash::text, reserved_cash::text, available_cash::text, holdings_value::text, equity::text,
            realized_pnl::text, unrealized_pnl::text, week_start::text, week_start_value::text, peak_value::text,
            max_drawdown_pct::text, last_event_at, marked_at
     FROM portfolios WHERE uid = $1`,
    [uid],
  );
  const r = rows[0];
  return { ...r, last_event_at: iso(r.last_event_at), marked_at: iso(r.marked_at) };
}

async function positionsOf(uid: string) {
  const { rows } = await db.query(
    `SELECT id::text, symbol, status, units::text, reserved_units::text, avg_cost_ils::text, cost_basis_ils::text,
            realized_pnl_ils::text, last_price::text, last_fx::text, market_value_ils::text,
            unrealized_pnl_ils::text, marked_at, opened_at, closed_at
     FROM positions WHERE uid = $1 ORDER BY positions.id`,
    [uid],
  );
  return rows.map((r) => ({ ...r, marked_at: iso(r.marked_at), opened_at: iso(r.opened_at), closed_at: iso(r.closed_at) }));
}

async function order(id: string) {
  const { rows } = await db.query(
    `SELECT status, fill_price::text, fx_rate::text, filled_units::text, filled_ils::text, realized_pnl_ils::text,
            position_id::text, executed_at, event_id::text, reject_code, reject_reason
     FROM orders WHERE id = $1`,
    [id],
  );
  return { ...rows[0], executed_at: iso(rows[0].executed_at) };
}

async function eventOf(market: Market, kind: 'open' | 'close', day: string) {
  const { rows } = await db.query(
    `SELECT id::text, status, orders_executed, orders_rejected, players_updated, ledger_balanced,
            median_value::text, median_return_pct::text, started_at, finished_at, duration_ms
     FROM market_events WHERE market = $1 AND kind = $2 AND day = $3`,
    [market, kind, day],
  );
  return rows[0];
}

// Ledger balances of one player by account (stock_cost per symbol), as exact strings.
async function ledger(uid: string): Promise<Record<string, string>> {
  const { rows } = await db.query<{ k: string; total: string }>(
    `SELECT account || COALESCE(':' || symbol, '') AS k, sum(amount)::text AS total
     FROM ledger_entries WHERE uid = $1 GROUP BY 1 ORDER BY 1`,
    [uid],
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.total]));
}

// The journals of one order (kind, world time, entries), oldest first.
async function journalsOf(orderId: string) {
  const { rows } = await db.query<{ kind: string; world_at: Date | null; entries: string[] }>(
    `SELECT j.kind, j.world_at,
            array_agg(e.account || COALESCE(':' || e.symbol, '') || ' ' || e.amount::text ORDER BY e.id) AS entries
     FROM journals j JOIN ledger_entries e ON e.journal_id = j.id
     WHERE j.order_id = $1 GROUP BY j.id ORDER BY j.id`,
    [orderId],
  );
  return rows.map((r) => ({ kind: r.kind, world_at: iso(r.world_at), entries: r.entries }));
}

async function snapshots() {
  const { rows } = await db.query(`SELECT uid, at, value_ils::text FROM portfolio_snapshots ORDER BY at, uid`);
  return rows.map((r) => ({ uid: r.uid, at: iso(r.at), value: r.value_ils }));
}

// Everything the runner writes, to prove a re-run changes nothing.
async function everything() {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return {
    portfolios: await q(`SELECT uid, cash::text, reserved_cash::text, holdings_value::text, realized_pnl::text,
                                unrealized_pnl::text, week_start::text, week_start_value::text, peak_value::text,
                                max_drawdown_pct::text, last_event_at, marked_at FROM portfolios ORDER BY uid`),
    positions: await q(`SELECT id, uid, symbol, status, units::text, reserved_units::text, cost_basis_ils::text,
                               market_value_ils::text, marked_at, closed_at FROM positions ORDER BY id`),
    orders: await q(`SELECT id, status, filled_units::text, filled_ils::text, position_id, event_id, reject_code
                     FROM orders ORDER BY id`),
    entries: await q(`SELECT count(*)::int AS n, coalesce(sum(abs(amount)), 0)::text AS volume FROM ledger_entries`),
    events: await q(`SELECT id, status, orders_executed, orders_rejected, players_updated, ledger_balanced,
                            median_value::text, median_return_pct::text FROM market_events ORDER BY at, id`),
    snapshots: await q(`SELECT uid, at, value_ils::text FROM portfolio_snapshots ORDER BY uid, at`),
  };
}

async function withClient<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

const run = (target: Date, opts?: RunOptions) => withClient((c) => runUntil(c, target, opts));

// ---------- the worked example (the spec's numbers, end to end) ----------

describe('the worked example', () => {
  it('buys, re-marks and sells NVDA with the exact ledger and totals, balanced after every event', async () => {
    await world(israel(MON, '17:00'));
    await player('alice');
    await price('NVDA', MON, '149.0000', '150.0000');
    await price('NVDA', TUE, '160.0000', '165.0000');
    await fx(MON, '3.6900', '3.7000');
    await fx(TUE, '3.7000', '3.6500');

    // Sent Monday 17:00 while New York is open: it fills at Monday's US close.
    const buy = await sendBuy('alice', 'NVDA', '100000.00', ev('US', 'close', MON));
    expect(await portfolio('alice')).toMatchObject({ reserved_cash: '100000.00', available_cash: '900000.0000' });

    const first = await run(ev('US', 'close', MON).at);
    expect(first).toEqual({ events: 2, ordersExecuted: 1, ordersRejected: 0, playersUpdated: 1 });   // TASE close + US close

    const monClose = await eventOf('US', 'close', MON);
    expect(await order(buy)).toMatchObject({
      status: 'executed', fill_price: '150.0000', fx_rate: '3.7000', filled_units: '180.18018018',
      filled_ils: '100000.00', realized_pnl_ils: null, executed_at: ev('US', 'close', MON).at.toISOString(),
      event_id: monClose.id, reject_code: null, reject_reason: null,
    });
    expect(await journalsOf(buy)).toEqual([
      { kind: 'reserve', world_at: expect.any(String), entries: ['cash_free -100000.00', 'cash_locked 100000.00'] },
      { kind: 'buy', world_at: ev('US', 'close', MON).at.toISOString(), entries: ['cash_locked -100000.00', 'stock_cost:NVDA 100000.00'] },
    ]);
    const [pos] = await positionsOf('alice');
    expect(pos).toMatchObject({
      status: 'open', units: '180.18018018', reserved_units: '0.00000000', avg_cost_ils: '555.00000000',
      cost_basis_ils: '100000.00', realized_pnl_ils: '0.00', last_price: '150.0000', last_fx: '3.7000',
      market_value_ils: '100000.00', unrealized_pnl_ils: '0.00', marked_at: ev('US', 'close', MON).at.toISOString(),
      opened_at: ev('US', 'close', MON).at.toISOString(),
    });
    expect((await order(buy)).position_id).toBe(pos.id);
    expect(await portfolio('alice')).toMatchObject({
      cash: '900000.0000', reserved_cash: '0.00', available_cash: '900000.0000', holdings_value: '100000.00',
      equity: '1000000.0000', realized_pnl: '0.00', unrealized_pnl: '0.00',
      week_start: MON, week_start_value: '1000000.00', peak_value: '1000000.00', max_drawdown_pct: '0.0000',
      last_event_at: ev('US', 'close', MON).at.toISOString(),
    });
    expect(await ledger('alice')).toEqual({
      capital: '-1000000.00', cash_free: '900000.00', cash_locked: '0.00', 'stock_cost:NVDA': '100000.00',
    });
    expect(monClose).toMatchObject({
      status: 'done', orders_executed: 1, orders_rejected: 0, players_updated: 1, ledger_balanced: true,
      median_value: '1000000.00', median_return_pct: '0.0000',
    });

    // Tuesday's US open: $160 at the day's OPEN rate 3.7000.
    await run(ev('US', 'open', TUE).at);
    expect(await positionsOf('alice')).toMatchObject([
      { last_price: '160.0000', last_fx: '3.7000', market_value_ils: '106666.67', unrealized_pnl_ils: '6666.67' },
    ]);
    expect(await portfolio('alice')).toMatchObject({
      holdings_value: '106666.67', unrealized_pnl: '6666.67', equity: '1006666.6700', peak_value: '1006666.67',
    });

    // Sell half, filled at Tuesday's close: $165 at the CLOSE rate 3.6500.
    const sell = await sendSell('alice', 'NVDA', '90.09009009', ev('US', 'close', TUE));
    await run(ev('US', 'close', TUE).at);
    expect(await order(sell)).toMatchObject({
      status: 'executed', fill_price: '165.0000', fx_rate: '3.6500', filled_units: '90.09009009',
      filled_ils: '54256.76', realized_pnl_ils: '4256.76', position_id: pos.id,
    });
    expect(await journalsOf(sell)).toEqual([
      { kind: 'sell', world_at: ev('US', 'close', TUE).at.toISOString(),
        entries: ['cash_free 54256.76', 'stock_cost:NVDA -50000.00', 'realized_pnl -4256.76'] },
    ]);
    expect(await positionsOf('alice')).toMatchObject([{
      status: 'open', units: '90.09009009', reserved_units: '0.00000000', avg_cost_ils: '555.00000000',
      cost_basis_ils: '50000.00', realized_pnl_ils: '4256.76', last_price: '165.0000', last_fx: '3.6500',
      market_value_ils: '54256.76', unrealized_pnl_ils: '4256.76',
    }]);
    expect(await portfolio('alice')).toMatchObject({
      cash: '954256.7600', reserved_cash: '0.00', holdings_value: '54256.76', equity: '1008513.5200',
      realized_pnl: '4256.76', unrealized_pnl: '4256.76', week_start: MON, week_start_value: '1000000.00',
      peak_value: '1008513.52', max_drawdown_pct: '0.0000',
    });
    expect(await ledger('alice')).toEqual({
      capital: '-1000000.00', cash_free: '954256.76', cash_locked: '0.00', realized_pnl: '-4256.76',
      'stock_cost:NVDA': '50000.00',
    });

    // Every event ran, in order, and the ledger check passed after each one.
    const { rows } = await db.query(
      `SELECT market, kind, day::text, status, ledger_balanced FROM market_events ORDER BY at`,
    );
    expect(rows).toEqual([
      { market: 'TASE', kind: 'close', day: MON, status: 'done', ledger_balanced: true },
      { market: 'US', kind: 'close', day: MON, status: 'done', ledger_balanced: true },
      { market: 'TASE', kind: 'open', day: TUE, status: 'done', ledger_balanced: true },
      { market: 'US', kind: 'open', day: TUE, status: 'done', ledger_balanced: true },
      { market: 'TASE', kind: 'close', day: TUE, status: 'done', ledger_balanced: true },
      { market: 'US', kind: 'close', day: TUE, status: 'done', ledger_balanced: true },
    ]);
    const clock = await db.query('SELECT events_through FROM world_clock');
    expect(iso(clock.rows[0].events_through)).toBe(ev('US', 'close', TUE).at.toISOString());
    // The daily chart rows: Monday's and Tuesday's last event.
    expect(await snapshots()).toEqual([
      { uid: 'alice', at: ev('US', 'close', MON).at.toISOString(), value: '1000000.00' },
      { uid: 'alice', at: ev('US', 'close', TUE).at.toISOString(), value: '1008513.52' },
    ]);
  });
});

// ---------- step 1: orders ----------

describe('orders at an event', () => {
  it('buy, partial sell, then sell-all: the position closes with no rounding agora left', async () => {
    await world(israel(MON, '12:00'));
    await player('alice');
    await price('TEVA', MON, '30.0000', '30.0000');
    await price('TEVA', TUE, '33.0000', '33.0000');
    await price('TEVA', WED, '36.0000', '36.0000');

    const buy = await sendBuy('alice', 'TEVA', '10000.00', ev('TASE', 'close', MON));
    await run(ev('TASE', 'close', MON).at);
    expect(await order(buy)).toMatchObject({ status: 'executed', fill_price: '30.0000', fx_rate: null, filled_units: '333.33333333' });
    expect(await positionsOf('alice')).toMatchObject([{ units: '333.33333333', avg_cost_ils: '30.00000000', cost_basis_ils: '10000.00', last_fx: null }]);

    // Partial: 111.11111111 × 33 = 3,666.67; cost released at the average, 111.11111111 × 30 = 3,333.33.
    const partial = await sendSell('alice', 'TEVA', '111.11111111', ev('TASE', 'close', TUE));
    await run(ev('TASE', 'close', TUE).at);
    expect(await order(partial)).toMatchObject({ filled_ils: '3666.67', realized_pnl_ils: '333.34' });
    expect(await positionsOf('alice')).toMatchObject([{
      status: 'open', units: '222.22222222', avg_cost_ils: '30.00000000', cost_basis_ils: '6666.67',
      realized_pnl_ils: '333.34', market_value_ils: '7333.33',
    }]);

    // Two sells at one event; the second is everything that is left. 3,333.33 then the rest, 3,333.34.
    const third = await sendSell('alice', 'TEVA', '111.11111111', ev('TASE', 'close', WED));
    const last = await sendSell('alice', 'TEVA', '111.11111111', ev('TASE', 'close', WED));
    await run(ev('TASE', 'close', WED).at);
    expect(await journalsOf(third)).toMatchObject([{ entries: ['cash_free 4000.00', 'stock_cost:TEVA -3333.33', 'realized_pnl -666.67'] }]);
    expect(await journalsOf(last)).toMatchObject([{ entries: ['cash_free 4000.00', 'stock_cost:TEVA -3333.34', 'realized_pnl -666.66'] }]);
    const [pos] = await positionsOf('alice');
    expect(pos).toMatchObject({
      status: 'closed', units: '0.00000000', reserved_units: '0.00000000', cost_basis_ils: '0.00',
      realized_pnl_ils: '1666.67', market_value_ils: '0.00', closed_at: ev('TASE', 'close', WED).at.toISOString(),
    });
    for (const id of [buy, partial, third, last]) expect((await order(id)).position_id).toBe(pos.id);
    expect(await portfolio('alice')).toMatchObject({
      cash: '1001666.6700', holdings_value: '0.00', equity: '1001666.6700', realized_pnl: '1666.67', unrealized_pnl: '0.00',
    });
    expect((await ledger('alice'))['stock_cost:TEVA']).toBe('0.00');
    expect(await eventOf('TASE', 'close', WED)).toMatchObject({ orders_executed: 2, players_updated: 1, ledger_balanced: true });
  });

  it('a sale of everything then a new buy at the same event: the old row closes before the new one opens', async () => {
    await world(israel(MON, '12:00'));
    await player('bob');
    const old = await holding('bob', 'TEVA', '100', '10000.00', { price: '100.0000', value: '10000.00', at: ev('TASE', 'close', '2026-11-06').at });
    await price('TEVA', MON, '100.0000', '110.0000');

    const sell = await sendSell('bob', 'TEVA', '100', ev('TASE', 'close', MON));
    const buy = await sendBuy('bob', 'TEVA', '5000.00', ev('TASE', 'close', MON));
    await run(ev('TASE', 'close', MON).at);

    const rows = await positionsOf('bob');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: old, status: 'closed', units: '0.00000000', cost_basis_ils: '0.00', realized_pnl_ils: '1000.00',
      closed_at: ev('TASE', 'close', MON).at.toISOString(),
    });
    expect(rows[1]).toMatchObject({
      status: 'open', units: '45.45454545', avg_cost_ils: '110.00000001', cost_basis_ils: '5000.00',
      realized_pnl_ils: '0.00', market_value_ils: '5000.00', opened_at: ev('TASE', 'close', MON).at.toISOString(),
    });
    expect(await order(sell)).toMatchObject({ status: 'executed', filled_ils: '11000.00', realized_pnl_ils: '1000.00', position_id: old });
    expect(await order(buy)).toMatchObject({ status: 'executed', filled_units: '45.45454545', position_id: rows[1].id });
    expect(await portfolio('bob')).toMatchObject({ cash: '996000.0000', holdings_value: '5000.00', realized_pnl: '1000.00', equity: '1001000.0000' });
    expect(await ledger('bob')).toMatchObject({ 'stock_cost:TEVA': '5000.00', realized_pnl: '-1000.00' });
    expect(await eventOf('TASE', 'close', MON)).toMatchObject({ orders_executed: 2, ledger_balanced: true });
  });

  it('NO_PRICE: a buy gets its cash back through a release journal, a sell gets its units back', async () => {
    await world(israel(MON, '12:00'));
    await player('alice');
    const teva = await holding('alice', 'TEVA', '10', '1000.00', { price: '100.0000', value: '1000.00', at: ev('TASE', 'close', '2026-11-06').at });
    // No TASE prices at all on Monday.
    const buy = await sendBuy('alice', 'LUMI', '1000.00', ev('TASE', 'close', MON));
    const sell = await sendSell('alice', 'TEVA', '10', ev('TASE', 'close', MON));
    await run(ev('TASE', 'close', MON).at);

    const event = await eventOf('TASE', 'close', MON);
    for (const id of [buy, sell]) {
      expect(await order(id)).toMatchObject({
        status: 'rejected', reject_code: 'NO_PRICE', reject_reason: REASONS.NO_PRICE, event_id: event.id,
        executed_at: null, fill_price: null, position_id: null,
      });
    }
    expect(await journalsOf(buy)).toEqual([
      { kind: 'reserve', world_at: expect.any(String), entries: ['cash_free -1000.00', 'cash_locked 1000.00'] },
      { kind: 'release', world_at: ev('TASE', 'close', MON).at.toISOString(), entries: ['cash_locked -1000.00', 'cash_free 1000.00'] },
    ]);
    expect(await journalsOf(sell)).toEqual([]);
    expect(await portfolio('alice')).toMatchObject({ cash: '999000.0000', reserved_cash: '0.00', equity: '1000000.0000' });
    // Not re-marked: there was no price.
    expect(await positionsOf('alice')).toMatchObject([{ id: teva, reserved_units: '0.00000000', last_price: '100.0000', marked_at: ev('TASE', 'close', '2026-11-06').at.toISOString() }]);
    expect(event).toMatchObject({ orders_executed: 0, orders_rejected: 2, ledger_balanced: true });
  });

  it('OVER_LIMIT is checked again at the execution price, and the cash is released', async () => {
    await world(israel(MON, '12:00'));
    await player('alice');
    // 1,500 TEVA marked at ₪100 = ₪150,000: 15% of ₪1,000,000. A ₪40,000 buy is 19% at that price.
    await holding('alice', 'TEVA', '1500', '150000.00', { price: '100.0000', value: '150000.00', at: ev('TASE', 'close', '2026-11-06').at });
    await price('TEVA', MON, '100.0000', '120.0000');
    const buy = await sendBuy('alice', 'TEVA', '40000.00', ev('TASE', 'close', MON));
    await run(ev('TASE', 'close', MON).at);

    // At ₪120: (180,000 + 40,000) / (850,000 + 180,000) = 21.36%.
    expect(await order(buy)).toMatchObject({
      status: 'rejected', reject_code: 'OVER_LIMIT', reject_reason: 'ההחזקה הייתה מגיעה ל־21.4% מהתיק (מותר עד 20%)',
      executed_at: null,
    });
    expect((await journalsOf(buy))[1]).toEqual({
      kind: 'release', world_at: ev('TASE', 'close', MON).at.toISOString(), entries: ['cash_locked -40000.00', 'cash_free 40000.00'],
    });
    expect(await portfolio('alice')).toMatchObject({
      cash: '850000.0000', reserved_cash: '0.00', holdings_value: '180000.00', equity: '1030000.0000', unrealized_pnl: '30000.00',
    });
    expect(await positionsOf('alice')).toMatchObject([{ units: '1500.00000000', market_value_ils: '180000.00', unrealized_pnl_ils: '30000.00' }]);
    expect(await ledger('alice')).toMatchObject({ cash_free: '850000.00', cash_locked: '0.00' });
    expect(await eventOf('TASE', 'close', MON)).toMatchObject({ orders_rejected: 1, ledger_balanced: true });
  });

  it('a late order (executes_at before this event) runs here, at this event\'s price', async () => {
    // Monday's open already ran; an order due then was missed. It runs at the next TASE event, the close.
    await world(israel(MON, '12:00'), ev('TASE', 'open', MON).at);
    await db.query(
      `INSERT INTO market_events (market, kind, day, at, status, started_at, finished_at) VALUES ('TASE', 'open', $1, $2, 'done', now(), now())`,
      [MON, ev('TASE', 'open', MON).at],
    );
    await player('alice');
    await price('TEVA', MON, '100.0000', '125.0000');
    const late = await sendBuy('alice', 'TEVA', '1000.00', ev('TASE', 'open', MON));

    const summary = await run(ev('TASE', 'close', MON).at);
    expect(summary.events).toBe(2);   // the US open and the TASE close; the done open is skipped
    expect(await order(late)).toMatchObject({
      status: 'executed', fill_price: '125.0000', filled_units: '8.00000000',
      executed_at: ev('TASE', 'close', MON).at.toISOString(), event_id: (await eventOf('TASE', 'close', MON)).id,
    });
    expect(await eventOf('TASE', 'open', MON)).toMatchObject({ orders_executed: 0 });
  });
});

// ---------- step 2: affected players ----------

describe('affected players', () => {
  it('only players holding this market (or trading at this event) change; cash-only and other-market players do not', async () => {
    await world(israel(MON, '17:00'));   // after the US open: only the TASE close runs
    for (const uid of ['alice', 'carol', 'dave']) await player(uid);
    const old = ev('TASE', 'close', '2026-11-06').at;
    await holding('alice', 'TEVA', '10', '1000.00', { price: '100.0000', value: '1000.00', at: old });
    await holding('dave', 'NVDA', '10', '5550.00', { price: '150.0000', fx: '3.7000', value: '5550.00', at: old });
    await price('TEVA', MON, '100.0000', '110.0000');
    const daveBefore = { portfolio: await portfolio('dave'), positions: await positionsOf('dave') };
    const carolBefore = await portfolio('carol');

    await run(ev('TASE', 'close', MON).at);
    expect(await portfolio('alice')).toMatchObject({
      holdings_value: '1100.00', unrealized_pnl: '100.00', equity: '1000100.0000',
      last_event_at: ev('TASE', 'close', MON).at.toISOString(), marked_at: ev('TASE', 'close', MON).at.toISOString(),
    });
    expect(await portfolio('carol')).toEqual(carolBefore);
    expect(await portfolio('dave')).toEqual(daveBefore.portfolio);
    expect(await positionsOf('dave')).toEqual(daveBefore.positions);
    expect(carolBefore).toMatchObject({ last_event_at: null, week_start: null });
    expect(await eventOf('TASE', 'close', MON)).toMatchObject({ players_updated: 1 });
  });

  it('pages by uid with tiny batches, online players first, and counts every player once', async () => {
    await world(israel(MON, '12:00'));
    const uids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    for (const uid of uids) await player(uid, { online: uid === 'p3' || uid === 'p6' });
    await player('cash-only', { online: true });
    const old = ev('TASE', 'close', '2026-11-06').at;
    for (const uid of uids) await holding(uid, 'TEVA', '10', '1000.00', { price: '100.0000', value: '1000.00', at: old });
    await price('TEVA', MON, '100.0000', '110.0000');
    await price('LUMI', MON, '10.0000', '10.0000');
    // p8 sells everything: no position left, yet affected through the order. p1 and p2 buy LUMI.
    await sendSell('p8', 'TEVA', '10', ev('TASE', 'close', MON));
    await sendBuy('p1', 'LUMI', '500.00', ev('TASE', 'close', MON));
    await sendBuy('p2', 'LUMI', '500.00', ev('TASE', 'close', MON));

    const pages: string[][] = [];
    const summary = await withClient(async (c) => {
      const query = c.query.bind(c) as (...args: unknown[]) => unknown;
      // Records the uids of every updatePlayers page (its lock query).
      (c as unknown as { query: unknown }).query = (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes('last_event_at < $2') && args[0].includes('FOR UPDATE')) {
          const page = (args[1] as unknown[])[0] as string[];
          pages.push([...page]);
        }
        return query(...args);
      };
      try {
        return await runUntil(c, ev('TASE', 'close', MON).at, { orderBatch: 1, playerBatch: 2 });
      } finally {
        (c as unknown as { query: unknown }).query = query;
      }
    });

    expect(pages).toEqual([['p3', 'p6'], ['p1', 'p2'], ['p3', 'p4'], ['p5', 'p6'], ['p7', 'p8']]);
    expect(summary).toEqual({ events: 2, ordersExecuted: 3, ordersRejected: 0, playersUpdated: 8 });
    expect(await eventOf('TASE', 'close', MON)).toMatchObject({ orders_executed: 3, players_updated: 8 });
    for (const uid of uids) expect((await portfolio(uid)).last_event_at).toBe(ev('TASE', 'close', MON).at.toISOString());
    expect((await portfolio('cash-only')).last_event_at).toBeNull();
    expect(await portfolio('p8')).toMatchObject({ holdings_value: '0.00', cash: '1000100.0000', realized_pnl: '100.00' });
    expect(await portfolio('p1')).toMatchObject({ cash: '998500.0000', holdings_value: '1600.00', equity: '1000100.0000' });
  });

  it('a page query returns uids after the cursor only, in uid order', async () => {
    await world(israel(MON, '12:00'));
    for (const uid of ['a', 'b', 'c']) {
      await player(uid);
      await holding(uid, 'TEVA', '1', '100.00');
    }
    await player('z');
    await holding('z', 'NVDA', '1', '500.00');
    const event = await withClient((c) => startEvent(c, ev('TASE', 'close', MON)));
    expect(await affectedPage(db, event, '', 2, false)).toEqual(['a', 'b']);
    expect(await affectedPage(db, event, 'b', 2, false)).toEqual(['c']);
    expect(await affectedPage(db, event, '', 10, true)).toEqual([]);   // nobody online
  });
});

// ---------- crash safety ----------

describe('crash safety: every step can be re-run and changes nothing twice', () => {
  async function threeBuyers() {
    await world(israel(MON, '17:00'));   // after the US open: the TASE close is the next event
    await price('TEVA', MON, '100.0000', '100.0000');
    for (const uid of ['a1', 'a2', 'a3']) {
      await player(uid);
      await sendBuy(uid, 'TEVA', '1000.00', ev('TASE', 'close', MON));
    }
  }

  it('step 1: one batch, a crash, then the whole event, then again', async () => {
    await threeBuyers();
    await withClient(async (c) => {
      const row = await startEvent(c, ev('TASE', 'close', MON));
      const priced = await loadEventPrices(c, row);
      expect(await runOrderBatch(c, priced, 1)).toEqual({ executed: 1, rejected: 0, done: false });
      // "Crash" here: one batch committed, the event is still pending.
      expect(await eventOf('TASE', 'close', MON)).toMatchObject({ status: 'pending', orders_executed: 1 });
      const pending = await db.query(`SELECT count(*)::int AS n FROM orders WHERE status = 'pending'`);
      expect(pending.rows[0].n).toBe(2);

      expect(await runEvent(c, row, { orderBatch: 1 })).toEqual({ events: 1, ordersExecuted: 2, ordersRejected: 0, playersUpdated: 3 });
      const once = await everything();
      expect(await runEvent(c, row, { orderBatch: 1 })).toEqual({ events: 0, ordersExecuted: 0, ordersRejected: 0, playersUpdated: 0 });
      expect(await runUntil(c, ev('TASE', 'close', MON).at)).toEqual({ events: 0, ordersExecuted: 0, ordersRejected: 0, playersUpdated: 0 });
      expect(await everything()).toEqual(once);
    });
    expect(await eventOf('TASE', 'close', MON)).toMatchObject({ status: 'done', orders_executed: 3, players_updated: 3, ledger_balanced: true });
    const buys = await db.query(`SELECT uid, count(*)::int AS n FROM journals WHERE kind = 'buy' GROUP BY uid ORDER BY uid`);
    expect(buys.rows).toEqual([{ uid: 'a1', n: 1 }, { uid: 'a2', n: 1 }, { uid: 'a3', n: 1 }]);
    for (const uid of ['a1', 'a2', 'a3']) {
      expect(await portfolio(uid)).toMatchObject({ cash: '999000.0000', reserved_cash: '0.00', holdings_value: '1000.00' });
    }
  });

  it('step 1: a failure inside a batch rolls the whole batch back; the re-run does it once', async () => {
    await threeBuyers();
    await withClient(async (c) => {
      const query = c.query.bind(c) as (...args: unknown[]) => Promise<unknown>;
      let failed = false;
      (c as unknown as { query: unknown }).query = (...args: unknown[]) => {
        if (!failed && typeof args[0] === 'string' && args[0].startsWith('UPDATE portfolios p SET cash')) {
          failed = true;
          return Promise.reject(new Error('the server went away'));
        }
        return query(...args);
      };
      try {
        await expect(runUntil(c, ev('TASE', 'close', MON).at, { orderBatch: 2 })).rejects.toThrow('the server went away');
      } finally {
        (c as unknown as { query: unknown }).query = query;
      }
    });
    // The batch's journals, positions and order statuses all rolled back with it.
    const state = await db.query(
      `SELECT (SELECT count(*)::int FROM orders WHERE status = 'pending') AS pending,
              (SELECT count(*)::int FROM journals WHERE kind = 'buy') AS buys,
              (SELECT count(*)::int FROM positions) AS positions`,
    );
    expect(state.rows[0]).toEqual({ pending: 3, buys: 0, positions: 0 });
    expect(await eventOf('TASE', 'close', MON)).toMatchObject({ status: 'pending', orders_executed: 0 });

    expect(await run(ev('TASE', 'close', MON).at, { orderBatch: 2 })).toMatchObject({ ordersExecuted: 3, playersUpdated: 3 });
    expect(await eventOf('TASE', 'close', MON)).toMatchObject({ status: 'done', orders_executed: 3, players_updated: 3 });
  });

  it('step 2: one page, a crash, then the whole event, then again', async () => {
    await world(israel(MON, '12:00'));
    await price('TEVA', MON, '100.0000', '110.0000');
    for (const uid of ['h1', 'h2', 'h3', 'h4']) {
      await player(uid);
      await holding(uid, 'TEVA', '10', '1000.00', { price: '100.0000', value: '1000.00', at: ev('TASE', 'close', '2026-11-06').at });
    }
    await withClient(async (c) => {
      const row = await startEvent(c, ev('TASE', 'close', MON));
      const priced = await loadEventPrices(c, row);
      expect(await runOrderBatch(c, priced, 10)).toEqual({ executed: 0, rejected: 0, done: true });
      expect(await updatePlayers(c, priced, ['h1', 'h2'])).toBe(2);
      // "Crash" here. A second try of the same page changes nothing.
      const afterPage = await everything();
      expect(await updatePlayers(c, priced, ['h1', 'h2'])).toBe(0);
      expect(await everything()).toEqual(afterPage);
      expect(await eventOf('TASE', 'close', MON)).toMatchObject({ status: 'orders_done', players_updated: 2 });
      expect((await portfolio('h3')).last_event_at).toBeNull();

      expect(await runEvent(c, row, { playerBatch: 2 })).toEqual({ events: 1, ordersExecuted: 0, ordersRejected: 0, playersUpdated: 2 });
      const once = await everything();
      expect(await runEvent(c, row, { playerBatch: 2 })).toMatchObject({ events: 0 });
      expect(await everything()).toEqual(once);
    });
    expect(await eventOf('TASE', 'close', MON)).toMatchObject({ status: 'done', players_updated: 4 });
    for (const uid of ['h1', 'h2', 'h3', 'h4']) {
      expect(await portfolio(uid)).toMatchObject({ holdings_value: '1100.00', equity: '1000100.0000', peak_value: '1000100.00' });
    }
  });

  it('an event started and left unfinished is finished first by the next run', async () => {
    await threeBuyers();
    await withClient((c) => startEvent(c, ev('TASE', 'close', MON)));   // started, then the process died
    expect(await eventOf('TASE', 'close', MON)).toMatchObject({ status: 'pending' });
    const clock = await db.query('SELECT events_through FROM world_clock');
    expect(iso(clock.rows[0].events_through)).toBe(ev('TASE', 'close', MON).at.toISOString());

    const summary = await run(ev('US', 'close', MON).at);
    expect(summary).toEqual({ events: 2, ordersExecuted: 3, ordersRejected: 0, playersUpdated: 3 });   // the TASE close, then the US close
    const { rows } = await db.query(`SELECT market, kind, status FROM market_events ORDER BY at`);
    expect(rows).toEqual([
      { market: 'TASE', kind: 'close', status: 'done' },
      { market: 'US', kind: 'close', status: 'done' },
    ]);
  });
});

// ---------- the week ----------

describe('the lazy weekly reset', () => {
  it('a trade at the first event of a week starts the week from the value before the trade', async () => {
    const friClose = ev('TASE', 'close', FRI);
    const monOpen = ev('TASE', 'open', NEXT_MON);
    await world(friClose.at, friClose.at);
    for (const uid of ['alice', 'bob', 'carol']) await player(uid);
    // alice and bob: 1,000 TEVA bought for ₪100,000, marked at ₪105 → ₪1,005,000. Last week's totals.
    for (const uid of ['alice', 'bob']) {
      await holding(uid, 'TEVA', '1000', '100000.00', { price: '105.0000', value: '105000.00', at: friClose.at });
    }
    await db.query(
      `UPDATE portfolios SET week_start = $1, week_start_value = 1000000, peak_value = 1010000, max_drawdown_pct = 2, last_event_at = $2`,
      [MON, friClose.at],
    );
    await price('TEVA', NEXT_MON, '100.0000', '101.0000');
    const buy = await sendBuy('alice', 'TEVA', '50000.00', monOpen);

    await run(monOpen.at);
    expect(await order(buy)).toMatchObject({ status: 'executed', fill_price: '100.0000', filled_units: '500.00000000' });
    // Week from ₪1,005,000 (before the trade), then the open re-marks at ₪100: 1,500 units → ₪150,000 + ₪850,000.
    expect(await portfolio('alice')).toMatchObject({
      cash: '850000.0000', holdings_value: '150000.00', equity: '1000000.0000',
      week_start: NEXT_MON, week_start_value: '1005000.00', peak_value: '1005000.00', max_drawdown_pct: '0.4975',
      last_event_at: monOpen.at.toISOString(),
    });
    // bob didn't trade: reset in step 2 from his value before the event.
    expect(await portfolio('bob')).toMatchObject({
      equity: '1000000.0000', week_start: NEXT_MON, week_start_value: '1005000.00', peak_value: '1005000.00',
      max_drawdown_pct: '0.4975',
    });
    // carol has nothing in the market: untouched, so her row still shows last week (her return this week is 0).
    expect(await portfolio('carol')).toMatchObject({ week_start: MON, week_start_value: '1000000.00', max_drawdown_pct: '2.0000' });
    expect(await eventOf('TASE', 'open', NEXT_MON)).toMatchObject({ median_return_pct: '-0.4975' });
  });
});

// ---------- step 3: finish ----------

describe('the median player line', () => {
  const at = ev('TASE', 'close', MON).at;

  async function equityOf(uid: string, cash: string, week?: { start: string; value: string }) {
    await player(uid);
    await db.query(
      `UPDATE portfolios SET cash = $2, week_start = $3, week_start_value = $4 WHERE uid = $1`,
      [uid, cash, week?.start ?? null, week?.value ?? null],
    );
  }

  it('is exact for an odd and an even number of players', async () => {
    await equityOf('p1', '1012345.67', { start: MON, value: '1000000.00' });   // +1.234567% → 1.2346
    await equityOf('p2', '1250000.50', { start: '2026-11-02', value: '1.00' }); // last week's row → 0
    await equityOf('p3', '900000.00', { start: MON, value: '1000000.00' });    // −10%
    expect(await medians(db, at)).toEqual({ value: '1012345.67', returnPct: '0.0000' });

    await equityOf('p4', '1600000.80', { start: MON, value: '1600000.00' });   // +0.00005% → 0.0001
    // Values 900,000.00 · 1,012,345.67 · 1,250,000.50 · 1,600,000.80: the mean of the middle two, to the agora.
    // Returns −10 · 0 · 0.0001 · 1.2346: the mean of 0 and 0.0001 is 0.00005, half up → 0.0001.
    expect(await medians(db, at)).toEqual({ value: '1131173.09', returnPct: '0.0001' });

    await equityOf('p5', '1000000.01');
    expect(await medians(db, at)).toEqual({ value: '1012345.67', returnPct: '0.0000' });
  });

  it('rounds the mean of the two middle values half up, to the agora', async () => {
    await equityOf('a', '1000000.00');
    await equityOf('b', '1000000.05');
    expect((await medians(db, at)).value).toBe('1000000.03');   // 1,000,000.025
  });

  it('gives each row the same week return as weekReturnPct() in week.ts', async () => {
    const cases: [string, string][] = [
      ['1600000.00', '1600000.80'], ['1600000.00', '1599999.20'],   // exactly half of the 4th decimal, both signs
      ['1600000.00', '1600000.79'], ['1600000.00', '1599999.21'],
      ['1000000.00', '1012345.67'], ['3.00', '4.00'], ['999999.99', '0.00'], ['1000000.00', '1000000.00'],
    ];
    await player('x');
    for (const [start, value] of cases) {
      await db.query(`UPDATE portfolios SET cash = $1, week_start = $2, week_start_value = $3 WHERE uid = 'x'`, [value, MON, start]);
      const expected = weekReturnPct(
        { weekStart: MON, weekStartValue: parse(start, SCALE.ILS), peakValue: null, maxDrawdownPct: 0n, lastEventAt: null },
        parse(value, SCALE.ILS), MON,
      );
      expect((await medians(db, at)).returnPct, `${start} → ${value}`).toBe(format(expected, SCALE.PCT));
    }
  });

  it('is stored on the event when it finishes', async () => {
    await world(israel(MON, '12:00'));
    await equityOf('a', '1000000.00');
    await equityOf('b', '1000000.05');
    await run(at);
    expect(await eventOf('TASE', 'close', MON)).toMatchObject({ median_value: '1000000.03', median_return_pct: '0.0000' });
  });
});

describe('the ledger check', () => {
  it('is true when every stored balance matches, false (and logged) when a cash column was corrupted, and the game carries on', async () => {
    await world(israel(MON, '12:00'));
    await player('alice');
    await player('bob');
    await price('TEVA', MON, '100.0000', '100.0000');
    await price('TEVA', TUE, '100.0000', '100.0000');
    await sendBuy('alice', 'TEVA', '1000.00', ev('TASE', 'close', MON));
    await run(ev('TASE', 'close', MON).at);
    expect(await eventOf('TASE', 'close', MON)).toMatchObject({ ledger_balanced: true });

    await sendBuy('bob', 'TEVA', '1000.00', ev('TASE', 'close', TUE));
    await db.query(`UPDATE portfolios SET cash = cash + 0.01 WHERE uid = 'bob'`);   // money from nowhere
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await run(ev('TASE', 'close', TUE).at);
      expect(await eventOf('TASE', 'close', TUE)).toMatchObject({ status: 'done', ledger_balanced: false });
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0][0])).toMatch(/ledger check failed .*: bob$/);
      // The next event still runs.
      await run(ev('US', 'close', TUE).at);
      expect(await eventOf('US', 'close', TUE)).toMatchObject({ status: 'done' });
    } finally {
      errors.mockRestore();
    }
  });

  it('also compares each stock\'s cost with the open position', async () => {
    await world(israel(MON, '12:00'));
    await player('alice');
    await price('TEVA', MON, '100.0000', '100.0000');
    await sendBuy('alice', 'TEVA', '1000.00', ev('TASE', 'close', MON));
    await run(ev('TASE', 'close', MON).at);
    const id = (await eventOf('TASE', 'close', MON)).id;
    await withClient(async (c) => {
      expect(await ledgerMismatches(c, id)).toEqual([]);
      await db.query(`UPDATE positions SET cost_basis_ils = cost_basis_ils - 0.01 WHERE uid = 'alice'`);
      expect(await ledgerMismatches(c, id)).toEqual(['alice']);
    });
  });
});

describe('daily chart rows', () => {
  it('are written only at the last event of a day, only for players whose value changed that day', async () => {
    await world(israel(MON, '09:00'));
    for (const uid of ['alice', 'carol', 'dave']) await player(uid);
    const old = ev('TASE', 'close', '2026-11-06').at;
    await holding('alice', 'TEVA', '10', '1000.00', { price: '100.0000', value: '1000.00', at: old });
    await holding('dave', 'NVDA', '10', '5550.00', { price: '150.0000', fx: '3.7000', value: '5550.00', at: old });
    await price('TEVA', MON, '100.0000', '101.0000');
    await price('NVDA', MON, '150.0000', '151.0000');
    await price('TEVA', TUE, '102.0000', '103.0000');
    await fx(MON, '3.7000', '3.7000');

    await run(ev('TASE', 'close', MON).at);   // TASE open, US open, TASE close: the US close is still to come
    expect(await snapshots()).toEqual([]);

    await run(ev('US', 'close', MON).at);
    const usClose = ev('US', 'close', MON).at.toISOString();
    expect(await snapshots()).toEqual([
      { uid: 'alice', at: usClose, value: '1000010.00' },   // 10 × 101 = 1,010 → 999,000 + 1,010
      { uid: 'dave', at: usClose, value: '1000037.00' },                   // 10 × 151 × 3.70 = 5,587 → 994,450 + 5,587
    ]);

    // Tuesday New York is closed (a fixture holiday): the TASE close is Tuesday's last event.
    await db.query(`INSERT INTO market_closures VALUES ('US', $1, 'חג', 'Holiday')`, [TUE]);
    await run(israel(TUE, '23:59'));
    expect((await snapshots()).slice(2)).toEqual([
      { uid: 'alice', at: ev('TASE', 'close', TUE).at.toISOString(), value: '1000030.00' },
    ]);
  });

  it('isLastEventOfDay follows the calendar', () => {
    expect(isLastEventOfDay(ev('TASE', 'close', MON), NO_CLOSURES)).toBe(false);
    expect(isLastEventOfDay(ev('US', 'open', MON), NO_CLOSURES)).toBe(false);
    expect(isLastEventOfDay(ev('US', 'close', MON), NO_CLOSURES)).toBe(true);
    const usHoliday = makeCalendar([{ market: 'US', day: TUE, reason: 'Holiday' }]);
    expect(isLastEventOfDay(ev('TASE', 'close', TUE), usHoliday)).toBe(true);
    expect(isLastEventOfDay(ev('TASE', 'open', TUE), usHoliday)).toBe(false);
  });
});

// ---------- prices ----------

describe('event prices and the USD/ILS fallback', () => {
  it('a day with no rate uses the latest earlier close', async () => {
    await world(israel(MON, '12:00'));
    await player('dave');
    await holding('dave', 'NVDA', '10', '5000.00');
    await price('NVDA', TUE, '140.0000', '150.0000');
    await fx(MON, '3.6000', '3.6800');   // Tuesday has US prices and no rate
    const buy = await sendBuy('dave', 'NVDA', '1000.00', ev('US', 'close', TUE));

    await run(ev('US', 'close', TUE).at);
    expect(await order(buy)).toMatchObject({ status: 'executed', fill_price: '150.0000', fx_rate: '3.6800' });
    expect((await positionsOf('dave'))[0]).toMatchObject({
      units: '11.81159420', last_price: '150.0000', last_fx: '3.6800', market_value_ils: '6520.00',   // 11.81159420 × 150 × 3.68
    });
    // Tuesday's open used the same fallback (Monday's close), not Monday's open.
    const open = await withClient(async (c) => loadEventPrices(c, await startEventRow(c, 'US', 'open', TUE)));
    expect(open.rate).toBe(parse('3.6800', SCALE.RATE));
  });

  it('no rate at all: the US event has no prices, so its orders are rejected NO_PRICE', async () => {
    await world(israel(MON, '12:00'));
    await player('dave');
    await price('NVDA', MON, '150.0000', '150.0000');
    const buy = await sendBuy('dave', 'NVDA', '1000.00', ev('US', 'close', MON));
    await run(ev('US', 'close', MON).at);
    expect(await order(buy)).toMatchObject({ status: 'rejected', reject_code: 'NO_PRICE' });
    expect(await portfolio('dave')).toMatchObject({ reserved_cash: '0.00', cash: '1000000.0000' });
  });

  it('takes the open at an open and the close at a close', async () => {
    await world(israel(MON, '09:00'));
    await price('TEVA', MON, '100.0000', '101.0000');
    await price('NVDA', MON, '150.0000', '151.0000');
    await fx(MON, '3.6000', '3.7000');
    await withClient(async (c) => {
      const tOpen = await loadEventPrices(c, await startEventRow(c, 'TASE', 'open', MON));
      const uClose = await loadEventPrices(c, await startEventRow(c, 'US', 'close', MON));
      expect([...tOpen.prices]).toEqual([['TEVA', parse('100.0000', SCALE.PRICE)]]);
      expect(tOpen.rate).toBe(parse('1.0000', SCALE.RATE));
      expect([...uClose.prices]).toEqual([['NVDA', parse('151.0000', SCALE.PRICE)]]);
      expect(uClose.rate).toBe(parse('3.7000', SCALE.RATE));
    });
  });
});

async function startEventRow(c: pg.PoolClient, market: Market, kind: 'open' | 'close', day: string) {
  return startEvent(c, ev(market, kind, day));
}

// ---------- D-025 ----------

describe('catchUpPlayer', () => {
  it('brings one affected player up to an event whose orders have run; the batch then skips them', async () => {
    await world(israel(MON, '12:00'));
    for (const uid of ['alice', 'bob', 'carol']) await player(uid);
    const old = ev('TASE', 'close', '2026-11-06').at;
    await holding('alice', 'TEVA', '10', '1000.00', { price: '100.0000', value: '1000.00', at: old });
    await holding('bob', 'TEVA', '10', '1000.00', { price: '100.0000', value: '1000.00', at: old });
    await price('TEVA', MON, '100.0000', '120.0000');
    expect(await catchUpPlayer(db, 'alice')).toBe(false);   // no event yet

    await withClient(async (c) => {
      const row = await startEvent(c, ev('TASE', 'close', MON));
      expect(await catchUpPlayer(db, 'alice')).toBe(false);   // started, but its orders haven't run: prices not in effect
      const priced = await loadEventPrices(c, row);
      await runOrderBatch(c, priced, 10);   // → orders_done

      expect(await catchUpPlayer(db, 'alice')).toBe(true);
      expect(await portfolio('alice')).toMatchObject({ holdings_value: '1200.00', last_event_at: row.at.toISOString() });
      expect(await catchUpPlayer(db, 'alice')).toBe(false);   // already there
      expect(await catchUpPlayer(db, 'carol')).toBe(false);   // not affected
      expect(await catchUpPlayer(db, 'nobody')).toBe(false);

      expect(await runEvent(c, row)).toMatchObject({ playersUpdated: 1 });   // bob only
    });
    expect(await eventOf('TASE', 'close', MON)).toMatchObject({ status: 'done', players_updated: 2 });
    expect(await portfolio('bob')).toMatchObject({ holdings_value: '1200.00' });
    expect((await portfolio('carol')).last_event_at).toBeNull();
  });
});

// ---------- the lock ----------

describe('withRunnerLock', () => {
  it('returns null without running when another client holds the lock, and lets go of it after a run', async () => {
    const other = await db.connect();
    try {
      await other.query('SELECT pg_advisory_lock($1)', [RUNNER_LOCK_KEY]);
      let ran = false;
      expect(await withRunnerLock(db, async () => { ran = true; return 1; })).toBeNull();
      expect(ran).toBe(false);
      await other.query('SELECT pg_advisory_unlock($1)', [RUNNER_LOCK_KEY]);

      expect(await withRunnerLock(db, async (c) => (await c.query('SELECT 2 AS n')).rows[0].n)).toBe(2);
      const free = await other.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [RUNNER_LOCK_KEY]);
      expect(free.rows[0].ok).toBe(true);
      await other.query('SELECT pg_advisory_unlock($1)', [RUNNER_LOCK_KEY]);
    } finally {
      other.release();
    }
  });

  it('lets go of the lock when the run throws', async () => {
    await expect(withRunnerLock(db, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withRunnerLock(db, async () => 'again')).toBe('again');
  });
});

// ---------- runUntil ----------

describe('runUntil', () => {
  it('does nothing without a world, and never runs past ends_at', async () => {
    expect(await run(ev('US', 'close', MON).at)).toEqual({ events: 0, ordersExecuted: 0, ordersRejected: 0, playersUpdated: 0 });
    await db.query('INSERT INTO world_clock (now_at, ends_at) VALUES ($1, $2)', [israel(MON, '09:00'), israel(MON, '16:00')]);
    expect(await run(ev('US', 'close', MON).at)).toMatchObject({ events: 1 });   // only the 10:00 TASE open
    const { rows } = await db.query('SELECT market, kind FROM market_events');
    expect(rows).toEqual([{ market: 'TASE', kind: 'open' }]);
  });

  it('a finished event has its real-time duration', async () => {
    await world(israel(MON, '12:00'));
    await run(ev('TASE', 'close', MON).at);
    const e = await eventOf('TASE', 'close', MON);
    expect(e.started_at).toBeInstanceOf(Date);
    expect(e.finished_at.getTime()).toBeGreaterThanOrEqual(e.started_at.getTime());
    expect(e.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
