// GET /me/dashboard and POST /me/rejections/seen against a real Postgres (TEST_DATABASE_URL, default: the local
// Docker database). The rows inserted below are TEST fixtures, not game data: the real tables start empty.
//
// The seeded world: the clock is Wednesday 2026-11-11, 12:40 Israel time (10:40 UTC), in the week of Monday
// 2026-11-09. TASE opened at 10:00 (08:00 UTC) and hasn't closed yet; New York hasn't opened. The runner has
// finished every open and close up to Wednesday's TASE open, so the stored values (D-019, D-024) are as of then.
// The screens read those stored values and never add money up (D-031).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { forgetCalendar } from '../src/calendar.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

const db = new pg.Pool({ connectionString: DATABASE_URL });
let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;

const WEEK_START = '2026-11-08T22:00:00.000Z';   // Monday 2026-11-09 00:00 Israel
const NOW = '2026-11-11T10:40:00.000Z';          // Wednesday 12:40 Israel
const WED_TASE_OPEN = '2026-11-11T08:00:00.000Z';

beforeAll(async () => {
  await runner({ databaseUrl: DATABASE_URL, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
  const test = await makeTestKeys();
  privateKey = test.privateKey;
  app = createApp({ db, verifyToken: makeFirebaseVerifier(PROJECT_ID, test.keys), corsOrigins: [] });
});

beforeEach(async () => {
  await db.query('TRUNCATE users, securities, usd_ils, world_clock, market_events CASCADE');
});

afterAll(async () => {
  await db.end();
});

async function call(method: string, path: string, uid: string, opts: { claims?: Record<string, unknown>; body?: unknown } = {}) {
  const token = await signToken(privateKey, uid, { claims: opts.claims ?? {} });
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
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
        availableCash: 1_000_000,
        reservedCash: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        weekReturnPct: null,
        maxDrawdownPct: null,
        vsMedianPct: null,
        series: [],
        medianSeries: [],
      },
      holdings: [],
      pendingOrders: { total: 0, next: [] },
      rejections: [],
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

// The finished events of the fixture, by a short name.
const EVENTS = {
  lastFriUsClose: { market: 'US', kind: 'close', day: '2026-11-06', at: '2026-11-06T21:00:00Z', median: '990000.00', ret: '-1.0000' },
  monTaseClose: { market: 'TASE', kind: 'close', day: '2026-11-09', at: '2026-11-09T15:30:00Z', median: '1000500.00', ret: '0.0500' },
  monUsClose: { market: 'US', kind: 'close', day: '2026-11-09', at: '2026-11-09T21:00:00Z', median: '1001000.00', ret: '0.1000' },
  tueTaseClose: { market: 'TASE', kind: 'close', day: '2026-11-10', at: '2026-11-10T15:30:00Z', median: '1001500.00', ret: '0.1500' },
  wedTaseOpen: { market: 'TASE', kind: 'open', day: '2026-11-11', at: WED_TASE_OPEN, median: '1002000.00', ret: '0.2000' },
} as const;
type EventName = keyof typeof EVENTS;

let eventIds: Record<EventName, string>;

async function insertOrder(o: {
  uid: string; symbol: string; side: 'buy' | 'sell'; amount?: string; units?: string; status?: 'pending' | 'rejected';
  placedAt: string; executesAt: string; priceType: 'open' | 'close'; reason?: string; code?: string;
  event?: EventName; notifiedAt?: string; label?: string;
}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (uid, symbol, side, amount_ils, units, status, placed_at, executes_at, price_type,
                         reject_reason, reject_code, event_id, notified_at, client_order_id)
     VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $8, $9, $10, $11, $12::bigint, $13, $14)
     RETURNING id::text AS id`,
    [o.uid, o.symbol, o.side, o.amount ?? null, o.units ?? null, o.status ?? 'pending', o.placedAt, o.executesAt,
      o.priceType, o.reason ?? null, o.code ?? null, o.event ? eventIds[o.event] : null, o.notifiedAt ?? null,
      o.label ?? null],
  );
  return rows[0].id;
}

describe('GET /me/dashboard, seeded world', () => {
  beforeEach(async () => {
    await call('POST', '/me', 'alice', { claims: { name: 'Alice' } });
    await call('POST', '/me', 'bob');   // email sign-up: no name

    await db.query(`INSERT INTO world_clock (now_at) VALUES ('2026-11-11T10:40:00Z')`);
    await db.query(`INSERT INTO securities VALUES
      ('TEVA', 'טבע', 'TASE', 'TASE', 'ILS'),
      ('NVDA', 'אנבידיה', 'US', 'NASDAQ', 'USD')`);
    // Wednesday's 999 closes are in the future at 12:40. Values come from the stored marks, not from here;
    // only the day change % still reads the closes already known.
    await db.query(`INSERT INTO prices VALUES
      ('TEVA', '2026-11-09', 39, 40), ('TEVA', '2026-11-10', 41, 50), ('TEVA', '2026-11-11', 51, 999),
      ('NVDA', '2026-11-09', 99, 100), ('NVDA', '2026-11-10', 101, 110), ('NVDA', '2026-11-11', 111, 999)`);
    await db.query(`INSERT INTO usd_ils VALUES
      ('2026-11-06', 3.8, 3.8), ('2026-11-09', 3.76, 3.75), ('2026-11-10', 3.74, 3.70), ('2026-11-11', 9, 9.99)`);

    const ids = {} as Record<EventName, string>;
    for (const [name, e] of Object.entries(EVENTS) as [EventName, (typeof EVENTS)[EventName]][]) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO market_events (market, kind, day, at, status, median_value, median_return_pct)
         VALUES ($1, $2, $3, $4, 'done', $5, $6) RETURNING id::text AS id`,
        [e.market, e.kind, e.day, e.at, e.median, e.ret],
      );
      ids[name] = rows[0].id;
    }
    eventIds = ids;

    // Alice, as the runner left her after Wednesday's TASE open:
    //   TEVA 4,000 units marked at Wednesday's open ₪51 = 204,000.00 (cost 180,000.00). D-009 would have said
    //   Tuesday's close ₪50 = 200,000: the stored mark is what counts. 600 units are locked by a pending sell.
    //   NVDA 100 units marked at Tuesday's US close $110 × 3.70 = 40,700.00 (cost 37,000.00).
    //   Cash 760,000.00, of which 50,000.00 is locked by two pending buys. Equity 1,004,700.00.
    //   Week: started at 1,000,000.00, peaked at 1,020,000.00 (Monday's US close), and fell to 1,003,680 at
    //   Tuesday's TASE close (a 1.6% drawdown the daily chart rows alone can't show).
    await db.query(
      `UPDATE portfolios SET cash = 760000.00, reserved_cash = 50000.00, holdings_value = 244700.00,
         realized_pnl = 1234.56, unrealized_pnl = 27700.00, marked_at = $1, last_event_at = $1,
         week_start = '2026-11-09', week_start_value = 1000000.00, peak_value = 1020000.00, max_drawdown_pct = 1.6000
       WHERE uid = 'alice'`,
      [WED_TASE_OPEN],
    );
    await db.query(
      `INSERT INTO positions (uid, symbol, status, units, reserved_units, avg_cost_ils, cost_basis_ils, realized_pnl_ils,
                              last_price, last_fx, market_value_ils, unrealized_pnl_ils, marked_at, opened_at, closed_at) VALUES
         ('alice', 'TEVA', 'open', 4000, 600, 45, 180000.00, 0, 51.0000, NULL, 204000.00, 24000.00, $1, '2026-11-02T08:00:00Z', NULL),
         ('alice', 'NVDA', 'open', 100, 0, 370, 37000.00, 0, 110.0000, 3.7000, 40700.00, 3700.00, '2026-11-10T21:00:00Z', '2026-11-03T14:30:00Z', NULL),
         ('alice', 'NVDA', 'closed', 0, 0, 350, 0, 1234.56, 120.0000, 3.7000, 0, 0, '2026-11-05T21:00:00Z', '2026-10-26T14:30:00Z', '2026-11-05T21:00:00Z')`,
      [WED_TASE_OPEN],
    );

    // Buys are sized in ₪, sells in units (D-018). The rejected order was already seen by alice, so it shows
    // neither as pending nor as a toast.
    await insertOrder({ uid: 'alice', symbol: 'NVDA', side: 'buy', amount: '40000', placedAt: '2026-11-11T10:00:00Z', executesAt: '2026-11-11T14:30:00Z', priceType: 'open' });
    await insertOrder({ uid: 'alice', symbol: 'TEVA', side: 'sell', units: '600', placedAt: '2026-11-11T10:10:00Z', executesAt: '2026-11-11T15:30:00Z', priceType: 'close' });
    await insertOrder({ uid: 'alice', symbol: 'TEVA', side: 'buy', amount: '10000', placedAt: '2026-11-11T10:20:00Z', executesAt: '2026-11-11T15:30:00Z', priceType: 'close' });
    await insertOrder({ uid: 'alice', symbol: 'TEVA', side: 'buy', amount: '5000', status: 'rejected', placedAt: '2026-11-10T09:00:00Z', executesAt: '2026-11-10T15:30:00Z', priceType: 'close', reason: 'אין מספיק מזומן פנוי', code: 'INSUFFICIENT_CASH', event: 'tueTaseClose', notifiedAt: '2026-11-10T16:00:00Z', label: 'seen' });
    await insertOrder({ uid: 'bob', symbol: 'TEVA', side: 'buy', amount: '5000', placedAt: '2026-11-11T09:00:00Z', executesAt: '2026-11-11T09:30:00Z', priceType: 'close' });
    await db.query(`UPDATE portfolios SET reserved_cash = 5000.00 WHERE uid = 'bob'`);

    // The daily chart rows (D-024): last Friday's is outside this week, and one after now can't be shown.
    await db.query(`INSERT INTO portfolio_snapshots VALUES
      ('alice', '2026-11-06T21:00:00Z', 900000),
      ('alice', '2026-11-09T21:00:00Z', 1020000), ('alice', '2026-11-10T21:00:00Z', 1010000),
      ('alice', '2026-11-11T21:00:00Z', 1030000)`);

    await db.query(`INSERT INTO standings VALUES
      ('2026-11-06', 'alice', 9, 1, 100, 100, 100, 1),
      ('2026-11-09', 'alice', 0.5, 0.2, 50, 50, 50, 2), ('2026-11-09', 'bob', 0.6, 0.1, 100, 100, 100, 1),
      ('2026-11-10', 'alice', 2.0, 0.0, 100, 100, 90, 1), ('2026-11-10', 'bob', 0.0, 0.0, 50, 50, 40, 2)`);
  });

  const dashboard = async (uid = 'alice') => (await call('GET', '/me/dashboard', uid)).json();

  it('shows the world clock in Israel time with both markets', async () => {
    expect((await dashboard()).clock).toEqual({
      at: NOW,
      date: '2026-11-11',
      weekday: 3,
      time: '12:40',
      week: 46,
      weekStartAt: WEEK_START,   // Monday 00:00 in Israel
      markets: {
        tase: { isOpen: true, session: { openMin: 600, closeMin: 1050 }, state: 'open', reason: null, nextOpen: null },
        us: {
          isOpen: false,
          session: { openMin: 990, closeMin: 1380 },
          state: 'pre_open',
          reason: null,
          nextOpen: { at: '2026-11-11T14:30:00.000Z', date: '2026-11-11', weekday: 3, time: '16:30' },
        },
      },
      running: false,
      endsAt: null,
    });
  });

  it('shows a market closed for a holiday, with the reason and its next open (D-022)', async () => {
    await db.query(`INSERT INTO market_closures VALUES ('TASE', '2026-11-11', 'חג לבדיקה', 'Test holiday')`);
    forgetCalendar(db);
    try {
      const { tase, us } = (await dashboard()).clock.markets;
      expect(tase).toEqual({
        isOpen: false,
        session: null,
        state: 'holiday',
        reason: 'חג לבדיקה',
        nextOpen: { at: '2026-11-12T08:00:00.000Z', date: '2026-11-12', weekday: 4, time: '10:00' },
      });
      expect(us.state).toBe('pre_open');   // the other market is not affected
    } finally {
      await db.query('DELETE FROM market_closures');
      forgetCalendar(db);
    }
  });

  it('moves the running clock on by the real time since it was set (D-017)', async () => {
    // Set 90 real minutes ago at 12:40 Israel, running: now 14:10 Israel.
    await db.query(`UPDATE world_clock SET running = TRUE, real_at = now() - interval '90 minutes'`);
    const { clock } = await dashboard();
    expect(clock.time).toBe('14:10');
    expect(clock.date).toBe('2026-11-11');
  });

  it('never runs the clock past its end', async () => {
    await db.query(`UPDATE world_clock SET running = TRUE, real_at = now() - interval '10 hours', ends_at = '2026-11-11T11:00:00Z'`);
    const { clock } = await dashboard();
    expect(clock.time).toBe('13:00');
    // Every player sees what the admin set: running, and where it stops (Israel time).
    expect(clock.running).toBe(true);
    expect(clock.endsAt).toEqual({ at: '2026-11-11T11:00:00.000Z', date: '2026-11-11', weekday: 3, time: '13:00' });
  });

  it('reads the totals from the stored columns and never adds money up (D-019, D-031)', async () => {
    const d = await dashboard();
    expect(d.portfolio).toMatchObject({
      totalValue: 1_004_700,   // the stored equity. D-009 (Tuesday's closes) would say 1,000,700
      cash: 760_000,
      availableCash: 710_000,
      reservedCash: 50_000,
      realizedPnl: 1234.56,
      unrealizedPnl: 27_700,
    });
    expect(d.holdings[0]).toMatchObject({ symbol: 'TEVA', valueIls: 204_000 });   // 4,000 × ₪50 would be 200,000
    expect(d.rejections).toEqual([]);   // the only rejection was already seen

    // A stored value no price × units can give, and stored totals that don't match it: the screen shows both
    // as stored. Nothing is recomputed on read.
    await db.query(`UPDATE positions SET market_value_ils = 123456.78 WHERE uid = 'alice' AND symbol = 'TEVA' AND status = 'open'`);
    const again = await dashboard();
    expect(again.holdings.find((h: { symbol: string }) => h.symbol === 'TEVA')).toMatchObject({ valueIls: 123_456.78, weightPct: 12.2879 });
    expect(again.portfolio.totalValue).toBe(1_004_700);
  });

  it('shows each open holding: free units, cost basis, unrealized gain and weight of the stored equity', async () => {
    expect((await dashboard()).holdings).toEqual([   // biggest first; the closed NVDA position is history, not shown
      {
        symbol: 'TEVA', nameHe: 'טבע', exchange: 'TASE', currency: 'ILS',
        units: 4000, freeUnits: 3400,     // 600 are locked by the pending sell
        valueIls: 204_000, costBasisIls: 180_000, unrealizedPnlIls: 24_000,
        dayChangePct: 25,                 // the day change still follows the closes: Monday 40 -> Tuesday 50
        weightPct: 20.3046,               // 204,000.00 / 1,004,700.00, exact to 4 decimals
        nearCap: true,
      },
      {
        symbol: 'NVDA', nameHe: 'אנבידיה', exchange: 'NASDAQ', currency: 'USD',
        units: 100, freeUnits: 100,
        valueIls: 40_700, costBasisIls: 37_000, unrealizedPnlIls: 3_700,
        dayChangePct: 10,
        weightPct: 4.051,
        nearCap: false,
      },
    ]);
  });

  it('values a holding that was never marked at its cost basis', async () => {
    await db.query(
      `UPDATE positions SET last_price = NULL, last_fx = NULL, market_value_ils = NULL, unrealized_pnl_ils = NULL, marked_at = NULL
       WHERE uid = 'alice' AND symbol = 'NVDA' AND status = 'open'`,
    );
    const nvda = (await dashboard()).holdings.find((h: { symbol: string }) => h.symbol === 'NVDA');
    expect(nvda).toMatchObject({ valueIls: 37_000, costBasisIls: 37_000, unrealizedPnlIls: 0, weightPct: 3.6827 });
  });

  it('changes a value only when the runner marks it, not when the clock moves', async () => {
    await db.query(`UPDATE world_clock SET now_at = '2026-11-11T16:00:00Z'`);   // 18:00 Israel: TASE has closed
    const [teva] = (await dashboard()).holdings;
    expect(teva.valueIls).toBe(204_000);   // no event row for the close yet, so still Wednesday's open
    expect(teva.dayChangePct).toBe(1898);   // the display % already uses today's close: 50 -> 999
  });

  it('shows only my pending orders: the 2 that run first, and the total', async () => {
    const { pendingOrders } = await dashboard();
    expect(pendingOrders.total).toBe(3);
    expect(pendingOrders.next).toEqual([
      expect.objectContaining({ symbol: 'NVDA', side: 'buy', amountIls: 40000, priceType: 'open', market: 'US',
        executesAt: { at: '2026-11-11T14:30:00.000Z', date: '2026-11-11', weekday: 3, time: '16:30' } }),
      expect.objectContaining({ symbol: 'TEVA', side: 'sell', amountIls: null, units: 600, priceType: 'close', market: 'TASE' }),
    ]);
  });

  it('charts this week from the running totals, against the median of each finished event (D-024)', async () => {
    const { portfolio } = await dashboard();
    expect(portfolio.series).toEqual([
      { at: WEEK_START, value: 1_000_000 },                       // week_start_value, at Monday 00:00
      { at: '2026-11-09T21:00:00.000Z', value: 1_020_000 },       // the daily rows of this week, up to now
      { at: '2026-11-10T21:00:00.000Z', value: 1_010_000 },
      { at: NOW, value: 1_004_700 },                              // the stored equity, now
    ]);
    expect(portfolio.medianSeries).toEqual([                      // last Friday's event is last week's
      { at: '2026-11-09T15:30:00.000Z', value: 1_000_500 },
      { at: '2026-11-09T21:00:00.000Z', value: 1_001_000 },
      { at: '2026-11-10T15:30:00.000Z', value: 1_001_500 },
      { at: WED_TASE_OPEN, value: 1_002_000 },
    ]);
    expect(portfolio.weekReturnPct).toBe(0.47);   // (1,004,700 − 1,000,000) / 1,000,000, exact
    expect(portfolio.maxDrawdownPct).toBe(1.6);   // stored; the four points above would only give 1.5
    expect(portfolio.vsMedianPct).toBe(0.27);     // 0.4700 − the latest finished event's 0.2000, exact
  });

  it('takes the median only from finished events', async () => {
    await db.query(
      `UPDATE market_events SET status = 'orders_done', median_value = NULL, median_return_pct = NULL WHERE id = $1`,
      [eventIds.wedTaseOpen],
    );
    const { portfolio } = await dashboard();
    expect(portfolio.vsMedianPct).toBe(0.32);     // 0.4700 − Tuesday's 0.1500
    expect(portfolio.medianSeries.map((p: { at: string }) => p.at)).toEqual([
      '2026-11-09T15:30:00.000Z', '2026-11-09T21:00:00.000Z', '2026-11-10T15:30:00.000Z',
    ]);
  });

  it('has no vs-median number before the first finished event of the week', async () => {
    await db.query(`DELETE FROM market_events WHERE at >= $1 AND id <> $2`, [WEEK_START, eventIds.tueTaseClose]);
    await db.query(`UPDATE market_events SET at = '2026-11-06T15:30:00Z', day = '2026-11-06' WHERE id = $1`, [eventIds.tueTaseClose]);
    const { portfolio } = await dashboard();
    expect(portfolio.vsMedianPct).toBeNull();
    expect(portfolio.medianSeries).toEqual([]);
    expect(portfolio.weekReturnPct).toBe(0.47);   // my own numbers don't depend on the median
  });

  it('gives 0% return and 0% drawdown for a week the runner has not touched (D-024)', async () => {
    // Bob was never touched by an event: no week columns at all. His value hasn't changed, so the chart is flat.
    const bob = (await dashboard('bob')).portfolio;
    expect(bob).toMatchObject({ totalValue: 1_000_000, availableCash: 995_000, reservedCash: 5_000, weekReturnPct: 0, maxDrawdownPct: 0 });
    expect(bob.vsMedianPct).toBe(-0.2);
    expect(bob.series).toEqual([{ at: WEEK_START, value: 1_000_000 }, { at: NOW, value: 1_000_000 }]);

    // Alice's columns from last week are stale: they don't count this week.
    await db.query(
      `UPDATE portfolios SET week_start = '2026-11-02', week_start_value = 900000.00, peak_value = 1100000.00, max_drawdown_pct = 5
       WHERE uid = 'alice'`,
    );
    const alice = (await dashboard()).portfolio;
    expect(alice).toMatchObject({ weekReturnPct: 0, maxDrawdownPct: 0, vsMedianPct: -0.2 });
    expect(alice.series[0]).toEqual({ at: WEEK_START, value: 1_004_700 });   // not last week's 900,000
  });

  it('brings me up to date before reading, during an event whose orders have run (D-025)', async () => {
    // 17:00 Israel: the runner has run the orders of Wednesday's US open but hasn't reached alice's row yet.
    await db.query(`UPDATE world_clock SET now_at = '2026-11-11T15:00:00Z'`);
    await db.query(`UPDATE usd_ils SET open = 3.72 WHERE day = '2026-11-11'`);
    const usOpen = await db.query<{ id: string }>(
      `INSERT INTO market_events (market, kind, day, at, status) VALUES ('US', 'open', '2026-11-11', '2026-11-11T14:30:00Z', 'orders_done')
       RETURNING id::text AS id`,
    );

    const d = await dashboard();
    // NVDA at the open: 100 × $111.0000 × 3.7200 = 41,292.00. TEVA keeps its TASE mark.
    expect(d.portfolio).toMatchObject({ totalValue: 1_005_292, unrealizedPnl: 28_292, weekReturnPct: 0.5292, maxDrawdownPct: 1.6 });
    expect(d.portfolio.series[d.portfolio.series.length - 1]).toEqual({ at: '2026-11-11T15:00:00.000Z', value: 1_005_292 });
    expect(d.holdings.map((h: { symbol: string; valueIls: number; unrealizedPnlIls: number; weightPct: number }) =>
      [h.symbol, h.valueIls, h.unrealizedPnlIls, h.weightPct])).toEqual([['TEVA', 204_000, 24_000, 20.2926], ['NVDA', 41_292, 4_292, 4.1075]]);

    const stored = await db.query(
      `SELECT holdings_value::text, equity::text, unrealized_pnl::text, peak_value::text, max_drawdown_pct::text, last_event_at
       FROM portfolios WHERE uid = 'alice'`,
    );
    expect(stored.rows[0]).toEqual({
      holdings_value: '245292.00', equity: '1005292.0000', unrealized_pnl: '28292.00',
      peak_value: '1020000.00', max_drawdown_pct: '1.6000', last_event_at: new Date('2026-11-11T14:30:00Z'),
    });
    const nvda = await db.query(
      `SELECT last_price::text, last_fx::text, market_value_ils::text, unrealized_pnl_ils::text, marked_at
       FROM positions WHERE uid = 'alice' AND symbol = 'NVDA' AND status = 'open'`,
    );
    expect(nvda.rows[0]).toEqual({
      last_price: '111.0000', last_fx: '3.7200', market_value_ils: '41292.00', unrealized_pnl_ils: '4292.00',
      marked_at: new Date('2026-11-11T14:30:00Z'),
    });

    // Once only: the batch (and the next read) skip her through last_event_at. Bob holds nothing: untouched.
    await dashboard();
    await dashboard('bob');
    const event = await db.query(`SELECT players_updated FROM market_events WHERE id = $1`, [usOpen.rows[0].id]);
    expect(event.rows[0].players_updated).toBe(1);
    const bob = await db.query(`SELECT last_event_at FROM portfolios WHERE uid = 'bob'`);
    expect(bob.rows[0].last_event_at).toBeNull();
  });

  it('shows the dollar rate known so far and its change since last week', async () => {
    const { usdIls } = await dashboard();
    expect(usdIls.rate).toBe(3.7);                              // Tuesday's close, not Wednesday's 9.99
    expect(usdIls.weekChangePct).toBeCloseTo(-2.6316, 3);       // 3.80 -> 3.70 (a display %)
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

  describe('rejection toasts (D-023)', () => {
    let ids: Record<string, string>;

    // Rejected by the runner, in the order they were sent. Each names the event that rejected it.
    beforeEach(async () => {
      const rejected = (label: string, uid: string, symbol: string, side: 'buy' | 'sell', size: string, code: string, reason: string, event: EventName) =>
        insertOrder({
          uid, symbol, side, amount: side === 'buy' ? size : undefined, units: side === 'sell' ? size : undefined,
          status: 'rejected', placedAt: '2026-11-06T10:00:00Z', executesAt: EVENTS[event].at, priceType: EVENTS[event].kind,
          reason, code, event, label,
        });
      ids = {
        seen: (await db.query(`SELECT id::text AS id FROM orders WHERE client_order_id = 'seen'`)).rows[0].id,
        a1: await rejected('a1', 'alice', 'NVDA', 'buy', '300000', 'OVER_LIMIT', 'ההחזקה הייתה מגיעה ל־29.9% מהתיק (מותר עד 20%)', 'lastFriUsClose'),
        a2: await rejected('a2', 'alice', 'TEVA', 'buy', '5000', 'INSUFFICIENT_CASH', 'אין מספיק מזומן פנוי', 'monTaseClose'),
        a3: await rejected('a3', 'alice', 'TEVA', 'sell', '10', 'INSUFFICIENT_UNITS', 'אין מספיק יחידות למכירה', 'monTaseClose'),
        b1: await rejected('b1', 'bob', 'TEVA', 'buy', '5000', 'INSUFFICIENT_CASH', 'אין מספיק מזומן פנוי', 'monTaseClose'),
        a5: await rejected('a5', 'alice', 'TEVA', 'buy', '2000', 'INSUFFICIENT_CASH', 'אין מספיק מזומן פנוי', 'tueTaseClose'),
        a6: await rejected('a6', 'alice', 'TEVA', 'buy', '3000', 'OVER_LIMIT', 'ההחזקה הייתה מגיעה ל־20.4% מהתיק (מותר עד 20%)', 'wedTaseOpen'),
        // Sent last but rejected at an earlier event than a5 and a6: "newest" is the rejection's time.
        a7: await rejected('a7', 'alice', 'NVDA', 'sell', '5', 'NO_PRICE', 'אין מחיר למניה בזמן הביצוע', 'monUsClose'),
      };
    });

    it('lists my unseen rejections: newest first, at most 5, with the code and the Hebrew reason', async () => {
      const { rejections } = await dashboard();
      expect(rejections.map((r: { id: string }) => r.id)).toEqual([ids.a6, ids.a5, ids.a7, ids.a3, ids.a2]);   // a1 is 6th
      expect(rejections[0]).toEqual({
        id: ids.a6, symbol: 'TEVA', side: 'buy', amountIls: 3000, units: null, code: 'OVER_LIMIT',
        reason: 'ההחזקה הייתה מגיעה ל־20.4% מהתיק (מותר עד 20%)',
        at: { at: WED_TASE_OPEN, date: '2026-11-11', weekday: 3, time: '10:00' },
      });
      expect(rejections[2]).toEqual({
        id: ids.a7, symbol: 'NVDA', side: 'sell', amountIls: null, units: 5, code: 'NO_PRICE',
        reason: 'אין מחיר למניה בזמן הביצוע',
        at: { at: '2026-11-09T21:00:00.000Z', date: '2026-11-09', weekday: 1, time: '23:00' },
      });
      expect((await dashboard('bob')).rejections.map((r: { id: string }) => r.id)).toEqual([ids.b1]);
    });

    it('POST /me/rejections/seen marks only my own rejected orders up to the id, once', async () => {
      const res = await call('POST', '/me/rejections/seen', 'alice', { body: { upToId: ids.a5 } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ marked: 4 });   // a1, a2, a3, a5; "seen" was marked before

      const rows = await db.query<{ uid: string; label: string | null; status: string; notified_at: Date | null }>(
        `SELECT uid, client_order_id AS label, status, notified_at FROM orders ORDER BY id`,
      );
      const marked = rows.rows.filter((r) => r.notified_at !== null && r.label !== 'seen').map((r) => r.label);
      expect(marked).toEqual(['a1', 'a2', 'a3', 'a5']);
      // Bob's rejection (an id below upToId) and every pending order (ids below it too) are untouched.
      expect(rows.rows.filter((r) => r.uid === 'bob' || r.status === 'pending').every((r) => r.notified_at === null)).toBe(true);
      const seen = rows.rows.find((r) => r.label === 'seen')!;
      expect(seen.notified_at).toEqual(new Date('2026-11-10T16:00:00Z'));   // not moved to now

      expect((await dashboard()).rejections.map((r: { id: string }) => r.id)).toEqual([ids.a6, ids.a7]);

      const again = await call('POST', '/me/rejections/seen', 'alice', { body: { upToId: ids.a5 } });
      expect(await again.json()).toEqual({ marked: 0 });
    });

    it('POST /me/rejections/seen refuses a bad body, an unknown user and a missing token', async () => {
      for (const body of [{}, { upToId: 5 }, { upToId: '' }, { upToId: 'abc' }, { upToId: '-1' }, { upToId: '1.5' },
        { upToId: '9223372036854775808' }, 'not json']) {
        const res = await call('POST', '/me/rejections/seen', 'alice', { body });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect((await call('POST', '/me/rejections/seen', 'ghost', { body: { upToId: ids.a6 } })).status).toBe(404);
      expect((await app.request('/me/rejections/seen', { method: 'POST', body: '{"upToId":"1"}' })).status).toBe(401);
      const unseen = await db.query(`SELECT count(*)::int AS n FROM orders WHERE status = 'rejected' AND notified_at IS NULL`);
      expect(unseen.rows[0].n).toBe(7);   // nothing was marked
    });
  });
});
