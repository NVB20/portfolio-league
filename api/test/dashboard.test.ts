// GET /me/dashboard against a real Postgres (TEST_DATABASE_URL, default: the local Docker database).
// The rows inserted below are TEST fixtures, not game data: the real tables start empty.
//
// The seeded world: the clock is Wednesday 2026-11-11, 12:40 Israel time (10:40 UTC).
// TASE is open and hasn't closed yet, New York hasn't opened, so the latest KNOWN closes are Tuesday's.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

const db = new pg.Pool({ connectionString: DATABASE_URL });
let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;

beforeAll(async () => {
  await runner({ databaseUrl: DATABASE_URL, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
  const test = await makeTestKeys();
  privateKey = test.privateKey;
  app = createApp({ db, verifyToken: makeFirebaseVerifier(PROJECT_ID, test.keys), corsOrigins: [] });
});

beforeEach(async () => {
  await db.query('TRUNCATE users, securities, usd_ils, world_clock CASCADE');
});

afterAll(async () => {
  await db.end();
});

async function call(method: string, path: string, uid: string, claims: Record<string, unknown> = {}) {
  const token = await signToken(privateKey, uid, { claims });
  return app.request(path, { method, headers: { Authorization: `Bearer ${token}` } });
}

describe('GET /me/dashboard, empty world', () => {
  it('shows a new player their starting cash and nothing else', async () => {
    await call('POST', '/me', 'alice');
    const res = await call('GET', '/me/dashboard', 'alice');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clock: null,
      portfolio: {
        totalValue: 1_000_000,
        cash: 1_000_000,
        weekReturnPct: null,
        maxDrawdownPct: null,
        vsMedianPct: null,
        series: [],
        medianSeries: [],
      },
      holdings: [],
      pendingOrders: { total: 0, next: [] },
      usdIls: null,
      standing: null,
      leaderboard: { players: 0, top: [] },
    });
  });

  it('returns 404 before POST /me', async () => {
    const res = await call('GET', '/me/dashboard', 'ghost');
    expect(res.status).toBe(404);
  });

  it('returns 401 without a token', async () => {
    const res = await app.request('/me/dashboard');
    expect(res.status).toBe(401);
  });
});

describe('GET /me/dashboard, seeded world', () => {
  beforeEach(async () => {
    await call('POST', '/me', 'alice', { name: 'Alice' });
    await call('POST', '/me', 'bob');   // email sign-up: no name

    await db.query(`INSERT INTO world_clock (now_at) VALUES ('2026-11-11T10:40:00Z')`);
    await db.query(`INSERT INTO securities VALUES
      ('TEVA', 'טבע', 'TASE', 'TASE', 'ILS'),
      ('NVDA', 'אנבידיה', 'US', 'NASDAQ', 'USD')`);
    // Wednesday's 999 closes are in the future at 12:40 and must not be used.
    await db.query(`INSERT INTO prices VALUES
      ('TEVA', '2026-11-09', 39, 40), ('TEVA', '2026-11-10', 41, 50), ('TEVA', '2026-11-11', 51, 999),
      ('NVDA', '2026-11-09', 99, 100), ('NVDA', '2026-11-10', 101, 110), ('NVDA', '2026-11-11', 111, 999)`);
    await db.query(`INSERT INTO usd_ils VALUES
      ('2026-11-06', 3.8, 3.8), ('2026-11-09', 3.76, 3.75), ('2026-11-10', 3.74, 3.70), ('2026-11-11', 9, 9.99)`);

    // Alice: 760,000 cash + 4,000 TEVA (200,000) + 100 NVDA ($11,000 = ₪40,700) = 1,000,700.
    await db.query(`UPDATE portfolios SET cash = 760000 WHERE uid = 'alice'`);
    await db.query(`INSERT INTO holdings VALUES ('alice', 'TEVA', 4000), ('alice', 'NVDA', 100)`);

    await db.query(`INSERT INTO orders (uid, symbol, side, amount_ils, status, placed_at, executes_at, price_type) VALUES
      ('alice', 'NVDA', 'buy',  40000, 'pending',  '2026-11-11T10:00:00Z', '2026-11-11T14:30:00Z', 'open'),
      ('alice', 'TEVA', 'sell', 30000, 'pending',  '2026-11-11T10:10:00Z', '2026-11-11T15:30:00Z', 'close'),
      ('alice', 'TEVA', 'buy',  10000, 'pending',  '2026-11-11T10:20:00Z', '2026-11-11T15:30:00Z', 'close'),
      ('alice', 'TEVA', 'buy',  5000,  'executed', '2026-11-10T09:00:00Z', '2026-11-10T15:30:00Z', 'close'),
      ('bob',   'TEVA', 'buy',  5000,  'pending',  '2026-11-11T09:00:00Z', '2026-11-11T09:30:00Z', 'close')`);

    // Last Friday's snapshot is outside this week and must not appear.
    await db.query(`INSERT INTO portfolio_snapshots VALUES
      ('alice', '2026-11-06T11:50:00Z', 900000),
      ('alice', '2026-11-09T08:00:00Z', 1000000), ('alice', '2026-11-10T15:30:00Z', 1020000), ('alice', '2026-11-11T08:00:00Z', 1010000),
      ('bob',   '2026-11-09T08:00:00Z', 1000000), ('bob',   '2026-11-10T15:30:00Z', 1000000), ('bob',   '2026-11-11T08:00:00Z', 1005000)`);

    await db.query(`INSERT INTO standings VALUES
      ('2026-11-06', 'alice', 9, 1, 100, 100, 100, 1),
      ('2026-11-09', 'alice', 0.5, 0.2, 50, 50, 50, 2), ('2026-11-09', 'bob', 0.6, 0.1, 100, 100, 100, 1),
      ('2026-11-10', 'alice', 2.0, 0.0, 100, 100, 90, 1), ('2026-11-10', 'bob', 0.0, 0.0, 50, 50, 40, 2)`);
  });

  const dashboard = async () => (await call('GET', '/me/dashboard', 'alice')).json();

  it('shows the world clock in Israel time with both markets', async () => {
    expect((await dashboard()).clock).toEqual({
      at: '2026-11-11T10:40:00.000Z',
      date: '2026-11-11',
      weekday: 3,
      time: '12:40',
      week: 46,
      weekStartAt: '2026-11-08T22:00:00.000Z',   // Monday 00:00 in Israel
      markets: {
        tase: { isOpen: true, session: { openMin: 600, closeMin: 1050 } },
        us: { isOpen: false, session: { openMin: 990, closeMin: 1380 } },
      },
    });
  });

  it('values holdings at the latest close that already happened, US ones through the dollar rate', async () => {
    const d = await dashboard();
    expect(d.portfolio.cash).toBe(760_000);
    expect(d.portfolio.totalValue).toBeCloseTo(1_000_700);
    expect(d.holdings.map((h: { symbol: string }) => h.symbol)).toEqual(['TEVA', 'NVDA']);   // biggest first

    const [teva, nvda] = d.holdings;
    expect(teva).toMatchObject({ nameHe: 'טבע', exchange: 'TASE', currency: 'ILS', units: 4000, valueIls: 200_000, nearCap: true });
    expect(teva.dayChangePct).toBeCloseTo(25);           // 40 -> 50
    expect(teva.weightPct).toBeCloseTo(19.986, 2);
    expect(nvda.valueIls).toBeCloseTo(40_700);           // 100 x $110 x 3.70
    expect(nvda.dayChangePct).toBeCloseTo(10);
    expect(nvda.nearCap).toBe(false);
  });

  it('uses today\'s TASE close once TASE has closed', async () => {
    await db.query(`UPDATE world_clock SET now_at = '2026-11-11T16:00:00Z'`);   // 18:00 Israel
    const [teva] = (await dashboard()).holdings;
    expect(teva.valueIls).toBe(4000 * 999);
  });

  it('shows only my pending orders: the 2 that run first, and the total', async () => {
    const { pendingOrders } = await dashboard();
    expect(pendingOrders.total).toBe(3);
    expect(pendingOrders.next).toEqual([
      expect.objectContaining({ symbol: 'NVDA', side: 'buy', amountIls: 40000, priceType: 'open', market: 'US',
        executesAt: { at: '2026-11-11T14:30:00.000Z', date: '2026-11-11', weekday: 3, time: '16:30' } }),
      expect.objectContaining({ symbol: 'TEVA', side: 'sell', amountIls: 30000, priceType: 'close', market: 'TASE' }),
    ]);
  });

  it('charts this week only, against the median player, with return and max drawdown', async () => {
    const { portfolio } = await dashboard();
    expect(portfolio.series.map((p: { value: number }) => p.value)).toEqual([1_000_000, 1_020_000, 1_010_000]);
    expect(portfolio.medianSeries.map((p: { value: number }) => p.value)).toEqual([1_000_000, 1_010_000, 1_007_500]);
    expect(portfolio.weekReturnPct).toBeCloseTo(1);
    expect(portfolio.maxDrawdownPct).toBeCloseTo(0.9804, 3);   // 1,020,000 -> 1,010,000
    expect(portfolio.vsMedianPct).toBeCloseTo(0.25);           // 1% vs 0.75%
  });

  it('shows the dollar rate known so far and its change since last week', async () => {
    const { usdIls } = await dashboard();
    expect(usdIls.rate).toBe(3.7);                              // Tuesday's close, not Wednesday's 9.99
    expect(usdIls.weekChangePct).toBeCloseTo(-2.6316, 3);       // 3.80 -> 3.70
    expect(usdIls.series).toEqual([{ at: '2026-11-09', value: 3.75 }, { at: '2026-11-10', value: 3.7 }]);
  });

  it('has no "change this week" on Monday before the first rate of the week', async () => {
    await db.query(`UPDATE world_clock SET now_at = '2026-11-09T07:00:00Z'`);   // Monday 09:00
    const { usdIls } = await dashboard();
    expect(usdIls.rate).toBe(3.8);            // last Friday's close
    expect(usdIls.weekChangePct).toBeNull();  // not 0%
    expect(usdIls.series).toEqual([]);
  });

  it('shows my standing this week, with the rank change and daily scores', async () => {
    expect((await dashboard()).standing).toEqual({
      rank: 1,
      players: 2,
      score: 90,
      returnRank: 100,
      stabilityRank: 100,
      rankChange: 1,
      days: [
        { date: '2026-11-09', weekday: 1, score: 50 },
        { date: '2026-11-10', weekday: 2, score: 90 },
      ],
    });
  });

  it('shows the leaderboard with display names, never emails', async () => {
    expect((await dashboard()).leaderboard).toEqual({
      players: 2,
      top: [
        { rank: 1, name: 'Alice', returnPct: 2, score: 90, isMe: true },
        { rank: 2, name: 'שחקן', returnPct: 0, score: 40, isMe: false },
      ],
    });
  });

  it('has no standing for a player who was not scored on the latest day', async () => {
    await call('POST', '/me', 'carol');
    const d = await (await call('GET', '/me/dashboard', 'carol')).json();
    expect(d.standing).toBeNull();
    expect(d.leaderboard.players).toBe(2);
  });
});
