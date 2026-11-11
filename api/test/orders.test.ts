// POST /me/orders against a real Postgres (TEST_DATABASE_URL): the send transaction, the reserve journal,
// replays, the rate limit and the locks (D-018, D-019, D-020, D-021, D-028). Money is checked as the exact
// NUMERIC strings Postgres stores, never as floats.
//
// The seeded world: Wednesday 2026-11-11, 12:40 Israel time (10:40 UTC). TASE is open (it closes at 17:30
// Israel = 15:30 UTC); New York opens at 16:30 Israel (14:30 UTC) and closes at 23:00 (21:00 UTC).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { sendOrder } from '../src/orders.js';
import { startEvent } from '../src/runner.js';
import type { MarketEvent } from '../src/game/marketHours.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

const db = new pg.Pool({ connectionString: DATABASE_URL });
let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;

const WED_1240 = '2026-11-11T10:40:00.000Z';
const TASE_CLOSE = '2026-11-11T15:30:00.000Z';
const US_OPEN = '2026-11-11T14:30:00.000Z';
const US_CLOSE = '2026-11-11T21:00:00.000Z';
const THU_TASE_OPEN = '2026-11-12T08:00:00.000Z';

beforeAll(async () => {
  await runner({ databaseUrl: DATABASE_URL, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
  const test = await makeTestKeys();
  privateKey = test.privateKey;
  app = createApp({ db, verifyToken: makeFirebaseVerifier(PROJECT_ID, test.keys), corsOrigins: [] });
});

beforeEach(async () => {
  await db.query('TRUNCATE users, securities, usd_ils, world_clock, market_events CASCADE');
  await db.query(
    `INSERT INTO securities (symbol, name_he, market, exchange, currency) VALUES
       ('TEVA', 'טבע', 'TASE', 'TASE', 'ILS'), ('ESLT', 'אלביט', 'TASE', 'TASE', 'ILS'),
       ('NVDA', 'אנבידיה', 'US', 'NASDAQ', 'USD'), ('AAPL', 'אפל', 'US', 'NASDAQ', 'USD')`,
  );
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
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function send(uid: string, body: unknown) {
  const res = await call('POST', '/me/orders', uid, body);
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get('Retry-After') };
}

async function signUp(uid: string) {
  expect((await call('POST', '/me', uid)).status).toBe(200);
}

async function startWorld(opts: { nowAt?: string; eventsThrough?: string | null; endsAt?: string | null } = {}) {
  await db.query(`INSERT INTO world_clock (now_at, events_through, ends_at) VALUES ($1, $2, $3)`, [
    opts.nowAt ?? WED_1240, opts.eventsThrough ?? null, opts.endsAt ?? null,
  ]);
}

async function portfolio(uid: string) {
  const { rows } = await db.query(
    `SELECT cash, reserved_cash, available_cash, equity FROM portfolios WHERE uid = $1`,
    [uid],
  );
  return rows[0];
}

// The ledger's balance per account, as exact NUMERIC strings.
async function ledger(uid: string): Promise<Record<string, string>> {
  const { rows } = await db.query<{ account: string; total: string }>(
    `SELECT account || coalesce(':' || symbol, '') AS account, sum(amount)::text AS total
     FROM ledger_entries WHERE uid = $1 GROUP BY 1 ORDER BY 1`,
    [uid],
  );
  return Object.fromEntries(rows.map((r) => [r.account, r.total]));
}

// Everything a refused send must leave alone.
async function written(uid: string) {
  const { rows } = await db.query(
    `SELECT (SELECT count(*)::int FROM orders WHERE uid = $1) AS orders,
            (SELECT count(*)::int FROM journals WHERE uid = $1) AS journals,
            (SELECT reserved_cash FROM portfolios WHERE uid = $1) AS reserved_cash,
            (SELECT coalesce(json_agg(reserved_units ORDER BY symbol), '[]') FROM positions WHERE uid = $1) AS reserved_units`,
    [uid],
  );
  return rows[0];
}

// A fixture position bought earlier: its cost moves from cash_free to stock_cost in a balanced journal
// (a 'reversal' needs no order), and the stored totals follow, so the ledger and the columns agree.
async function givePosition(
  uid: string,
  symbol: string,
  units: string,
  cost: string,
  mark: { price: string; fx?: string; value: string },
) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `WITH j AS (INSERT INTO journals (uid, kind) VALUES ($1, 'reversal') RETURNING id)
       INSERT INTO ledger_entries (journal_id, uid, account, symbol, amount)
       SELECT j.id, $1, e.account, e.symbol, e.amount
       FROM j CROSS JOIN (VALUES ('cash_free', NULL, -($3::numeric)), ('stock_cost', $2, $3::numeric)) AS e (account, symbol, amount)`,
      [uid, symbol, cost],
    );
    await c.query(`UPDATE portfolios SET cash = cash - $2::numeric, holdings_value = holdings_value + $3::numeric WHERE uid = $1`, [
      uid, cost, mark.value,
    ]);
    await c.query(
      `INSERT INTO positions (uid, symbol, units, avg_cost_ils, cost_basis_ils, last_price, last_fx, market_value_ils,
                              unrealized_pnl_ils, marked_at, opened_at)
       VALUES ($1, $2, $3::numeric, round($4::numeric / $3::numeric, 8), $4::numeric, $5::numeric, $6::numeric, $7::numeric,
               $7::numeric - $4::numeric, '2026-11-10T15:30:00Z', '2026-11-09T15:30:00Z')`,
      [uid, symbol, units, cost, mark.price, mark.fx ?? null, mark.value],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

const worldTime = (at: string, date: string, weekday: number, time: string) => ({ at, date, weekday, time });

// ---------- a buy ----------

describe('POST /me/orders: a buy', () => {
  beforeEach(async () => {
    await startWorld();
    await signUp('alice');
  });

  it('reserves the cash in a journal and in reserved_cash (the worked example)', async () => {
    const res = await send('alice', { symbol: 'NVDA', side: 'buy', amountIls: '100000.00' });
    expect(res.status).toBe(201);
    expect(res.retryAfter).toBeNull();
    const id = res.body.order.id;
    expect(res.body).toEqual({
      replay: false,
      order: {
        id,
        symbol: 'NVDA',
        side: 'buy',
        amountIls: 100000,
        units: null,
        priceType: 'open',                                    // New York hasn't opened yet
        market: 'US',
        executesAt: worldTime(US_OPEN, '2026-11-11', 3, '16:30'),
        stopPrice: null,
        status: 'pending',
        placedAt: worldTime(WED_1240, '2026-11-11', 3, '12:40'),
        clientOrderId: null,
      },
    });

    const order = await db.query(
      `SELECT status, amount_ils, units, placed_at, executes_at, price_type, event_id FROM orders WHERE id = $1`,
      [id],
    );
    expect(order.rows[0]).toEqual({
      status: 'pending', amount_ils: '100000.00', units: null, placed_at: new Date(WED_1240),
      executes_at: new Date(US_OPEN), price_type: 'open', event_id: null,
    });

    const journal = await db.query(
      `SELECT j.kind, j.order_id::text AS order_id, j.world_at, json_agg(json_build_object('account', e.account, 'amount', e.amount::text) ORDER BY e.account) AS entries
       FROM journals j JOIN ledger_entries e ON e.journal_id = j.id
       WHERE j.uid = 'alice' AND j.kind = 'reserve' GROUP BY j.id`,
    );
    expect(journal.rows).toEqual([{
      kind: 'reserve', order_id: id, world_at: new Date(WED_1240),
      entries: [{ account: 'cash_free', amount: '-100000.00' }, { account: 'cash_locked', amount: '100000.00' }],
    }]);

    expect(await portfolio('alice')).toEqual({
      cash: '1000000.0000', reserved_cash: '100000.00', available_cash: '900000.0000', equity: '1000000.0000',
    });
    // The stored balances equal their ledger accounts (D-019).
    expect(await ledger('alice')).toEqual({ capital: '-1000000.00', cash_free: '900000.00', cash_locked: '100000.00' });
  });

  it('a TASE buy while TASE is open runs at today\'s close', async () => {
    const res = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: 2500.5 });
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({
      priceType: 'close', market: 'TASE', amountIls: 2500.5,
      executesAt: worldTime(TASE_CLOSE, '2026-11-11', 3, '17:30'),
    });
    expect((await portfolio('alice')).reserved_cash).toBe('2500.50');
  });

  it('adds up several reserves exactly', async () => {
    for (const amountIls of ['1000.01', '2000.02', '3000.03']) {
      expect((await send('alice', { symbol: 'TEVA', side: 'buy', amountIls })).status).toBe(201);
    }
    expect(await portfolio('alice')).toMatchObject({ reserved_cash: '6000.06', available_cash: '993999.9400' });
    expect(await ledger('alice')).toMatchObject({ cash_free: '993999.94', cash_locked: '6000.06' });
  });
});

// ---------- a sell ----------

describe('POST /me/orders: a sell', () => {
  beforeEach(async () => {
    await startWorld();
    await signUp('alice');
    await givePosition('alice', 'TEVA', '100', '13000.00', { price: '132.6000', value: '13260.00' });
  });

  it('locks the units and moves no money', async () => {
    const journalsBefore = (await written('alice')).journals;
    const res = await send('alice', { symbol: 'TEVA', side: 'sell', units: '40.5' });
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ side: 'sell', amountIls: null, units: 40.5, priceType: 'close', status: 'pending' });

    const { rows } = await db.query(`SELECT units, amount_ils FROM orders WHERE id = $1`, [res.body.order.id]);
    expect(rows[0]).toEqual({ units: '40.50000000', amount_ils: null });
    const pos = await db.query(`SELECT units, reserved_units FROM positions WHERE uid = 'alice' AND status = 'open'`);
    expect(pos.rows[0]).toEqual({ units: '100.00000000', reserved_units: '40.50000000' });
    const after = await written('alice');
    expect(after.journals).toBe(journalsBefore);       // units aren't money: no journal until it fills
    expect(after.reserved_cash).toBe('0.00');
  });

  it('can sell every free unit, and not one unit more', async () => {
    expect((await send('alice', { symbol: 'TEVA', side: 'sell', units: '40.5' })).status).toBe(201);
    expect((await send('alice', { symbol: 'TEVA', side: 'sell', units: '59.5' })).status).toBe(201);
    const pos = await db.query(`SELECT reserved_units FROM positions WHERE uid = 'alice' AND status = 'open'`);
    expect(pos.rows[0].reserved_units).toBe('100.00000000');

    const before = await written('alice');
    const res = await send('alice', { symbol: 'TEVA', side: 'sell', units: '0.00000001' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'not enough free units', code: 'INSUFFICIENT_UNITS', reason: 'אין מספיק יחידות למכירה' });
    expect(await written('alice')).toEqual(before);
  });

  it('a US sell while New York is closed runs at its next open', async () => {
    await givePosition('alice', 'NVDA', '2', '1000.00', { price: '150.0000', fx: '3.7000', value: '1110.00' });
    const res = await send('alice', { symbol: 'NVDA', side: 'sell', units: 1 });
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ market: 'US', priceType: 'open', executesAt: { at: US_OPEN, time: '16:30' } });
  });
});

// ---------- refusals ----------

describe('POST /me/orders: refused by the rules (422, nothing written)', () => {
  beforeEach(async () => {
    await startWorld();
    await signUp('alice');
  });

  async function refused(body: unknown, code: string, error: string, reason?: string | RegExp) {
    const before = await written('alice');
    const res = await send('alice', body);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error, code });
    if (reason instanceof RegExp) expect(res.body.reason).toMatch(reason);
    else expect(res.body.reason).toBe(reason);
    expect(await written('alice')).toEqual(before);
  }

  it('BELOW_MIN: a buy under ₪100', async () => {
    await refused({ symbol: 'TEVA', side: 'buy', amountIls: '99.99' }, 'BELOW_MIN', 'the smallest order is ₪100', 'הסכום המינימלי להזמנה הוא ₪100');
    expect((await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '100.00' })).status).toBe(201);
  });

  it('BELOW_MIN: a sale worth under ₪100 at the last mark, unless it sells every free unit', async () => {
    await givePosition('alice', 'TEVA', '100', '13000.00', { price: '132.6000', value: '13260.00' });
    // 0.5 × 132.60 = 66.30
    await refused({ symbol: 'TEVA', side: 'sell', units: '0.5' }, 'BELOW_MIN', 'the smallest order is ₪100', /כל היחידות הפנויות/);

    await givePosition('alice', 'ESLT', '0.5', '60.00', { price: '132.6000', value: '66.30' });
    const res = await send('alice', { symbol: 'ESLT', side: 'sell', units: '0.5' });
    expect(res.status).toBe(201);
  });

  it('INSUFFICIENT_CASH: more than cash − reserved cash', async () => {
    // ₪850,000 in TEVA: ₪150,000 cash left, equity still ₪1,000,000.
    await givePosition('alice', 'TEVA', '6410.25641025', '850000.00', { price: '132.6000', value: '850000.00' });
    expect(await portfolio('alice')).toMatchObject({ cash: '150000.0000', equity: '1000000.0000' });
    await refused({ symbol: 'NVDA', side: 'buy', amountIls: '150000.01' }, 'INSUFFICIENT_CASH', 'not enough available cash', 'אין מספיק מזומן פנוי');

    expect((await send('alice', { symbol: 'NVDA', side: 'buy', amountIls: '100000.00' })).status).toBe(201);
    // ₪50,000 is still free; the reserved ₪100,000 is not.
    await refused({ symbol: 'AAPL', side: 'buy', amountIls: '50000.01' }, 'INSUFFICIENT_CASH', 'not enough available cash', 'אין מספיק מזומן פנוי');
    expect((await send('alice', { symbol: 'AAPL', side: 'buy', amountIls: '50000.00' })).status).toBe(201);
    expect(await portfolio('alice')).toMatchObject({ reserved_cash: '150000.00', available_cash: '0.0000' });
  });

  it('NO_POSITION: selling a stock the player doesn\'t hold', async () => {
    await refused({ symbol: 'NVDA', side: 'sell', units: '1' }, 'NO_POSITION', 'you hold no units of this security', 'אין לך יחידות של נייר הערך הזה');
  });

  it('INSUFFICIENT_UNITS: more than the units not already locked by a pending sell', async () => {
    await givePosition('alice', 'TEVA', '10', '1300.00', { price: '132.6000', value: '1326.00' });
    expect((await send('alice', { symbol: 'TEVA', side: 'sell', units: '6' })).status).toBe(201);
    await refused({ symbol: 'TEVA', side: 'sell', units: '4.00000001' }, 'INSUFFICIENT_UNITS', 'not enough free units', 'אין מספיק יחידות למכירה');
  });

  it('OVER_LIMIT: over 20% of the stored equity, with the holding at its last mark', async () => {
    await refused(
      { symbol: 'NVDA', side: 'buy', amountIls: '200000.01' }, 'OVER_LIMIT', 'the holding would be over 20% of the portfolio',
      'ההחזקה הייתה מגיעה ל־20.1% מהתיק (מותר עד 20%)',
    );
    await givePosition('alice', 'TEVA', '1000', '100000.00', { price: '150.0000', value: '150000.00' });
    // Equity is now 1,050,000: room for 210,000 of TEVA, of which 150,000 is held.
    await refused(
      { symbol: 'TEVA', side: 'buy', amountIls: '60000.01' }, 'OVER_LIMIT', 'the holding would be over 20% of the portfolio',
      'ההחזקה הייתה מגיעה ל־20.1% מהתיק (מותר עד 20%)',
    );
    expect((await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '60000.00' })).status).toBe(201);
  });

  it('OVER_LIMIT: this player\'s pending buys of the same stock count (D-028)', async () => {
    expect((await send('alice', { symbol: 'NVDA', side: 'buy', amountIls: '150000.00' })).status).toBe(201);
    await refused(
      { symbol: 'NVDA', side: 'buy', amountIls: '50000.01' }, 'OVER_LIMIT', 'the holding would be over 20% of the portfolio',
      'ההחזקה הייתה מגיעה ל־20.1% מהתיק (מותר עד 20%)',
    );
    // Another stock, or another player's orders, don't count.
    expect((await send('alice', { symbol: 'AAPL', side: 'buy', amountIls: '200000.00' })).status).toBe(201);
    await signUp('bob');
    expect((await send('bob', { symbol: 'NVDA', side: 'buy', amountIls: '200000.00' })).status).toBe(201);
  });
});

// ---------- bad requests ----------

describe('POST /me/orders: bad requests', () => {
  beforeEach(async () => {
    await startWorld();
    await signUp('alice');
  });

  it('400 BAD_REQUEST for a body it can\'t read exactly, before anything is locked', async () => {
    for (const body of [
      'not json',
      { symbol: 'TEVA', side: 'buy', units: '5' },
      { symbol: 'TEVA', side: 'buy', amountIls: '1e5' },
      { symbol: 'TEVA', side: 'buy', amountIls: '100.001' },
      { symbol: 'TEVA', side: 'sell', units: -1 },
      { symbol: 'teva', side: 'buy', amountIls: '100' },
    ]) {
      const res = await send('alice', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(typeof res.body.error).toBe('string');
    }
    expect((await written('alice')).orders).toBe(0);
  });

  it('400 for a JSON number with more digits than a double holds: never stored as the rounded order (D-028)', async () => {
    // JSON.parse alone reads 100.0000000000000001 as 100 and 99.999999999999999 as 100 (past the ₪100 minimum).
    for (const raw of [
      '{"symbol":"TEVA","side":"buy","amountIls":100.0000000000000001}',
      '{"symbol":"TEVA","side":"buy","amountIls":99.999999999999999}',
      '{"symbol":"TEVA","side":"buy","amountIls":1e3}',
    ]) {
      const res = await send('alice', raw);
      expect(res.status, raw).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    }
    expect((await written('alice')).orders).toBe(0);
    // An exact JSON number is still fine.
    const ok = await send('alice', '{"symbol":"TEVA","side":"buy","amountIls":100.50}');
    expect(ok.status).toBe(201);
    expect(ok.body.order.amountIls).toBe(100.5);
  });

  it('404 UNKNOWN_SYMBOL for a well-formed ticker that isn\'t in the game', async () => {
    const res = await send('alice', { symbol: 'NOPE', side: 'buy', amountIls: '1000' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unknown symbol', code: 'UNKNOWN_SYMBOL' });
  });
});

// ---------- clientOrderId ----------

describe('POST /me/orders: clientOrderId', () => {
  beforeEach(async () => {
    await startWorld();
    await signUp('alice');
  });

  it('the same id and the same order again returns the stored order: no new row, no second reserve', async () => {
    const first = await send('alice', { symbol: 'NVDA', side: 'buy', amountIls: '100000.00', clientOrderId: 'abc-1' });
    expect(first.status).toBe(201);
    expect(first.body.order.clientOrderId).toBe('abc-1');

    // The size as a JSON number is the same order.
    const again = await send('alice', { symbol: 'NVDA', side: 'buy', amountIls: 100000, clientOrderId: 'abc-1' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ replay: true, order: first.body.order });

    expect(await written('alice')).toMatchObject({ orders: 1, journals: 2, reserved_cash: '100000.00' });   // start + 1 reserve
    expect(await ledger('alice')).toMatchObject({ cash_locked: '100000.00' });
  });

  it('a different order under the same id is 409 CLIENT_ID_CONFLICT', async () => {
    await send('alice', { symbol: 'NVDA', side: 'buy', amountIls: '1000.00', clientOrderId: 'abc-1' });
    for (const body of [
      { symbol: 'NVDA', side: 'buy', amountIls: '1000.01', clientOrderId: 'abc-1' },
      { symbol: 'AAPL', side: 'buy', amountIls: '1000.00', clientOrderId: 'abc-1' },
    ]) {
      const res = await send('alice', body);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CLIENT_ID_CONFLICT' });
    }
    await givePosition('alice', 'NVDA', '10', '5000.00', { price: '150.0000', fx: '3.7000', value: '5550.00' });
    expect((await send('alice', { symbol: 'NVDA', side: 'sell', units: '1', clientOrderId: 'abc-1' })).status).toBe(409);
    expect((await written('alice')).orders).toBe(1);
  });

  it('is per player: another player may use the same id', async () => {
    await signUp('bob');
    expect((await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000', clientOrderId: 'same' })).status).toBe(201);
    expect((await send('bob', { symbol: 'TEVA', side: 'buy', amountIls: '1000', clientOrderId: 'same' })).status).toBe(201);
  });

  it('a replay does not count against the rate limit', async () => {
    for (let i = 1; i <= 5; i++) {
      expect((await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000', clientOrderId: `o${i}` })).status).toBe(201);
    }
    expect((await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000', clientOrderId: 'o1' })).status).toBe(200);
    expect((await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000', clientOrderId: 'o6' })).status).toBe(429);
  });

  it('two requests with the same id at the same moment make one order', async () => {
    const body = { symbol: 'TEVA', side: 'buy', amountIls: '5000.00', clientOrderId: 'double-tap' };
    const results = await Promise.all([send('alice', body), send('alice', body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(results[0].body.order.id).toBe(results[1].body.order.id);
    expect(await written('alice')).toMatchObject({ orders: 1, reserved_cash: '5000.00' });
  });

  it('a replay after the order ran shows what happened to it', async () => {
    const first = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000', clientOrderId: 'late' });
    const event = await db.query(
      `INSERT INTO market_events (market, kind, day, at, status) VALUES ('TASE', 'close', '2026-11-11', $1, 'done') RETURNING id`,
      [TASE_CLOSE],
    );
    await db.query(
      `UPDATE orders SET status = 'rejected', reject_reason = 'אין מחיר', reject_code = 'NO_PRICE', event_id = $2 WHERE id = $1`,
      [first.body.order.id, event.rows[0].id],
    );
    const again = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000', clientOrderId: 'late' });
    expect(again.status).toBe(200);
    expect(again.body.order).toMatchObject({ id: first.body.order.id, status: 'rejected' });
  });
});

// ---------- the rate limit ----------

describe('POST /me/orders: 5 orders per real minute', () => {
  beforeEach(async () => {
    await startWorld();
    await signUp('alice');
  });

  it('10 requests at once: exactly 5 pass, 5 get 429 with Retry-After', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000.00' })),
    );
    const passed = results.filter((r) => r.status === 201);
    const limited = results.filter((r) => r.status === 429);
    expect(passed).toHaveLength(5);
    expect(limited).toHaveLength(5);
    for (const r of limited) {
      expect(r.body).toEqual({ error: 'too many orders: at most 5 per minute', code: 'RATE_LIMITED', reason: 'יותר מדי הזמנות: עד 5 בדקה. נסו שוב בעוד רגע' });
      expect(Number(r.retryAfter)).toBeGreaterThanOrEqual(1);
      expect(Number(r.retryAfter)).toBeLessThanOrEqual(60);
      expect(String(Number(r.retryAfter))).toBe(r.retryAfter);   // whole seconds
    }
    for (const r of passed) expect(r.retryAfter).toBeNull();
    expect(await written('alice')).toMatchObject({ orders: 5, reserved_cash: '5000.00' });
    expect(await ledger('alice')).toMatchObject({ cash_locked: '5000.00' });
  });

  it('Retry-After counts down to when the oldest of the last 5 is a minute old', async () => {
    for (let i = 0; i < 5; i++) await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000' });
    await db.query(`UPDATE orders SET created_at = now() - interval '50 seconds' WHERE uid = 'alice'`);
    const res = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000' });
    expect(res.status).toBe(429);
    expect(res.retryAfter).toBe('10');

    await db.query(`UPDATE orders SET created_at = now() - interval '61 seconds' WHERE uid = 'alice'`);
    expect((await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000' })).status).toBe(201);
  });

  it('is per player, and refused sends don\'t count', async () => {
    await signUp('bob');
    for (let i = 0; i < 5; i++) await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000' });
    expect((await send('bob', { symbol: 'TEVA', side: 'buy', amountIls: '1000' })).status).toBe(201);
    for (let i = 0; i < 6; i++) expect((await send('bob', { symbol: 'TEVA', side: 'buy', amountIls: '1' })).status).toBe(422);
    for (let i = 0; i < 4; i++) expect((await send('bob', { symbol: 'TEVA', side: 'buy', amountIls: '1000' })).status).toBe(201);
    expect((await send('bob', { symbol: 'TEVA', side: 'buy', amountIls: '1000' })).status).toBe(429);
  });
});

// ---------- locks ----------

describe('POST /me/orders: locks', () => {
  it('two sends at once that together need more than the free cash: only one passes', async () => {
    await startWorld();
    await signUp('alice');
    await givePosition('alice', 'TEVA', '6410.25641025', '850000.00', { price: '132.6000', value: '850000.00' });
    const results = await Promise.all([
      send('alice', { symbol: 'NVDA', side: 'buy', amountIls: '100000.00' }),
      send('alice', { symbol: 'AAPL', side: 'buy', amountIls: '100000.00' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(results.find((r) => r.status === 422)!.body.code).toBe('INSUFFICIENT_CASH');
    expect(await portfolio('alice')).toEqual({
      cash: '150000.0000', reserved_cash: '100000.00', available_cash: '50000.0000', equity: '1000000.0000',
    });
    expect(await ledger('alice')).toMatchObject({ cash_free: '50000.00', cash_locked: '100000.00' });
  });

  it('two sells at once of the same units: only one passes', async () => {
    await startWorld();
    await signUp('alice');
    await givePosition('alice', 'TEVA', '10', '1300.00', { price: '132.6000', value: '1326.00' });
    const results = await Promise.all([
      send('alice', { symbol: 'TEVA', side: 'sell', units: '7' }),
      send('alice', { symbol: 'TEVA', side: 'sell', units: '7' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    const pos = await db.query(`SELECT reserved_units FROM positions WHERE uid = 'alice' AND status = 'open'`);
    expect(pos.rows[0].reserved_units).toBe('7.00000000');
  });

  it('waits while a clock move holds the clock row, then uses the moved clock (D-021)', async () => {
    await startWorld();
    await signUp('alice');
    // A clock move in progress: the runner has the row FOR UPDATE and is starting the 17:30 close.
    const mover = await db.connect();
    try {
      await mover.query('BEGIN');
      await mover.query('SELECT * FROM world_clock FOR UPDATE');

      let settled = false;
      const pending = send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000' }).finally(() => { settled = true; });

      // The send is blocked on the row lock: Postgres shows a backend waiting on a lock.
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const { rows } = await db.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        waiting = rows[0].n;
        if (waiting > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting).toBe(1);
      expect(settled).toBe(false);
      expect((await written('alice')).orders).toBe(0);

      await mover.query(`UPDATE world_clock SET events_through = $1`, [TASE_CLOSE]);
      await mover.query('COMMIT');

      const res = await pending;
      expect(res.status).toBe(201);
      // The close had started when the send got the row, so the order goes to the next open, not into it.
      expect(res.body.order).toMatchObject({
        priceType: 'open',
        executesAt: worldTime(THU_TASE_OPEN, '2026-11-12', 4, '10:00'),
        placedAt: { at: TASE_CLOSE, time: '17:30' },
      });
    } finally {
      await mover.query('ROLLBACK').catch(() => {});
      mover.release();
    }
  });

  // The runner's start of Wednesday's 17:30 TASE close.
  const CLOSE_EVENT: MarketEvent = { market: 'TASE', kind: 'close', day: '2026-11-11', at: new Date(TASE_CLOSE) };

  async function lockWaiters(): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    return rows[0].n;
  }

  async function until(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!(await check()) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  }

  it('a send that arrives while the runner waits to start an event queues behind it, and its order runs after that event (D-021)', async () => {
    await startWorld();
    await signUp('bob');
    const inFlight = await db.connect();   // a send that already holds the clock row
    const runner = await db.connect();
    try {
      await inFlight.query('BEGIN');
      await inFlight.query('SELECT now_at FROM world_clock FOR SHARE');
      let started = false;
      const start = startEvent(runner, CLOSE_EVENT).then(() => { started = true; });
      await until(async () => (await lockWaiters()) === 1);

      // bob sends now. On the row lock alone his share request would be granted at once (Postgres doesn't queue
      // a share request behind a waiting exclusive one on a row), and a steady stream of sends would keep the
      // start waiting for ever. It has to queue behind the start instead.
      let sent = false;
      const pending = send('bob', { symbol: 'TEVA', side: 'buy', amountIls: '1000' }).then((r) => { sent = true; return r; });
      await until(async () => sent || (await lockWaiters()) === 2);
      expect({ started, sent }).toEqual({ started: false, sent: false });

      await inFlight.query('COMMIT');
      await start;
      const res = await pending;
      expect(res.status).toBe(201);
      // It got the clock after the close had started, so it goes to the next open.
      expect(res.body.order).toMatchObject({
        priceType: 'open',
        executesAt: worldTime(THU_TASE_OPEN, '2026-11-12', 4, '10:00'),
        placedAt: { at: TASE_CLOSE, time: '17:30' },
      });
    } finally {
      await inFlight.query('ROLLBACK').catch(() => {});
      inFlight.release();
      runner.release();
    }
  });

  it('a flood of refused sends, from one player and from several, can\'t keep the runner from starting an event', async () => {
    await startWorld();
    for (const uid of ['mallory', 'trent', 'oscar']) await signUp(uid);
    // More than the cash: every send is a 422 that stores nothing, so the 5-per-minute limit never applies (D-028).
    const body = { symbol: 'TEVA', side: 'buy', amountIls: '2000000' };
    let stop = false;
    let refused = 0;
    const loop = async (uid: string) => {
      while (!stop) {
        expect((await sendOrder(db, uid, body)).status).toBe(422);
        refused++;
      }
    };
    // Four parallel loops from one player (they queue on her portfolio row), and two each from two others.
    const loops = ['mallory', 'mallory', 'mallory', 'mallory', 'trent', 'trent', 'oscar', 'oscar'].map(loop);
    // The runner's own connection, with a statement timeout like production's (server.ts).
    const runner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 5000 });
    await runner.connect();
    try {
      await new Promise((r) => setTimeout(r, 300));   // the flood is going
      const t = Date.now();
      await startEvent(runner as unknown as pg.PoolClient, CLOSE_EVENT);
      // It waits only for the sends already in flight: milliseconds, not the whole flood.
      expect(Date.now() - t).toBeLessThan(1000);
    } finally {
      stop = true;
      await Promise.allSettled(loops);
      await runner.end();
    }
    await Promise.all(loops);
    expect(refused).toBeGreaterThan(20);
    expect((await db.query(`SELECT status FROM market_events`)).rows).toEqual([{ status: 'pending' }]);
  }, 20_000);
});

// ---------- the effective now ----------

describe('POST /me/orders: the effective now (D-017, D-021)', () => {
  beforeEach(async () => {
    await signUp('alice');
  });

  it('an event the runner has started is in the past: the order runs at the next open', async () => {
    await startWorld({ eventsThrough: TASE_CLOSE });   // the clock row still says 12:40
    const teva = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000' });
    expect(teva.status).toBe(201);
    expect(teva.body.order).toMatchObject({
      priceType: 'open',
      executesAt: worldTime(THU_TASE_OPEN, '2026-11-12', 4, '10:00'),
      placedAt: worldTime(TASE_CLOSE, '2026-11-11', 3, '17:30'),
    });
    // At 17:30 New York is open, so a US order runs at its close.
    const nvda = await send('alice', { symbol: 'NVDA', side: 'buy', amountIls: '1000' });
    expect(nvda.body.order).toMatchObject({ priceType: 'close', executesAt: { at: US_CLOSE, time: '23:00' } });

    const rows = await db.query(
      `SELECT o.placed_at, j.world_at FROM orders o JOIN journals j ON j.order_id = o.id WHERE o.id = $1`,
      [teva.body.order.id],
    );
    expect(rows.rows[0]).toEqual({ placed_at: new Date(TASE_CLOSE), world_at: new Date(TASE_CLOSE) });
  });

  it('a running clock moves on in real time', async () => {
    // Set 5 real hours ago at 12:40 and running: now 17:40 Israel, after the TASE close.
    await db.query(
      `INSERT INTO world_clock (now_at, real_at, running) VALUES ($1, now() - interval '5 hours', TRUE)`,
      [WED_1240],
    );
    const res = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000' });
    expect(res.body.order).toMatchObject({ priceType: 'open', executesAt: { at: THU_TASE_OPEN } });
    expect(res.body.order.placedAt.time).toBe('17:40');
  });
});

// ---------- the end of the world ----------

describe('POST /me/orders: GAME_OVER (409)', () => {
  beforeEach(async () => {
    await signUp('alice');
  });

  it('refuses an order that would run after ends_at, and passes one that runs before it', async () => {
    await startWorld({ endsAt: '2026-11-11T15:00:00Z' });   // 17:00 Israel: before the TASE close
    const before = await written('alice');
    const res = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'the game is over: this order could never execute',
      code: 'GAME_OVER',
      reason: 'המשחק הגיע לסוף נתוני המחירים: אין עוד מועד שבו ההזמנה תוכל להתבצע',
    });
    expect(await written('alice')).toEqual(before);
    // New York opens at 16:30 Israel, before the end.
    expect((await send('alice', { symbol: 'NVDA', side: 'buy', amountIls: '1000' })).status).toBe(201);
  });

  it('refuses everything once the clock has reached the end', async () => {
    await db.query(
      `INSERT INTO world_clock (now_at, real_at, running, ends_at) VALUES ($1, now() - interval '30 days', TRUE, $2)`,
      [WED_1240, '2026-11-12T07:59:00Z'],
    );
    const res = await send('alice', { symbol: 'NVDA', side: 'buy', amountIls: '1000' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GAME_OVER');
  });
});

// ---------- who may send ----------

describe('POST /me/orders: auth and the world', () => {
  it('401 without a valid token', async () => {
    await startWorld();
    const body = JSON.stringify({ symbol: 'TEVA', side: 'buy', amountIls: '1000' });
    expect((await app.request('/me/orders', { method: 'POST', body })).status).toBe(401);
    expect((await app.request('/me/orders', { method: 'POST', body, headers: { Authorization: 'Bearer junk' } })).status).toBe(401);
  });

  it('404 before POST /me', async () => {
    await startWorld();
    const res = await send('ghost', { symbol: 'TEVA', side: 'buy', amountIls: '1000' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'user not found, call POST /me first', code: 'NO_USER' });
  });

  it('409 NO_WORLD before the world starts', async () => {
    await signUp('alice');
    const res = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'NO_WORLD', reason: 'העולם עוד לא התחיל, אי אפשר לשלוח הזמנות' });
    expect((await written('alice')).orders).toBe(0);
  });
});
