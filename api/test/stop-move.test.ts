// Moving a stop loss end to end (D-041) against a real Postgres (TEST_DATABASE_URL): PATCH /me/stops/:id, the runner
// checking the moved price, the refusals (someone else's stop, a stop that fired, a price at or above the latest
// close, while its market's open or close waits for the runner, the rate limit, the end of the prices), and what
// the screens read afterwards (dashboard, journal, the admin's monitoring).
//
// The world: Wednesday 2026-11-11, 12:40 Israel time (10:40 UTC), TASE open. A buy sent now fills at Wednesday's
// TASE close (15:30 UTC) at ₪100; its stop is first checked at Thursday's open (08:00 UTC).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import type { AdminMonitoring, Dashboard, MoveStopResult, TradeJournalView } from '../src/contract.js';
import { eventsBetween } from '../src/game/clock.js';
import { NO_CLOSURES } from '../src/game/marketHours.js';
import { getAdminMonitoring } from '../src/monitoring.js';
import { ledgerMismatches, runEvent, runUntil, startEvent } from '../src/runner.js';
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
const THU_TASE_OPEN = '2026-11-12T08:00:00.000Z';
const THU_TASE_CLOSE = '2026-11-12T15:30:00.000Z';
const FRI_TASE_OPEN = '2026-11-13T08:00:00.000Z';
const FRI_TASE_CLOSE = '2026-11-13T11:50:00.000Z';   // Friday's TASE session ends at 13:50 Israel

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
       ('TEVA', 'טבע', 'TASE', 'TASE', 'ILS'), ('NVDA', 'אנבידיה', 'US', 'NASDAQ', 'USD')`,
  );
  await db.query('INSERT INTO world_clock (now_at) VALUES ($1)', [WED_1240]);
  await price('TEVA', TUE, '100.0000', '100.0000');
  await price('TEVA', WED, '100.0000', '100.0000');
  await signUp('alice');
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

async function move(uid: string, id: string, stopPrice: unknown) {
  const res = await call('PATCH', `/me/stops/${id}`, uid, { stopPrice });
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get('Retry-After') };
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

// A buy of TEVA with a stop, filled at Wednesday's close (₪100, 100 units). Returns the stop's id.
async function filledStop(uid: string, stop: string): Promise<string> {
  const res = await call('POST', '/me/orders', uid, { symbol: 'TEVA', side: 'buy', amountIls: '10000.00', stopPrice: stop });
  expect(res.status).toBe(201);
  await runTo(WED_TASE_CLOSE);
  const { rows } = await db.query(`SELECT id::text FROM stop_orders WHERE uid = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`, [uid]);
  return rows[0].id;
}

async function runTo(at: string) {
  const c = await db.connect();
  try {
    return await runUntil(c, new Date(at));
  } finally {
    c.release();
  }
}

async function stopRow(id: string) {
  const { rows } = await db.query(
    `SELECT status, stop_price::text, moved_at, sell_order_id::text FROM stop_orders WHERE id = $1`,
    [id],
  );
  return { ...rows[0], moved_at: rows[0].moved_at?.toISOString() ?? null };
}

async function moves(id: string) {
  const { rows } = await db.query(
    `SELECT uid, from_price::text, to_price::text, world_at FROM stop_moves WHERE stop_id = $1 ORDER BY id`,
    [id],
  );
  return rows.map((r) => ({ ...r, world_at: r.world_at.toISOString() }));
}

async function stopSells(uid: string) {
  const { rows } = await db.query(
    `SELECT status, units::text, fill_price::text, price_type, executes_at FROM orders WHERE uid = $1 AND origin = 'stop' ORDER BY id`,
    [uid],
  );
  return rows.map((r) => ({ ...r, executes_at: r.executes_at.toISOString() }));
}

// ---------- moving ----------

describe('PATCH /me/stops/:id moves an active stop', () => {
  it('moves it up and down below the latest close, keeps the history, and every screen shows it', async () => {
    const id = await filledStop('alice', '95');

    const up = await move('alice', id, '98.5');
    expect(up.status).toBe(200);
    expect(up.body as MoveStopResult).toEqual({ stop: { id, price: 98.5, originalPrice: 95, units: 100 }, changed: true });
    expect(await stopRow(id)).toMatchObject({ status: 'active', stop_price: '98.5000', moved_at: WED_TASE_CLOSE });

    const down = await move('alice', id, 90);
    expect(down.body).toEqual({ stop: { id, price: 90, originalPrice: 95, units: 100 }, changed: true });
    expect(await moves(id)).toEqual([
      { uid: 'alice', from_price: '95.0000', to_price: '98.5000', world_at: WED_TASE_CLOSE },
      { uid: 'alice', from_price: '98.5000', to_price: '90.0000', world_at: WED_TASE_CLOSE },
    ]);

    // The dashboard's holding card: the stop as it is now, where it started, and the close a new price must be under.
    const dash = await read<Dashboard>('alice', '/me/dashboard');
    expect(dash.holdings).toMatchObject([{ symbol: 'TEVA', lastClose: 100, stops: [{ id, price: 90, originalPrice: 95, units: 100 }] }]);

    // The journal: the buy keeps the price it was sent with, and shows its stop as it is now.
    const journal = await read<TradeJournalView>('alice', '/me/journal');
    expect(journal.rows).toMatchObject([
      { side: 'buy', status: 'executed', stopPrice: 95, stop: { id, price: 90, status: 'active', lastClose: 100 } },
    ]);

    // The admin's monitoring counts the moves and the players who made them.
    const m: AdminMonitoring = await getAdminMonitoring(db);
    expect(m.totals.today.stops).toMatchObject({ moved: 2, movers: 1 });
  });

  it('the same price again changes nothing and writes no row', async () => {
    const id = await filledStop('alice', '95');
    expect((await move('alice', id, '95.00')).body).toEqual({ stop: { id, price: 95, originalPrice: 95, units: 100 }, changed: false });
    expect(await stopRow(id)).toMatchObject({ stop_price: '95.0000', moved_at: null });
    expect(await moves(id)).toEqual([]);
  });

  it('refuses a price at or above the latest close, and writes nothing', async () => {
    const id = await filledStop('alice', '95');
    for (const p of ['100', '100.0001', '150']) {
      expect(await move('alice', id, p)).toMatchObject({ status: 422, body: { code: 'STOP_NOT_BELOW_PRICE', reason: expect.any(String) } });
    }
    expect(await stopRow(id)).toMatchObject({ stop_price: '95.0000', moved_at: null });
    expect(await moves(id)).toEqual([]);
  });

  it("answers 404 for someone else's stop or an unknown one, and 400 for a bad id or price", async () => {
    const id = await filledStop('alice', '95');
    await signUp('bob');
    expect(await move('bob', id, '90')).toMatchObject({ status: 404, body: { code: 'STOP_NOT_FOUND' } });
    expect(await move('alice', '999999', '90')).toMatchObject({ status: 404, body: { code: 'STOP_NOT_FOUND' } });
    expect(await move('carol', id, '90')).toMatchObject({ status: 404, body: { code: 'NO_USER' } });
    expect((await move('alice', 'abc', '90')).status).toBe(400);
    expect((await move('alice', '0', '90')).status).toBe(400);
    for (const p of ['0', '-1', '90.12345', 'x', null]) expect((await move('alice', id, p)).status).toBe(400);
    expect((await call('PATCH', `/me/stops/${id}`, 'alice', 'not json')).status).toBe(400);
    expect(await stopRow(id)).toMatchObject({ stop_price: '95.0000' });
  });

  it('refuses a stop that fired, or that expired when its position was sold', async () => {
    await price('TEVA', THU, '90.0000', '90.0000');
    await signUp('bob');
    // Both buys fill at Wednesday's close.
    expect((await call('POST', '/me/orders', 'bob', { symbol: 'TEVA', side: 'buy', amountIls: '10000.00', stopPrice: '50' })).status).toBe(201);
    const fired = await filledStop('alice', '95');
    const { rows } = await db.query(`SELECT id::text FROM stop_orders WHERE uid = 'bob'`);
    const expired = rows[0].id;

    // Bob sells everything by hand at Thursday's open; Alice's stop sells at the same open (₪90).
    expect((await call('POST', '/me/orders', 'bob', { symbol: 'TEVA', side: 'sell', units: '100' })).status).toBe(201);
    await runTo(THU_TASE_OPEN);
    expect(await stopRow(fired)).toMatchObject({ status: 'triggered' });
    expect(await stopRow(expired)).toMatchObject({ status: 'expired' });
    expect(await move('alice', fired, '80')).toMatchObject({ status: 409, body: { code: 'STOP_NOT_ACTIVE', reason: expect.any(String) } });
    expect(await move('bob', expired, '40')).toMatchObject({ status: 409, body: { code: 'STOP_NOT_ACTIVE' } });
  });

  it('allows 5 moves a minute per player, apart from the orders', async () => {
    const id = await filledStop('alice', '95');
    for (const p of ['90', '91', '92', '93', '94']) expect((await move('alice', id, p)).status).toBe(200);
    const sixth = await move('alice', id, '89');
    expect(sixth).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED', reason: expect.any(String) } });
    expect(Number(sixth.retryAfter)).toBeGreaterThanOrEqual(1);
    // The same price is still answered: it isn't a move.
    expect((await move('alice', id, '94')).body).toMatchObject({ changed: false });
    // Orders have their own limit.
    expect((await call('POST', '/me/orders', 'alice', { symbol: 'TEVA', side: 'buy', amountIls: '1000.00' })).status).toBe(201);
  });

  it('refuses past the end of the prices: the stop would never be checked again', async () => {
    const id = await filledStop('alice', '95');
    await db.query('UPDATE world_clock SET ends_at = $1', [WED_TASE_CLOSE]);
    expect(await move('alice', id, '90')).toMatchObject({ status: 409, body: { code: 'GAME_OVER' } });
  });
});

// ---------- its market's check ----------

describe("a stop can't be moved while its market's open or close waits for the runner", () => {
  it('refuses from the open or close until the runner has checked the stops at it, then allows it', async () => {
    await price('TEVA', THU, '97.0000', '97.0000');
    const id = await filledStop('alice', '95');

    // 30 s after Thursday's open: the screens may show it, but the runner hasn't started it.
    await db.query('UPDATE world_clock SET now_at = $1', ['2026-11-12T08:00:30.000Z']);
    const early = await move('alice', id, '90');
    expect(early).toMatchObject({ status: 409, body: { code: 'STOP_CHECK_RUNNING', reason: expect.any(String) } });
    expect(early.retryAfter).toBe('15');

    // Started, its stops not checked yet: still refused.
    const open = eventsBetween(new Date(WED_TASE_CLOSE), new Date(THU_TASE_OPEN), NO_CLOSURES)
      .find((e) => e.market === 'TASE' && e.kind === 'open')!;
    const c = await db.connect();
    try {
      const row = await startEvent(c, open);
      expect(await move('alice', id, '90')).toMatchObject({ status: 409, body: { code: 'STOP_CHECK_RUNNING' } });
      await runEvent(c, row);
    } finally {
      c.release();
    }
    expect(await move('alice', id, '90')).toMatchObject({ status: 200, body: { changed: true } });
    expect(await moves(id)).toHaveLength(1);
  });

  it("another market's open doesn't hold it", async () => {
    const id = await filledStop('alice', '95');
    // 30 s after Wednesday's New York close (23:00 Israel, 21:00 UTC). The runner hasn't started it (runTo stopped at
    // the TASE close), but it is NVDA's market, not TEVA's: TEVA's latest event, the TASE close, is done.
    await db.query('UPDATE world_clock SET now_at = $1', ['2026-11-11T21:00:30.000Z']);
    expect(await move('alice', id, '90')).toMatchObject({ status: 200, body: { changed: true } });
  });
});

// ---------- the runner checks the moved price ----------

describe('the runner checks a moved stop at its new price', () => {
  it('a stop raised to ₪98 sells at an open of ₪97 that ₪95 would have let pass', async () => {
    await price('TEVA', THU, '97.0000', '99.0000');
    const id = await filledStop('alice', '95');
    expect((await move('alice', id, '98')).status).toBe(200);

    await runTo(THU_TASE_OPEN);
    expect(await stopSells('alice')).toMatchObject([
      { status: 'executed', units: '100.00000000', fill_price: '97.0000', price_type: 'open', executes_at: THU_TASE_OPEN },
    ]);
    expect(await stopRow(id)).toMatchObject({ status: 'triggered', stop_price: '98.0000' });
    expect(await ledgerMismatches(db, ['alice'])).toEqual([]);

    // The journal's stop sell names the stop that fired: the moved price.
    const journal = await read<TradeJournalView>('alice', '/me/journal');
    expect(journal.rows[0]).toMatchObject({ origin: 'stop', stopPrice: 98 });
    expect(journal.rows[1]).toMatchObject({ side: 'buy', stopPrice: 95, stop: { id, price: 98, status: 'triggered', lastClose: null } });
  });

  it('a stop lowered to ₪90 lets an open of ₪92 pass', async () => {
    await price('TEVA', THU, '92.0000', '95.0000');
    const id = await filledStop('alice', '95');
    expect((await move('alice', id, '90')).status).toBe(200);
    await runTo(THU_TASE_CLOSE);
    expect(await stopSells('alice')).toEqual([]);
    expect(await stopRow(id)).toMatchObject({ status: 'active' });
  });

  it('a stop raised above the buy price fires on the price only, never because of the buy price', async () => {
    // Bought at ₪100 on Wednesday; Thursday closes at ₪121, so ₪110 is below the latest close and above the buy.
    await price('TEVA', THU, '120.0000', '121.0000');
    await price('TEVA', FRI, '115.0000', '109.0000');
    const id = await filledStop('alice', '95');
    await runTo(THU_TASE_CLOSE);
    expect((await move('alice', id, '110')).status).toBe(200);

    await runTo(FRI_TASE_OPEN);   // ₪115 is above ₪110: before D-041 the buy price (₪100 ≤ ₪110) would have fired it
    expect(await stopSells('alice')).toEqual([]);

    await runTo(FRI_TASE_CLOSE);  // ₪109: at or below ₪110
    expect(await stopSells('alice')).toMatchObject([{ status: 'executed', fill_price: '109.0000', price_type: 'close' }]);
    expect(await ledgerMismatches(db, ['alice'])).toEqual([]);
  });
});
