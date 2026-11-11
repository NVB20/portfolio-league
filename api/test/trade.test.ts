// GET /me/trade, GET /me/chart/:symbol and PATCH /me/chart-settings against a real Postgres.
// The rows below are TEST fixtures. The chart source is a fake, so the tests never call Yahoo.
//
// The seeded world: Wednesday 2026-11-11, 12:40 Israel time (10:40 UTC). TASE is open (its latest
// KNOWN close is Tuesday's), New York hasn't opened (latest known close: Tuesday's).
// Cash, holdings and totals are the stored values the runner writes (D-019, D-024); the screen never adds
// them up (D-031). Security prices on the list are still the latest known closes.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { DEFAULT_CHART_SETTINGS } from '../src/chartSettings.js';
import type { Bar } from '../src/game/bars.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

const db = new pg.Pool({ connectionString: DATABASE_URL });
let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;
let yahooCalls: string[] = [];
let yahooFails = false;

const bar = (time: string, close: number): Bar => ({ time, open: close - 1, high: close + 1, low: close - 2, close, volume: 1000 });
// The fake chart source: real days up to Friday 13.11, so the "future" (11.11 to 13.11) is there to be cut.
const FAKE_BARS = [bar('2026-11-06', 100), bar('2026-11-09', 101), bar('2026-11-10', 102), bar('2026-11-11', 103), bar('2026-11-12', 104), bar('2026-11-13', 105)];

beforeAll(async () => {
  await runner({ databaseUrl: DATABASE_URL, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
  const test = await makeTestKeys();
  privateKey = test.privateKey;
  app = createApp({
    db,
    verifyToken: makeFirebaseVerifier(PROJECT_ID, test.keys),
    corsOrigins: [],
    fetchDaily: async (symbol) => {
      yahooCalls.push(symbol);
      if (yahooFails) throw new Error('Yahoo is down');
      return FAKE_BARS;
    },
  });
});

beforeEach(async () => {
  await db.query('TRUNCATE users, securities, usd_ils, world_clock, market_events CASCADE');
  yahooCalls = [];
  yahooFails = false;
});

afterAll(async () => {
  await db.end();
});

async function call(method: string, path: string, uid: string, body?: unknown) {
  const token = await signToken(privateKey, uid);
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedWorld() {
  await db.query(`INSERT INTO world_clock (now_at) VALUES ('2026-11-11T10:40:00Z')`);
  await db.query(
    `INSERT INTO securities (symbol, name_he, name_en, market, exchange, currency, yahoo_symbol) VALUES
       ('TEVA', 'טבע', 'Teva', 'TASE', 'TASE', 'ILS', 'TEVA.TA'),
       ('NVDA', 'אנבידיה', 'NVIDIA', 'US', 'NASDAQ', 'USD', 'NVDA'),
       ('NOCH', 'בלי גרף', NULL, 'US', 'NYSE', 'USD', NULL)`,
  );
  // Monday, Tuesday, and Wednesday (today: not closed yet, so it must not be shown).
  await db.query(
    `INSERT INTO prices (symbol, day, open, close) VALUES
       ('TEVA', '2026-11-09', 130, 130), ('TEVA', '2026-11-10', 130, 132.6), ('TEVA', '2026-11-11', 133, 140),
       ('NVDA', '2026-11-09', 180, 180), ('NVDA', '2026-11-10', 181, 189), ('NVDA', '2026-11-11', 190, 200)`,
  );
  await db.query(`INSERT INTO usd_ils (day, open, close) VALUES ('2026-11-09', 3.7, 3.7), ('2026-11-10', 3.72, 3.72)`);
}

describe('GET /me/trade', () => {
  it('empty world: cash, no securities, default chart settings', async () => {
    await call('POST', '/me', 'alice');
    const res = await call('GET', '/me/trade', 'alice');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clock: null,
      cash: 1_000_000,
      availableCash: 1_000_000,
      totalValue: 1_000_000,
      usdIls: null,
      securities: [],
      pendingOrders: [],
      chartSettings: DEFAULT_CHART_SETTINGS,
    });
  });

  it('returns 404 before POST /me and 401 without a token', async () => {
    expect((await call('GET', '/me/trade', 'ghost')).status).toBe(404);
    expect((await app.request('/me/trade')).status).toBe(401);
  });

  it('seeded world: known closes only, when an order would run, holdings and pending orders', async () => {
    await seedWorld();
    await seedAlice();

    const t = await (await call('GET', '/me/trade', 'alice')).json();
    expect(t.cash).toBe(900_000);
    expect(t.availableCash).toBe(860_000);   // 40,000.00 is locked by the pending NVDA buy
    expect(t.totalValue).toBe(913_300);      // the stored equity; 100 × Tuesday's ₪132.6 would give 913,260
    expect(t.usdIls.rate).toBe(3.72);
    expect(t.securities.map((s: { symbol: string }) => s.symbol)).toEqual(['TEVA', 'NOCH', 'NVDA']);

    const teva = t.securities[0];
    expect(teva).toMatchObject({
      symbol: 'TEVA',
      price: 132.6,              // Tuesday's close: Wednesday's hasn't happened yet
      priceDay: '2026-11-10',
      isOpen: true,
      hasChart: true,
      closes: [{ day: '2026-11-09', close: 130 }, { day: '2026-11-10', close: 132.6 }],
      execution: { priceType: 'close', at: { date: '2026-11-11', time: '17:30' } },
    });
    expect(teva.dayChangePct).toBeCloseTo(2, 6);
    // The stored mark (Wednesday's open, ₪133) and the stored equity, exact; 40 units are locked by the sell.
    expect(teva.holding).toEqual({ units: 100, freeUnits: 60, valueIls: 13_300, weightPct: 1.4563, stops: [] });

    const nvda = t.securities[2];
    expect(nvda).toMatchObject({
      price: 189,
      isOpen: false,
      holding: null,
      execution: { priceType: 'open', at: { date: '2026-11-11', time: '16:30' } },
    });
    expect(t.securities[1]).toMatchObject({ symbol: 'NOCH', price: null, closes: [], hasChart: false });

    expect(t.pendingOrders.map((o: { symbol: string }) => o.symbol)).toEqual(['NVDA', 'TEVA']);
  });

  it('says when an order sent now could never run because the history ends first, as POST /me/orders does (D-028)', async () => {
    // The real end (D-017): 05.11.2026 09:59 Israel. Wednesday 04.11 18:00: TASE has closed for the last time,
    // New York is open until 23:00. A TASE order would go to Thursday's 10:00 open, after the end.
    await db.query(`INSERT INTO world_clock (now_at, ends_at) VALUES ('2026-11-04T16:00:00Z', '2026-11-05T07:59:00Z')`);
    await db.query(
      `INSERT INTO securities (symbol, name_he, market, exchange, currency) VALUES
         ('TEVA', 'טבע', 'TASE', 'TASE', 'ILS'), ('NVDA', 'אנבידיה', 'US', 'NASDAQ', 'USD')`,
    );
    await db.query(`INSERT INTO prices (symbol, day, open, close) VALUES ('TEVA', '2026-11-04', 40, 40)`);
    await call('POST', '/me', 'alice');

    const t = await (await call('GET', '/me/trade', 'alice')).json();
    const [teva, nvda] = t.securities;
    expect(teva.execution).toEqual({ priceType: 'open', at: expect.objectContaining({ date: '2026-11-05', time: '10:00' }), gameOver: true });
    expect(nvda.execution).toEqual({ priceType: 'close', at: expect.objectContaining({ date: '2026-11-04', time: '23:00' }), gameOver: false });
    // The ticket can say why, like the dashboard's clock: where the clock stops, and whether it runs.
    expect(t.clock).toMatchObject({ running: false, endsAt: { date: '2026-11-05', time: '09:59' } });

    const sent = await call('POST', '/me/orders', 'alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000.00' });
    expect(sent.status).toBe(409);
    expect((await sent.json()).code).toBe('GAME_OVER');
    expect((await call('POST', '/me/orders', 'alice', { symbol: 'NVDA', side: 'buy', amountIls: '1000.00' })).status).toBe(201);
  });

  it('brings me up to date before reading, during an event whose orders have run (D-025)', async () => {
    await seedWorld();
    await seedAlice();
    // Alice as she was after Tuesday's TASE close (₪132.6), with Wednesday's open run but her row not reached yet.
    await db.query(
      `UPDATE positions SET last_price = 132.6000, market_value_ils = 13260.00, unrealized_pnl_ils = 260.00,
         marked_at = '2026-11-10T15:30:00Z' WHERE uid = 'alice'`,
    );
    await db.query(
      `UPDATE portfolios SET holdings_value = 13260.00, unrealized_pnl = 260.00, marked_at = '2026-11-10T15:30:00Z',
         last_event_at = '2026-11-10T15:30:00Z' WHERE uid = 'alice'`,
    );
    await db.query(
      `INSERT INTO market_events (market, kind, day, at, status) VALUES ('TASE', 'open', '2026-11-11', '2026-11-11T08:00:00Z', 'orders_done')`,
    );

    const t = await (await call('GET', '/me/trade', 'alice')).json();
    expect(t.totalValue).toBe(913_300);
    expect(t.securities[0].holding).toEqual({ units: 100, freeUnits: 60, valueIls: 13_300, weightPct: 1.4563, stops: [] });

    const stored = await db.query(
      `SELECT p.equity::text AS equity, p.last_event_at, x.last_price::text AS last_price, x.market_value_ils::text AS value
       FROM portfolios p JOIN positions x ON x.uid = p.uid WHERE p.uid = 'alice'`,
    );
    expect(stored.rows[0]).toEqual({
      equity: '913300.0000', last_event_at: new Date('2026-11-11T08:00:00Z'), last_price: '133.0000', value: '13300.00',
    });
  });
});

// Alice after Wednesday's TASE open: 100 TEVA marked at ₪133.0000 = 13,300.00 (cost 13,000.00), 40 of them locked
// by a pending sell; 900,000.00 cash, 40,000.00 of it locked by a pending NVDA buy. Equity 913,300.00.
async function seedAlice() {
  await call('POST', '/me', 'alice');
  await db.query(
    `UPDATE portfolios SET cash = 900000.00, reserved_cash = 40000.00, holdings_value = 13300.00, unrealized_pnl = 300.00,
       marked_at = '2026-11-11T08:00:00Z', last_event_at = '2026-11-11T08:00:00Z'
     WHERE uid = 'alice'`,
  );
  await db.query(
    `INSERT INTO positions (uid, symbol, units, reserved_units, avg_cost_ils, cost_basis_ils, last_price, market_value_ils,
                            unrealized_pnl_ils, marked_at, opened_at)
     VALUES ('alice', 'TEVA', 100, 40, 130, 13000.00, 133.0000, 13300.00, 300.00, '2026-11-11T08:00:00Z', '2026-11-02T08:00:00Z')`,
  );
  await db.query(
    `INSERT INTO orders (uid, symbol, side, amount_ils, units, placed_at, executes_at, price_type) VALUES
       ('alice', 'NVDA', 'buy', 40000, NULL, '2026-11-11T10:30:00Z', '2026-11-11T14:30:00Z', 'open'),
       ('alice', 'TEVA', 'sell', NULL, 40, '2026-11-11T10:35:00Z', '2026-11-11T15:30:00Z', 'close')`,
  );
}

describe('GET /me/chart/:symbol', () => {
  beforeEach(async () => {
    await seedWorld();
    await call('POST', '/me', 'alice');
  });

  it('daily bars stop at the last closed day: no future', async () => {
    const res = await call('GET', '/me/chart/TEVA', 'alice');
    expect(res.status).toBe(200);
    const chart = await res.json();
    expect(chart).toMatchObject({ symbol: 'TEVA', currency: 'ILS', tf: 'D', lastDay: '2026-11-10' });
    expect(chart.bars.map((b: Bar) => b.time)).toEqual(['2026-11-06', '2026-11-09', '2026-11-10']);
    expect(yahooCalls).toEqual(['TEVA.TA']);
  });

  it('weekly bars are built from the cut days', async () => {
    const chart = await (await call('GET', '/me/chart/NVDA?tf=W', 'alice')).json();
    expect(chart.bars).toEqual([
      { time: '2026-11-02', open: 99, high: 101, low: 98, close: 100, volume: 1000 },
      { time: '2026-11-09', open: 100, high: 103, low: 99, close: 102, volume: 2000 },
    ]);
  });

  it('rejects bad input, unknown symbols and symbols without a chart', async () => {
    expect((await call('GET', '/me/chart/teva', 'alice')).status).toBe(400);
    expect((await call('GET', '/me/chart/TEVA?tf=M', 'alice')).status).toBe(400);
    expect((await call('GET', '/me/chart/NOPE', 'alice')).status).toBe(404);
    expect((await call('GET', '/me/chart/NOCH', 'alice')).status).toBe(404);
    expect(yahooCalls).toEqual([]);
  });

  it('502 when the chart source fails, without leaking the error', async () => {
    yahooFails = true;
    const res = await call('GET', '/me/chart/TEVA', 'alice');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'chart source unavailable' });
  });

  it('needs a token', async () => {
    expect((await app.request('/me/chart/TEVA')).status).toBe(401);
  });
});

describe('PATCH /me/chart-settings', () => {
  it('saves valid keys, ignores the rest, and merges with what was saved', async () => {
    await call('POST', '/me', 'alice');
    let res = await call('PATCH', '/me/chart-settings', 'alice', { type: 'line', roles: ['admin'], bg: 'pink' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...DEFAULT_CHART_SETTINGS, type: 'line' });

    res = await call('PATCH', '/me/chart-settings', 'alice', { sma20: true });
    expect(await res.json()).toEqual({ ...DEFAULT_CHART_SETTINGS, type: 'line', sma20: true });

    const roles = await db.query(`SELECT roles, chart_settings FROM users WHERE uid = 'alice'`);
    expect(roles.rows[0].roles).toEqual(['user']);
    expect(roles.rows[0].chart_settings).toEqual({ type: 'line', sma20: true });

    const trade = await (await call('GET', '/me/trade', 'alice')).json();
    expect(trade.chartSettings).toMatchObject({ type: 'line', sma20: true });
  });

  it('400 when nothing valid is sent, 404 before POST /me', async () => {
    await call('POST', '/me', 'alice');
    expect((await call('PATCH', '/me/chart-settings', 'alice', { nope: 1 })).status).toBe(400);
    expect((await call('PATCH', '/me/chart-settings', 'alice', 'not json')).status).toBe(400);
    expect((await call('PATCH', '/me/chart-settings', 'ghost', { type: 'line' })).status).toBe(404);
  });
});
