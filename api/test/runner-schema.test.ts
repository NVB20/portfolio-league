// The runner migration (20261110100000000_runner.sql) and the effective "now", against a real Postgres
// (TEST_DATABASE_URL). The database rules here hold even if the runner or the order endpoint has a bug.
//
// World time used: Wednesday 2026-11-11, 12:40 Israel (10:40 UTC). TASE closes at 17:30 Israel (15:30 UTC).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { loadNow } from '../src/dashboard.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

const db = new pg.Pool({ connectionString: DATABASE_URL });
let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;

const WED_1240 = '2026-11-11T10:40:00.000Z';
const TASE_CLOSE = '2026-11-11T15:30:00.000Z';

beforeAll(async () => {
  await runner({ databaseUrl: DATABASE_URL, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
  const test = await makeTestKeys();
  privateKey = test.privateKey;
  app = createApp({ db, verifyToken: makeFirebaseVerifier(PROJECT_ID, test.keys), corsOrigins: [] });
});

beforeEach(async () => {
  await db.query('TRUNCATE users, securities, usd_ils, world_clock, market_events CASCADE');
  await db.query(`INSERT INTO securities VALUES ('TEVA', 'טבע', 'TASE', 'TASE', 'ILS')`);
});

afterAll(async () => {
  await db.end();
});

async function call(method: string, path: string, uid: string) {
  const token = await signToken(privateKey, uid);
  return app.request(path, { method, headers: { Authorization: `Bearer ${token}` } });
}

async function signUp(uid: string) {
  expect((await call('POST', '/me', uid)).status).toBe(200);
}

// One pending buy for alice; returns its id.
async function pendingBuy(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (uid, symbol, side, amount_ils, placed_at, executes_at, price_type)
     VALUES ('alice', 'TEVA', 'buy', 1000, $1, $2, 'close') RETURNING id::text AS id`,
    [WED_1240, TASE_CLOSE],
  );
  return rows[0].id;
}

// The TASE close event the runner would write; returns its id.
async function taseClose(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO market_events (market, kind, day, at) VALUES ('TASE', 'close', '2026-11-11', $1) RETURNING id::text AS id`,
    [TASE_CLOSE],
  );
  return rows[0].id;
}

const reject = (orderId: string, eventId: string | null, code: string | null = null) =>
  db.query(
    `UPDATE orders SET status = 'rejected', reject_reason = 'אין מספיק מזומן', reject_code = $3, event_id = $2 WHERE id = $1`,
    [orderId, eventId, code],
  );

describe('orders: the event that ran them', () => {
  it('a pending order has no event; an executed or rejected order must name one', async () => {
    await signUp('alice');
    const event = await taseClose();
    await expect(
      db.query(
        `INSERT INTO orders (uid, symbol, side, amount_ils, placed_at, executes_at, price_type, event_id)
         VALUES ('alice', 'TEVA', 'buy', 1000, $1, $2, 'close', $3)`,
        [WED_1240, TASE_CLOSE, event],
      ),
    ).rejects.toThrow(/orders_event_check/);

    const order = await pendingBuy();
    await expect(reject(order, null)).rejects.toThrow(/orders_event_check/);
    await reject(order, event);
    const { rows } = await db.query(`SELECT status, event_id::text AS event_id FROM orders WHERE id = $1`, [order]);
    expect(rows[0]).toEqual({ status: 'rejected', event_id: event });
  });

  it('can only name an event that exists, and an event its orders point to cannot be deleted', async () => {
    await signUp('alice');
    const order = await pendingBuy();
    await expect(reject(order, '999999')).rejects.toThrow(/orders_event_id_fkey/);
    await reject(order, await taseClose());
    await expect(db.query('DELETE FROM market_events')).rejects.toThrow(/orders_event_id_fkey/);
  });
});

describe('orders: the reject code', () => {
  it('is one of the engine\'s four codes', async () => {
    await signUp('alice');
    const event = await taseClose();
    for (const code of ['NO_PRICE', 'INSUFFICIENT_CASH', 'OVER_LIMIT', 'INSUFFICIENT_UNITS']) {
      await reject(await pendingBuy(), event, code);
    }
    // Send-time refusals (GAME_OVER, BELOW_MIN...) are answered with an error and never stored.
    await expect(reject(await pendingBuy(), event, 'GAME_OVER')).rejects.toThrow(/orders_reject_code_check/);
    const { rows } = await db.query(`SELECT reject_code FROM orders WHERE status = 'rejected' ORDER BY id`);
    expect(rows.map((r) => r.reject_code)).toEqual(['NO_PRICE', 'INSUFFICIENT_CASH', 'OVER_LIMIT', 'INSUFFICIENT_UNITS']);
  });

  it('is set only on a rejected order (and may be missing on one)', async () => {
    await signUp('alice');
    const order = await pendingBuy();
    await expect(db.query(`UPDATE orders SET reject_code = 'NO_PRICE' WHERE id = $1`, [order]))
      .rejects.toThrow(/orders_reject_code_status_check/);
    await reject(order, await taseClose(), null);
  });
});

describe('orders: when the player saw the rejection', () => {
  it('is empty until seen, and only a rejected order can be marked seen', async () => {
    await signUp('alice');
    const order = await pendingBuy();
    expect((await db.query(`SELECT notified_at FROM orders WHERE id = $1`, [order])).rows[0].notified_at).toBeNull();
    await expect(db.query(`UPDATE orders SET notified_at = now() WHERE id = $1`, [order])).rejects.toThrow(/orders_notified_check/);
    await reject(order, await taseClose(), 'INSUFFICIENT_CASH');
    await db.query(`UPDATE orders SET notified_at = now() WHERE id = $1`, [order]);
  });
});

describe('the runner\'s indexes', () => {
  it('exist, with their partial conditions', async () => {
    const { rows } = await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE indexname IN ('orders_uid_created_idx', 'orders_event_idx', 'orders_unseen_rejections_idx', 'positions_open_symbol_idx')
       ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'orders_event_idx', 'orders_uid_created_idx', 'orders_unseen_rejections_idx', 'positions_open_symbol_idx',
    ]);
    const def = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(def.orders_uid_created_idx).toMatch(/\(uid, created_at DESC\)$/);
    expect(def.orders_event_idx).toMatch(/\(event_id\) WHERE \(event_id IS NOT NULL\)$/);
    expect(def.orders_unseen_rejections_idx).toMatch(/\(uid\) WHERE \(\(status = 'rejected'::text\) AND \(notified_at IS NULL\)\)$/);
    expect(def.positions_open_symbol_idx).toMatch(/\(symbol, uid\) WHERE \(status = 'open'::text\)$/);
  });
});

describe('world_clock: the heartbeat and how far the runner has started', () => {
  it('starts empty: no tick yet, no event started yet', async () => {
    await db.query(`INSERT INTO world_clock (now_at) VALUES ($1)`, [WED_1240]);
    const { rows } = await db.query('SELECT last_tick_at, events_through FROM world_clock');
    expect(rows[0]).toEqual({ last_tick_at: null, events_through: null });
  });
});

describe('loadNow: the effective now (D-017, D-021)', () => {
  it('is the stored clock when no event has started, and reports the row behind it', async () => {
    await db.query(`INSERT INTO world_clock (now_at) VALUES ($1)`, [WED_1240]);
    const now = (await loadNow(db))!;
    expect(now.at.toISOString()).toBe(WED_1240);
    expect(now.nowAt.toISOString()).toBe(WED_1240);
    expect(now.running).toBe(false);
    expect(now.eventsThrough).toBeNull();
    expect(now.closed.tase).toBe('2026-11-10');   // TASE is open: Tuesday's close is the latest known
  });

  it('is never before the latest event the runner has started (an admin jump in progress)', async () => {
    await db.query(`INSERT INTO world_clock (now_at, events_through) VALUES ($1, $2)`, [WED_1240, TASE_CLOSE]);
    const now = (await loadNow(db))!;
    expect(now.at.toISOString()).toBe(TASE_CLOSE);
    expect(now.nowAt.toISOString()).toBe(WED_1240);           // the stored anchor hasn't moved
    expect(now.eventsThrough?.toISOString()).toBe(TASE_CLOSE);
    expect(now.closed.tase).toBe('2026-11-11');                // today's close is now known
  });

  it('is the running clock once it has passed the latest event', async () => {
    // Set 90 real minutes ago at 12:40 Israel and running: 14:10 Israel, past the 12:00 open event.
    await db.query(
      `INSERT INTO world_clock (now_at, real_at, running, events_through) VALUES ($1, now() - interval '90 minutes', TRUE, $2)`,
      [WED_1240, '2026-11-11T10:00:00Z'],
    );
    const now = (await loadNow(db))!;
    expect(now.at.toISOString().slice(0, 16)).toBe('2026-11-11T12:10');
    expect(now.running).toBe(true);
  });

  it('is what the screens show: the dashboard clock agrees with the order rules', async () => {
    await signUp('alice');
    await db.query(`INSERT INTO world_clock (now_at, events_through) VALUES ($1, $2)`, [WED_1240, TASE_CLOSE]);
    const { clock } = await (await call('GET', '/me/dashboard', 'alice')).json();
    expect(clock.time).toBe('17:30');
    expect(clock.markets.tase.state).toBe('after_close');
  });
});
