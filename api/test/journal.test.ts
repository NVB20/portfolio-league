// GET /me/journal (D-035) against a real Postgres: every order the player sent, newest first, the filters, the week,
// the pages, and the results (wins, losses, success rate, realized gain). The rows below are TEST fixtures; nothing
// runs the engine, so fills are written as the runner would store them.
//
// The seeded world: Wednesday 2026-11-11, 12:40 Israel time (10:40 UTC). The world week started on Monday 9.11 at
// 00:00 Israel time (2026-11-08 22:00 UTC).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { parseJournalQuery } from '../src/tradeJournal.js';
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
  await db.query('TRUNCATE users, securities, usd_ils, world_clock, market_events CASCADE');
});

afterAll(async () => {
  await db.end();
});

async function get(path: string, uid: string) {
  const token = await signToken(privateKey, uid);
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } });
}

async function journal(path: string, uid = 'alice') {
  const res = await get(path, uid);
  expect(res.status).toBe(200);
  return res.json();
}

const ids = (j: { rows: { id: string }[] }) => j.rows.map((r) => Number(r.id));

// ---------- fixtures ----------

let events: Record<'lastWeek' | 'mon' | 'tue' | 'wed', string>;
let order: string[] = [];   // alice's order ids, in the order they were sent (index 0 = her first order)

async function seedWorld() {
  await db.query(`INSERT INTO world_clock (now_at) VALUES ('2026-11-11T10:40:00Z')`);
  await db.query(
    `INSERT INTO securities (symbol, name_he, name_en, market, exchange, currency) VALUES
       ('TEVA', 'טבע', 'Teva', 'TASE', 'TASE', 'ILS'), ('NVDA', 'אנבידיה', 'NVIDIA', 'US', 'NASDAQ', 'USD')`,
  );
  const ev = await db.query<{ id: string }>(
    `INSERT INTO market_events (market, kind, day, at, status) VALUES
       ('TASE', 'open',  '2026-11-05', '2026-11-05T08:00:00Z', 'done'),
       ('TASE', 'close', '2026-11-09', '2026-11-09T15:30:00Z', 'done'),
       ('US',   'open',  '2026-11-10', '2026-11-10T14:30:00Z', 'done'),
       ('TASE', 'open',  '2026-11-11', '2026-11-11T08:00:00Z', 'done')
     RETURNING id::text AS id`,
  );
  const [lastWeek, mon, tue, wed] = ev.rows.map((r) => r.id);
  events = { lastWeek, mon, tue, wed };
}

async function position(uid: string, symbol: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO positions (uid, symbol, units, avg_cost_ils, cost_basis_ils, opened_at)
     VALUES ($1, $2, 100, 130, 13000.00, '2026-11-04T08:00:00Z') RETURNING id::text AS id`,
    [uid, symbol],
  );
  return rows[0].id;
}

type Fill = { event: string; at: string; price: number; units: number; ils: number; pnl?: number; fx?: number };

async function executed(uid: string, pos: string, symbol: string, side: 'buy' | 'sell', size: number, placedAt: string, f: Fill) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (uid, symbol, side, amount_ils, units, status, placed_at, executes_at, price_type, event_id,
                         fill_price, fx_rate, filled_units, filled_ils, realized_pnl_ils, position_id, executed_at)
     VALUES ($1, $2, $3, $4, $5, 'executed', $6, $7, 'open', $8, $9, $10, $11, $12, $13, $14, $7) RETURNING id::text AS id`,
    [uid, symbol, side, side === 'buy' ? size : null, side === 'sell' ? size : null, placedAt, f.at, f.event,
     f.price, f.fx ?? null, f.units, f.ils, f.pnl ?? null, pos],
  );
  return rows[0].id;
}

// Alice: two orders last week (a buy, and a sell with a ₪500 gain), then this week a win, a loss, a sell at exactly
// ₪0, a buy, a rejected buy and a pending buy. Bob: one winning sell, which must never show up in Alice's journal.
async function seedOrders() {
  await post('/me', 'alice');
  await post('/me', 'bob');
  await db.query(`UPDATE portfolios SET reserved_cash = 10000.00 WHERE uid = 'alice'`);
  const teva = await position('alice', 'TEVA');
  const nvda = await position('alice', 'NVDA');
  const bobTeva = await position('bob', 'TEVA');

  order = [];
  const lastWeek = { event: events.lastWeek, at: '2026-11-05T08:00:00Z' };
  order.push(await executed('alice', teva, 'TEVA', 'buy', 13000, '2026-11-04T16:00:00Z', { ...lastWeek, price: 130, units: 100, ils: 13000 }));
  order.push(await executed('alice', teva, 'TEVA', 'sell', 10, '2026-11-04T16:05:00Z', { ...lastWeek, price: 180, units: 10, ils: 1800, pnl: 500 }));

  const mon = { event: events.mon, at: '2026-11-09T15:30:00Z' };
  const tue = { event: events.tue, at: '2026-11-10T14:30:00Z' };
  const wed = { event: events.wed, at: '2026-11-11T08:00:00Z' };
  order.push(await executed('alice', teva, 'TEVA', 'sell', 20, '2026-11-09T09:00:00Z', { ...mon, price: 190.025, units: 20, ils: 3800.5, pnl: 1200.5 }));
  order.push(await executed('alice', nvda, 'NVDA', 'sell', 5, '2026-11-10T09:00:00Z', { ...tue, price: 180, fx: 3.72, units: 5, ils: 3348, pnl: -300.25 }));
  order.push(await executed('alice', teva, 'TEVA', 'sell', 1, '2026-11-10T18:00:00Z', { ...wed, price: 130, units: 1, ils: 130, pnl: 0 }));
  order.push(await executed('alice', nvda, 'NVDA', 'buy', 40000, '2026-11-10T09:05:00Z', { ...tue, price: 181, fx: 3.72, units: 59.40766, ils: 40000 }));

  const rejected = await db.query<{ id: string }>(
    `INSERT INTO orders (uid, symbol, side, amount_ils, status, placed_at, executes_at, price_type, event_id, reject_code, reject_reason)
     VALUES ('alice', 'TEVA', 'buy', 250000, 'rejected', '2026-11-10T18:10:00Z', '2026-11-11T08:00:00Z', 'open', $1,
             'OVER_LIMIT', 'הקנייה הייתה מעבירה את המניה מעל 20% מהתיק') RETURNING id::text AS id`,
    [events.wed],
  );
  order.push(rejected.rows[0].id);

  const pending = await db.query<{ id: string }>(
    `INSERT INTO orders (uid, symbol, side, amount_ils, placed_at, executes_at, price_type)
     VALUES ('alice', 'NVDA', 'buy', 10000, '2026-11-11T10:30:00Z', '2026-11-11T14:30:00Z', 'open') RETURNING id::text AS id`,
  );
  order.push(pending.rows[0].id);

  await executed('bob', bobTeva, 'TEVA', 'sell', 50, '2026-11-09T09:00:00Z', { ...mon, price: 200, units: 50, ils: 10000, pnl: 3500 });
}

async function post(path: string, uid: string) {
  const token = await signToken(privateKey, uid);
  return app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
}

// alice's order by its place in `order` (0 = her first), as a number, to compare with ids().
const o = (i: number) => Number(order[i]);

// ---------- tests ----------

describe('GET /me/journal', () => {
  it('a new player with no world: empty journal, no clock, no results yet', async () => {
    await post('/me', 'alice');
    expect(await journal('/me/journal')).toEqual({
      clock: null,
      filter: 'all',
      period: 'all',
      stats: { wins: 0, losses: 0, even: 0, winRatePct: null, realizedPnlIls: 0, avgWinIls: null, avgLossIls: null },
      counts: { all: 0, pending: 0, executed: 0, rejected: 0 },
      reservedCash: 0,
      rows: [],
      hasMore: false,
      due: false,
    });
  });

  it('this week: newest sent first, with the week results and counts', async () => {
    await seedWorld();
    await seedOrders();
    const j = await journal('/me/journal?period=week');
    expect(j.period).toBe('week');

    expect(j.clock).toMatchObject({ date: '2026-11-11', time: '12:40' });
    expect(ids(j)).toEqual([o(7), o(6), o(5), o(4), o(3), o(2)]);   // last week's two orders are out
    expect(j.counts).toEqual({ all: 6, pending: 1, executed: 4, rejected: 1 });
    expect(j.stats).toEqual({
      wins: 1, losses: 1, even: 1,
      winRatePct: 50,                    // the ₪0 sell is neither a win nor a loss
      realizedPnlIls: 900.25,            // 1,200.50 − 300.25 + 0, exact
      avgWinIls: 1200.5,
      avgLossIls: -300.25,
    });
    expect(j.reservedCash).toBe(10000);
    expect(j.hasMore).toBe(false);
    expect(j.due).toBe(false);           // the pending buy runs at 16:30 Israel time, after now
  });

  it('each row says what happened: waiting, filled (with the fill and its gain) or rejected (with the reason)', async () => {
    await seedWorld();
    await seedOrders();
    const j = await journal('/me/journal');
    const row = (i: number) => j.rows.find((r: { id: string }) => Number(r.id) === o(i));

    expect(row(7)).toEqual({
      id: order[7], symbol: 'NVDA', nameHe: 'אנבידיה', market: 'US', currency: 'USD', side: 'buy', status: 'pending',
      amountIls: 10000, units: null, priceType: 'open',
      placedAt: { at: '2026-11-11T10:30:00.000Z', date: '2026-11-11', weekday: 3, time: '12:30' },
      executesAt: { at: '2026-11-11T14:30:00.000Z', date: '2026-11-11', weekday: 3, time: '16:30' },
      fill: null, reject: null,
    });
    expect(row(3)).toMatchObject({
      symbol: 'NVDA', side: 'sell', status: 'executed', amountIls: null, units: 5,
      executesAt: { date: '2026-11-10', time: '16:30' },
      fill: { price: 180, fxRate: 3.72, units: 5, ils: 3348, realizedPnlIls: -300.25 },
      reject: null,
    });
    expect(row(2).fill).toEqual({ price: 190.025, fxRate: null, units: 20, ils: 3800.5, realizedPnlIls: 1200.5 });
    expect(row(5).fill).toMatchObject({ realizedPnlIls: null });   // a buy has no result
    expect(row(6)).toMatchObject({
      status: 'rejected', amountIls: 250000, fill: null,
      reject: { code: 'OVER_LIMIT', reason: 'הקנייה הייתה מעבירה את המניה מעל 20% מהתיק' },
    });
  });

  it('the whole game by default: last week counts too', async () => {
    await seedWorld();
    await seedOrders();
    const j = await journal('/me/journal');
    expect(j.period).toBe('all');
    expect(ids(j)).toEqual([o(7), o(6), o(5), o(4), o(3), o(2), o(1), o(0)]);
    expect(j.counts).toEqual({ all: 8, pending: 1, executed: 6, rejected: 1 });
    expect(j.stats).toEqual({
      wins: 2, losses: 1, even: 1,
      winRatePct: 66.7,                  // 2 of 3, one decimal
      realizedPnlIls: 1400.25,
      avgWinIls: 850.25,                 // (1,200.50 + 500) ÷ 2
      avgLossIls: -300.25,
    });
  });

  it('the filter picks rows; the results and counts stay the period’s', async () => {
    await seedWorld();
    await seedOrders();
    const waiting = await journal('/me/journal?filter=pending&period=week');
    expect(waiting.filter).toBe('pending');
    expect(ids(waiting)).toEqual([o(7)]);
    expect(waiting.stats.wins).toBe(1);
    expect(waiting.counts.all).toBe(6);

    expect(ids(await journal('/me/journal?filter=executed'))).toEqual([o(5), o(4), o(3), o(2), o(1), o(0)]);
    expect(ids(await journal('/me/journal?filter=executed&period=week'))).toEqual([o(5), o(4), o(3), o(2)]);
    expect(ids(await journal('/me/journal?filter=rejected'))).toEqual([o(6)]);
  });

  it('pages: ?limit and ?before=<the last row’s id>', async () => {
    await seedWorld();
    await seedOrders();
    const first = await journal('/me/journal?limit=2');
    expect(ids(first)).toEqual([o(7), o(6)]);
    expect(first.hasMore).toBe(true);

    const second = await journal(`/me/journal?limit=2&before=${order[6]}`);
    expect(ids(second)).toEqual([o(5), o(4)]);
    expect(second.hasMore).toBe(true);

    const third = await journal(`/me/journal?limit=2&before=${order[4]}`);
    expect(ids(third)).toEqual([o(3), o(2)]);
    expect(third.hasMore).toBe(true);    // the whole game: last week's two are still to come

    const week = await journal(`/me/journal?period=week&limit=2&before=${order[4]}`);
    expect(ids(week)).toEqual([o(3), o(2)]);
    expect(week.hasMore).toBe(false);    // o(1) and o(0) ran last week

    const last = await journal(`/me/journal?limit=2&before=${order[2]}`);
    expect(ids(last)).toEqual([o(1), o(0)]);
    expect(last.hasMore).toBe(false);
  });

  it('says `due` when a pending order’s time has passed and the runner hasn’t run it yet', async () => {
    await seedWorld();
    await post('/me', 'alice');
    await db.query(
      `INSERT INTO orders (uid, symbol, side, amount_ils, placed_at, executes_at, price_type)
       VALUES ('alice', 'TEVA', 'buy', 5000, '2026-11-11T07:00:00Z', '2026-11-11T08:00:00Z', 'open')`,
    );
    const j = await journal('/me/journal');
    expect(j.due).toBe(true);
    expect(j.counts.pending).toBe(1);
  });

  it('400 for a bad query, 404 before POST /me, 401 without a token', async () => {
    await post('/me', 'alice');
    for (const q of ['filter=open', 'period=month', 'before=abc', 'before=0', 'before=99999999999999999999', 'limit=0', 'limit=101', 'limit=1.5']) {
      expect((await get(`/me/journal?${q}`, 'alice')).status, q).toBe(400);
    }
    expect((await get('/me/journal', 'ghost')).status).toBe(404);
    expect((await app.request('/me/journal')).status).toBe(401);
  });
});

describe('parseJournalQuery', () => {
  it('fills the defaults and keeps valid values', () => {
    expect(parseJournalQuery({})).toEqual({ ok: true, query: { filter: 'all', period: 'all', before: null, limit: 20 } });
    expect(parseJournalQuery({ filter: 'rejected', period: 'all', before: '42', limit: '100' })).toEqual({
      ok: true,
      query: { filter: 'rejected', period: 'all', before: '42', limit: 100 },
    });
  });

  it('refuses a cursor past the BIGINT range, so it never reaches SQL', () => {
    expect(parseJournalQuery({ before: '9223372036854775807' }).ok).toBe(true);
    expect(parseJournalQuery({ before: '9223372036854775808' }).ok).toBe(false);
  });
});
