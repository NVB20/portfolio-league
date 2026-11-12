// The stop loss end to end (D-037) against a real Postgres (TEST_DATABASE_URL): POST /me/orders with a stopPrice,
// the runner firing the stop at a later open or close (triggerStops in runner.ts), and what the screens read
// afterwards (trade, dashboard, journal, the seen mark, the admin's monitoring). Money is checked as the exact
// NUMERIC strings Postgres stores.
//
// The world: Wednesday 2026-11-11, 12:40 Israel time (10:40 UTC), TASE open. The trade screen's price is
// Tuesday's close (₪100), so a stop must be below it. A buy sent now fills at Wednesday's TASE close
// (15:30 UTC); its stop is first checked at Thursday's open (08:00 UTC), then Thursday's close, Friday's open.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import type { AdminMonitoring, Dashboard, TradeJournalView, TradeView } from '../src/contract.js';
import { eventsBetween } from '../src/game/clock.js';
import { NO_CLOSURES } from '../src/game/marketHours.js';
import { getAdminMonitoring } from '../src/monitoring.js';
import { ledgerMismatches, loadEventPrices, runEvent, runUntil, startEvent, triggerStops } from '../src/runner.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

const db = new pg.Pool({ connectionString: DATABASE_URL });
let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;

const TUE = '2026-11-10';
const WED = '2026-11-11';
const THU = '2026-11-12';
const FRI = '2026-11-13';
const WED_1240 = '2026-11-11T10:40:00.000Z';
const WED_TASE_CLOSE = '2026-11-11T15:30:00.000Z';
const WED_US_CLOSE = '2026-11-11T21:00:00.000Z';
const THU_TASE_OPEN = '2026-11-12T08:00:00.000Z';
const THU_TASE_CLOSE = '2026-11-12T15:30:00.000Z';
const FRI_TASE_OPEN = '2026-11-13T08:00:00.000Z';

beforeAll(async () => {
  await runner({ databaseUrl: DATABASE_URL, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
  const test = await makeTestKeys();
  privateKey = test.privateKey;
  app = createApp({ db, verifyToken: makeFirebaseVerifier(PROJECT_ID, test.keys), corsOrigins: [] });
});

beforeEach(async () => {
  await db.query('TRUNCATE users, securities, usd_ils, world_clock, market_events, market_closures CASCADE');
  await db.query(
    `INSERT INTO securities (symbol, name_he, market, exchange, currency) VALUES
       ('TEVA', 'טבע', 'TASE', 'TASE', 'ILS'), ('LUMI', 'לאומי', 'TASE', 'TASE', 'ILS'),
       ('NVDA', 'אנבידיה', 'US', 'NASDAQ', 'USD')`,
  );
  await db.query('INSERT INTO world_clock (now_at) VALUES ($1)', [WED_1240]);
  await price('TEVA', TUE, '100.0000', '100.0000');
});

afterAll(async () => {
  await db.end();
});

// ---------- helpers ----------

async function call(method: string, path: string, uid: string, body?: unknown) {
  const token = await signToken(privateKey, uid);
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function send(uid: string, body: unknown) {
  const res = await call('POST', '/me/orders', uid, body);
  return { status: res.status, body: await res.json() };
}

async function read<T>(uid: string, path: string): Promise<T> {
  const res = await call('GET', path, uid);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function signUp(uid: string) {
  expect((await call('POST', '/me', uid)).status).toBe(200);
}

async function price(symbol: string, day: string, open: string, close: string) {
  await db.query('INSERT INTO prices (symbol, day, open, close) VALUES ($1, $2, $3, $4)', [symbol, day, open, close]);
}

// A buy of TEVA with a stop, through the API. Returns the order id.
async function buyWithStop(uid: string, stop: string, amountIls = '10000.00'): Promise<string> {
  const r = await send(uid, { symbol: 'TEVA', side: 'buy', amountIls, stopPrice: stop });
  expect(r.status).toBe(201);
  return r.body.order.id;
}

async function runTo(at: string) {
  const c = await db.connect();
  try {
    return await runUntil(c, new Date(at));
  } finally {
    c.release();
  }
}

async function stopsOf(uid: string) {
  const { rows } = await db.query(
    `SELECT id::text, status, stop_price::text, units::text, activation_price::text, activated_at, ended_at,
            event_id::text, sell_order_id::text
     FROM stop_orders WHERE uid = $1 ORDER BY id`,
    [uid],
  );
  return rows.map((r) => ({ ...r, activated_at: r.activated_at.toISOString(), ended_at: r.ended_at?.toISOString() ?? null }));
}

async function stopSells(uid: string) {
  const { rows } = await db.query(
    `SELECT id::text, status, units::text, fill_price::text, filled_ils::text, realized_pnl_ils::text, price_type,
            stop_id::text, executes_at
     FROM orders WHERE uid = $1 AND origin = 'stop' ORDER BY id`,
    [uid],
  );
  return rows.map((r) => ({ ...r, executes_at: r.executes_at.toISOString() }));
}

async function positionsOf(uid: string) {
  const { rows } = await db.query(
    `SELECT id::text, status, units::text, reserved_units::text FROM positions WHERE uid = $1 ORDER BY id`,
    [uid],
  );
  return rows;
}

async function eventId(kind: 'open' | 'close', day: string): Promise<string> {
  const { rows } = await db.query(`SELECT id::text FROM market_events WHERE market = 'TASE' AND kind = $1 AND day = $2`, [kind, day]);
  return rows[0].id;
}

async function ledger(uid: string): Promise<Record<string, string>> {
  const { rows } = await db.query<{ k: string; total: string }>(
    `SELECT account || COALESCE(':' || symbol, '') AS k, sum(amount)::text AS total
     FROM ledger_entries WHERE uid = $1 GROUP BY 1 ORDER BY 1`,
    [uid],
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.total]));
}

// ---------- sending ----------

describe('POST /me/orders with a stop loss', () => {
  beforeEach(async () => {
    await signUp('alice');
  });

  it('stores a stop below the latest close with the buy', async () => {
    const r = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '10000.00', stopPrice: '95.5' });
    expect(r.status).toBe(201);
    expect(r.body.order).toMatchObject({ side: 'buy', stopPrice: 95.5 });
    const { rows } = await db.query(`SELECT stop_price::text, origin FROM orders WHERE id = $1`, [r.body.order.id]);
    expect(rows[0]).toEqual({ stop_price: '95.5000', origin: 'player' });

    const trade = await read<TradeView>('alice', '/me/trade');
    expect(trade.pendingOrders).toMatchObject([{ id: r.body.order.id, stopPrice: 95.5 }]);
  });

  it('a buy without a stop stores none', async () => {
    const r = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '10000.00' });
    expect(r.status).toBe(201);
    expect(r.body.order.stopPrice).toBeNull();
  });

  it('refuses a stop at or above the latest close, and writes nothing', async () => {
    for (const stopPrice of ['100', '100.0001', '150']) {
      const r = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '10000.00', stopPrice });
      expect(r).toMatchObject({ status: 422, body: { code: 'STOP_NOT_BELOW_PRICE', reason: expect.any(String) } });
    }
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM orders`);
    expect(rows[0].n).toBe(0);
  });

  it('refuses a stop on a stock with no known close', async () => {
    const r = await send('alice', { symbol: 'LUMI', side: 'buy', amountIls: '10000.00', stopPrice: '5' });
    expect(r).toMatchObject({ status: 422, body: { code: 'STOP_NO_PRICE' } });
  });

  it('answers 400 for a stop on a sell, or a stop that is not a positive price', async () => {
    expect((await send('alice', { symbol: 'TEVA', side: 'sell', units: '1', stopPrice: '95' })).status).toBe(400);
    for (const stopPrice of ['0', '-5', '95.12345', 'abc', 95.12345, true]) {
      expect((await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '10000.00', stopPrice })).status).toBe(400);
    }
  });

  it('a replay with a different stop is a different order', async () => {
    const body = { symbol: 'TEVA', side: 'buy', amountIls: '10000.00', stopPrice: '95', clientOrderId: 'abc' };
    expect((await send('alice', body)).status).toBe(201);
    expect(await send('alice', body)).toMatchObject({ status: 200, body: { replay: true, order: { stopPrice: 95 } } });
    expect(await send('alice', { ...body, stopPrice: '94' })).toMatchObject({ status: 409, body: { code: 'CLIENT_ID_CONFLICT' } });
    expect(await send('alice', { ...body, stopPrice: undefined })).toMatchObject({ status: 409, body: { code: 'CLIENT_ID_CONFLICT' } });
  });
});

// ---------- the runner ----------

describe('the runner fires a stop at a later open or close', () => {
  beforeEach(async () => {
    await signUp('alice');
  });

  it('sells at the close that reached the stop, with the exact ledger, and every screen shows it', async () => {
    await price('TEVA', WED, '100.0000', '100.0000');
    await price('TEVA', THU, '97.0000', '94.0000');
    const buy = await buyWithStop('alice', '95');

    await runTo(WED_TASE_CLOSE);   // the buy fills at ₪100: 100 units, and its stop becomes active
    const [active] = await stopsOf('alice');
    expect(active).toMatchObject({
      status: 'active', stop_price: '95.0000', units: '100.00000000', activation_price: '100.0000',
      activated_at: WED_TASE_CLOSE, ended_at: null, event_id: null, sell_order_id: null,
    });
    const dash = await read<Dashboard>('alice', '/me/dashboard');
    expect(dash.holdings).toMatchObject([{ symbol: 'TEVA', stops: [{ price: 95, units: 100 }] }]);
    const trade = await read<TradeView>('alice', '/me/trade');
    expect(trade.securities.find((s) => s.symbol === 'TEVA')?.holding?.stops).toEqual([{ price: 95, units: 100 }]);

    await runTo(THU_TASE_OPEN);    // ₪97 is above the stop
    expect((await stopsOf('alice'))[0].status).toBe('active');
    expect(await stopSells('alice')).toEqual([]);

    await runTo(THU_TASE_CLOSE);   // ₪94: at or below ₪95, sold at the close
    const [sell] = await stopSells('alice');
    expect(sell).toMatchObject({
      status: 'executed', units: '100.00000000', fill_price: '94.0000', filled_ils: '9400.00', realized_pnl_ils: '-600.00',
      price_type: 'close', stop_id: active.id, executes_at: THU_TASE_CLOSE,
    });
    expect(await stopsOf('alice')).toMatchObject([
      { status: 'triggered', ended_at: THU_TASE_CLOSE, event_id: await eventId('close', THU), sell_order_id: sell.id },
    ]);
    expect(await positionsOf('alice')).toMatchObject([{ status: 'closed', units: '0.00000000', reserved_units: '0.00000000' }]);
    expect(await ledger('alice')).toMatchObject({ cash_free: '999400.00', cash_locked: '0.00', 'stock_cost:TEVA': '0.00', realized_pnl: '600.00' });
    expect(await ledgerMismatches(db, ['alice'])).toEqual([]);

    // The toast, then the seen mark.
    const after = await read<Dashboard>('alice', '/me/dashboard');
    expect(after.holdings).toEqual([]);
    expect(after.stopSales).toMatchObject([
      { id: sell.id, symbol: 'TEVA', currency: 'ILS', stopPrice: 95, fillPrice: 94, units: 100, ils: 9400, realizedPnlIls: -600 },
    ]);
    const seen = await call('POST', '/me/rejections/seen', 'alice', { ids: [sell.id] });
    expect(await seen.json()).toEqual({ marked: 1 });
    expect((await read<Dashboard>('alice', '/me/dashboard')).stopSales).toEqual([]);

    // The journal: the stop's sell and the buy that set it.
    const journal = await read<TradeJournalView>('alice', '/me/journal?period=all');
    expect(journal.rows).toMatchObject([
      { id: sell.id, side: 'sell', origin: 'stop', stopPrice: 95, status: 'executed' },
      { id: buy, side: 'buy', origin: 'player', stopPrice: 95, status: 'executed' },
    ]);

    // The admin's monitoring: the stop's sell isn't an order the player sent.
    const m: AdminMonitoring = await getAdminMonitoring(db);
    expect(m.totals.today.orders).toEqual({ sent: 1, executed: 1, rejected: 0, pending: 0 });
    expect(m.totals.today.stops).toEqual({ buys: 1, withStop: 1, buyers: 1, players: 1, fired: 1, firedPnlIls: -600 });
    expect(m.stopsNow).toEqual({ active: 0, players: 0 });
  });

  it('never fires at its own buy, and fires at the first check when the buy filled below the stop', async () => {
    await price('TEVA', WED, '100.0000', '90.0000');   // the buy fills at ₪90, under its ₪95 stop
    await price('TEVA', THU, '120.0000', '121.0000');
    await buyWithStop('alice', '95');

    await runTo(WED_TASE_CLOSE);
    expect(await stopsOf('alice')).toMatchObject([{ status: 'active', activation_price: '90.0000' }]);
    expect(await stopSells('alice')).toEqual([]);

    await runTo(THU_TASE_OPEN);   // the first check sells at the next price, whatever it is
    expect(await stopSells('alice')).toMatchObject([{ status: 'executed', fill_price: '120.0000', price_type: 'open' }]);
  });

  it('stays while the price is above it, and a gap down sells at the open, below the stop', async () => {
    await price('TEVA', WED, '100.0000', '100.0000');
    await price('TEVA', THU, '97.0000', '96.0000');
    await price('TEVA', FRI, '90.0000', '91.0000');
    await buyWithStop('alice', '95');

    await runTo(THU_TASE_CLOSE);
    expect(await stopsOf('alice')).toMatchObject([{ status: 'active' }]);

    await runTo(FRI_TASE_OPEN);
    expect(await stopSells('alice')).toMatchObject([
      { status: 'executed', units: '100.00000000', fill_price: '90.0000', filled_ils: '9000.00', price_type: 'open' },
    ]);
  });

  it('expires when the player sells everything by hand', async () => {
    await price('TEVA', WED, '100.0000', '100.0000');
    await price('TEVA', THU, '100.0000', '80.0000');
    await buyWithStop('alice', '95');
    await runTo(WED_TASE_CLOSE);

    // Sent after the close: it sells at Thursday's open.
    expect((await send('alice', { symbol: 'TEVA', side: 'sell', units: '100' })).status).toBe(201);
    await runTo(THU_TASE_OPEN);
    expect(await stopsOf('alice')).toMatchObject([
      { status: 'expired', ended_at: THU_TASE_OPEN, event_id: await eventId('open', THU), sell_order_id: null },
    ]);

    await runTo(THU_TASE_CLOSE);   // ₪80 would have fired it
    expect(await stopSells('alice')).toEqual([]);
    expect(await ledgerMismatches(db, ['alice'])).toEqual([]);
  });

  it('sells only what a partial hand sale left', async () => {
    await price('TEVA', WED, '100.0000', '100.0000');
    await price('TEVA', THU, '100.0000', '90.0000');
    await buyWithStop('alice', '95');
    await runTo(WED_TASE_CLOSE);

    expect((await send('alice', { symbol: 'TEVA', side: 'sell', units: '60' })).status).toBe(201);
    await runTo(THU_TASE_CLOSE);
    expect(await stopSells('alice')).toMatchObject([{ status: 'executed', units: '40.00000000', fill_price: '90.0000' }]);
    expect(await positionsOf('alice')).toMatchObject([{ status: 'closed' }]);
    expect(await ledgerMismatches(db, ['alice'])).toEqual([]);
  });

  it('a re-run fires nothing twice, and small batches still reach every stop', async () => {
    await price('TEVA', WED, '100.0000', '100.0000');
    await price('TEVA', THU, '90.0000', '90.0000');
    for (const uid of ['bob', 'carol']) await signUp(uid);
    for (const uid of ['alice', 'bob', 'carol']) await buyWithStop(uid, '95');
    await runTo(WED_US_CLOSE);

    const open = eventsBetween(new Date(WED_US_CLOSE), new Date(THU_TASE_CLOSE), NO_CLOSURES)
      .find((e) => e.market === 'TASE' && e.kind === 'open')!;
    const c = await db.connect();
    try {
      const row = await startEvent(c, open);
      const priced = await loadEventPrices(c, row);
      expect(await triggerStops(c, priced, 1)).toBe(3);   // one stop per batch, three batches
      expect(await triggerStops(c, priced, 1)).toBe(0);   // a re-run (a crash before the orders ran)
      await runEvent(c, row, { orderBatch: 1 });
    } finally {
      c.release();
    }
    for (const uid of ['alice', 'bob', 'carol']) {
      expect(await stopSells(uid)).toMatchObject([{ status: 'executed', units: '100.00000000', fill_price: '90.0000' }]);
      expect(await stopsOf(uid)).toMatchObject([{ status: 'triggered' }]);
    }
    expect(await ledgerMismatches(db, ['alice', 'bob', 'carol'])).toEqual([]);
  });

  it("a stop's sell doesn't count toward the player's 5 orders a minute", async () => {
    await price('TEVA', WED, '100.0000', '100.0000');
    await price('TEVA', THU, '90.0000', '90.0000');
    await buyWithStop('alice', '95');
    await runTo(THU_TASE_OPEN);
    expect(await stopSells('alice')).toHaveLength(1);

    // 1 sent + 1 stop sell in the last minute: 4 more may be sent, the 5th is refused.
    for (let i = 0; i < 4; i++) expect((await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000.00' })).status).toBe(201);
    expect((await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000.00' })).status).toBe(429);
  });
});

// ---------- the database's own checks ----------

describe('the database keeps stops consistent', () => {
  it("refuses a stop on a sell or a stop's order, a stop's order naming no stop, and a player's order naming one", async () => {
    await signUp('alice');
    const insert = (side: string, amount: string | null, units: string | null, stop: string | null, origin: string) =>
      db.query(
        `INSERT INTO orders (uid, symbol, side, amount_ils, units, placed_at, executes_at, price_type, stop_price, origin)
         VALUES ('alice', 'TEVA', $1, $2, $3, now(), now(), 'open', $4, $5)`,
        [side, amount, units, stop, origin],
      );
    await expect(insert('sell', null, '1', '95', 'player')).rejects.toThrow(/orders_stop_price_check/);
    await expect(insert('buy', '100', null, '0', 'player')).rejects.toThrow(/orders_stop_price_check/);
    await expect(insert('sell', null, '1', null, 'stop')).rejects.toThrow(/orders_stop_sell_check/);
    await expect(insert('buy', '100', null, null, 'stop')).rejects.toThrow(/orders_stop_sell_check/);
    await expect(insert('buy', '100', null, null, 'robot')).rejects.toThrow(/orders_origin_check/);
  });
});
