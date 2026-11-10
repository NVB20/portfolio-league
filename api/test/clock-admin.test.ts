// The admin clock moves and the per-minute ticker (api/src/clockActions.ts; D-017, D-021, D-027, D-030)
// against a real Postgres (TEST_DATABASE_URL). Orders go through POST /me/orders, so their reserve journals
// are the real ones; the admin moves go through POST /admin/clock/*. Money is checked as the exact NUMERIC
// strings Postgres stores.
//
// Calendar: November 2026. Israel is UTC+2 and New York UTC−5, so (Israel time / UTC):
//   TASE open 10:00 / 08:00Z, US open 16:30 / 14:30Z, TASE close 17:30 / 15:30Z, US close 23:00 / 21:00Z.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { runner as migrate } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { forgetCalendar } from '../src/calendar.js';
import { advanceClock, runDue, startTicker, stopClock } from '../src/clockActions.js';
import { RUNNER_LOCK_KEY, type RunSummary, startEvent } from '../src/runner.js';
import { eventsBetween } from '../src/game/clock.js';
import { type Market, type MarketEvent, NO_CLOSURES } from '../src/game/marketHours.js';
import { addDays, ISRAEL, zonedToInstant } from '../src/game/time.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

const db = new pg.Pool({ connectionString: DATABASE_URL });
let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;

const MON = '2026-11-09';
const TUE = '2026-11-10';

beforeAll(async () => {
  await migrate({ databaseUrl: DATABASE_URL, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
  const test = await makeTestKeys();
  privateKey = test.privateKey;
  app = createApp({ db, verifyToken: makeFirebaseVerifier(PROJECT_ID, test.keys), corsOrigins: [] });
});

beforeEach(async () => {
  await db.query('TRUNCATE users, securities, usd_ils, world_clock, market_events, market_closures CASCADE');
  forgetCalendar(db);
  await db.query(
    `INSERT INTO securities (symbol, name_he, market, exchange, currency) VALUES
       ('TEVA', 'טבע', 'TASE', 'TASE', 'ILS'), ('LUMI', 'לאומי', 'TASE', 'TASE', 'ILS'),
       ('NVDA', 'אנבידיה', 'US', 'NASDAQ', 'USD')`,
  );
  await signUp('root');
  await db.query(`UPDATE users SET roles = '{admin,user}' WHERE uid = 'root'`);
});

afterAll(async () => {
  await db.end();
});

// ---------- helpers ----------

const israel = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedToInstant(day, h * 60 + m, ISRAEL);
};
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NOTHING: RunSummary = { events: 0, ordersExecuted: 0, ordersRejected: 0, playersUpdated: 0 };

// The open or close of a market on an Israel date (weekend rule only).
function ev(market: Market, kind: 'open' | 'close', day: string): MarketEvent {
  const e = eventsBetween(zonedToInstant(day, 0, ISRAEL), zonedToInstant(addDays(day, 1), 0, ISRAEL), NO_CLOSURES)
    .find((x) => x.market === market && x.kind === kind);
  if (!e) throw new Error(`no ${market} ${kind} on ${day}`);
  return e;
}

// Waits for a condition the ticker makes true (it runs on its own timer).
async function until(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting for the ticker');
    await sleep(10);
  }
}

async function call(method: string, path: string, uid?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (uid !== undefined) headers.Authorization = `Bearer ${await signToken(privateKey, uid)}`;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function signUp(uid: string) {
  expect((await call('POST', '/me', uid)).status).toBe(200);
}

// An admin clock move by 'root', as the admin page sends it.
async function admin(path: string) {
  const res = await call('POST', path, 'root');
  return { status: res.status, body: await res.json() };
}

async function send(uid: string, body: unknown) {
  const res = await call('POST', '/me/orders', uid, body);
  const out = await res.json();
  expect(res.status, JSON.stringify(out)).toBe(201);
  return out.order.id as string;
}

type World = { nowAt: Date; running?: boolean; endsAt?: Date | null };
async function world({ nowAt, running = false, endsAt = null }: World) {
  await db.query('INSERT INTO world_clock (now_at, running, ends_at) VALUES ($1, $2, $3)', [nowAt, running, endsAt]);
}

async function price(symbol: string, day: string, open: string, close: string) {
  await db.query('INSERT INTO prices (symbol, day, open, close) VALUES ($1, $2, $3, $4)', [symbol, day, open, close]);
}

async function fx(day: string, open: string, close: string) {
  await db.query('INSERT INTO usd_ils (day, open, close) VALUES ($1, $2, $3)', [day, open, close]);
}

async function clock() {
  const { rows } = await db.query(
    'SELECT now_at, real_at, running, ends_at, events_through, last_tick_at FROM world_clock',
  );
  const r = rows[0];
  return r && {
    ...r,
    now_at: iso(r.now_at),
    ends_at: iso(r.ends_at),
    events_through: iso(r.events_through),
    last_tick_at: iso(r.last_tick_at),
  };
}

async function actions() {
  const { rows } = await db.query('SELECT uid, action, world_from, world_to, detail FROM admin_actions ORDER BY id');
  return rows.map((r) => ({ ...r, world_from: iso(r.world_from), world_to: iso(r.world_to) }));
}

async function portfolio(uid: string) {
  const { rows } = await db.query(
    `SELECT cash::text, reserved_cash::text, holdings_value::text, equity::text, realized_pnl::text,
            unrealized_pnl::text
     FROM portfolios WHERE uid = $1`,
    [uid],
  );
  return rows[0];
}

async function positionsOf(uid: string) {
  const { rows } = await db.query(
    `SELECT symbol, status, units::text, reserved_units::text, cost_basis_ils::text, realized_pnl_ils::text,
            market_value_ils::text
     FROM positions WHERE uid = $1 ORDER BY symbol`,
    [uid],
  );
  return rows;
}

async function order(id: string) {
  const { rows } = await db.query(
    `SELECT o.status, o.fill_price::text, o.filled_units::text, o.filled_ils::text, o.reject_code,
            e.market AS event_market, e.kind AS event_kind, e.day::text AS event_day
     FROM orders o LEFT JOIN market_events e ON e.id = o.event_id WHERE o.id = $1`,
    [id],
  );
  return rows[0];
}

async function events() {
  const { rows } = await db.query(
    `SELECT market, kind, day::text, status, ledger_balanced FROM market_events ORDER BY at, kind = 'open'`,
  );
  return rows;
}

async function holdRunnerLock() {
  const other = await db.connect();
  await other.query('SELECT pg_advisory_lock($1)', [RUNNER_LOCK_KEY]);
  return async () => {
    await other.query('SELECT pg_advisory_unlock($1)', [RUNNER_LOCK_KEY]);
    other.release();
  };
}

// A pool whose connections fail the admin_actions INSERT: a failure inside the final transaction,
// after the clock row was already updated in it.
function poolFailingTheLog() {
  const failing = new pg.Pool({ connectionString: DATABASE_URL });
  failing.on('connect', (client) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) =>
      typeof args[0] === 'string' && args[0].includes('INSERT INTO admin_actions')
        ? Promise.reject(new Error('the disk is full'))
        : query(...args);
  });
  return failing;
}

// ---------- who may move the clock ----------

describe('admin access to the clock', () => {
  const routes = ['/admin/clock/advance', '/admin/clock/start', '/admin/clock/stop'];

  it('returns 401 without a token and 403 to a normal player, and moves nothing', async () => {
    await world({ nowAt: israel(MON, '12:00') });
    await signUp('mallory');
    const before = await clock();
    for (const path of routes) {
      expect((await call('POST', path)).status).toBe(401);
      expect((await call('POST', path, 'mallory')).status).toBe(403);
    }
    expect(await clock()).toEqual(before);
    expect(await actions()).toEqual([]);
  });

  it('answers 409 NO_WORLD before the world has started', async () => {
    for (const path of routes) {
      expect(await admin(path)).toMatchObject({ status: 409, body: { code: 'NO_WORLD', reason: expect.any(String) } });
    }
    expect(await actions()).toEqual([]);
  });
});

// ---------- advance ----------

describe('POST /admin/clock/advance', () => {
  it('jumps to the close, the next close, then the next open, running the orders due and logging each move', async () => {
    await world({ nowAt: israel(MON, '12:00') });
    await signUp('alice');
    await signUp('bob');
    await price('TEVA', MON, '39.0000', '40.0000');
    await price('TEVA', TUE, '42.0000', '43.0000');
    await price('NVDA', MON, '99.0000', '100.0000');
    await fx(MON, '3.6900', '3.7000');

    // Monday 12:00: TASE is open, New York not yet. Both buys run at today's TASE close.
    const teva = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '10000.00' });
    const lumi = await send('bob', { symbol: 'LUMI', side: 'buy', amountIls: '5000.00' });   // no LUMI price: NO_PRICE

    const first = await admin('/admin/clock/advance');
    expect(first.status).toBe(200);
    // Passed: the US open (nobody holds US stocks yet) and the TASE close (alice's fill re-values her).
    expect(first.body).toMatchObject({
      kind: 'to_close',
      from: { at: israel(MON, '12:00').toISOString(), date: MON, time: '12:00' },
      to: { at: israel(MON, '17:30').toISOString(), date: MON, time: '17:30' },
      events: 2, ordersExecuted: 1, ordersRejected: 1, playersUpdated: 1,
      clock: {
        date: MON, time: '17:30', running: false, endsAt: null,
        markets: { tase: { isOpen: false }, us: { isOpen: true } },
      },
    });
    expect(await order(teva)).toMatchObject({
      status: 'executed', fill_price: '40.0000', filled_units: '250.00000000', filled_ils: '10000.00',
      event_market: 'TASE', event_kind: 'close', event_day: MON,
    });
    expect(await order(lumi)).toMatchObject({ status: 'rejected', reject_code: 'NO_PRICE' });
    expect(await portfolio('bob')).toMatchObject({ cash: '1000000.0000', reserved_cash: '0.00' });
    expect(await clock()).toMatchObject({
      now_at: israel(MON, '17:30').toISOString(), running: false, events_through: israel(MON, '17:30').toISOString(),
    });

    // 17:30: New York is open, so the next move is its close.
    const nvda = await send('alice', { symbol: 'NVDA', side: 'buy', amountIls: '20000.00' });
    const second = await admin('/admin/clock/advance');
    expect(second.body).toMatchObject({
      kind: 'to_close', from: { time: '17:30' }, to: { date: MON, time: '23:00' },
      events: 1, ordersExecuted: 1, ordersRejected: 0, playersUpdated: 1,
    });
    expect(await order(nvda)).toMatchObject({ status: 'executed', fill_price: '100.0000', filled_units: '54.05405405' });

    // 23:00: both markets closed, so the next move is the next open (Tuesday's TASE open). A sell sent now runs there.
    const sell = await send('alice', { symbol: 'TEVA', side: 'sell', units: '50' });
    const third = await admin('/admin/clock/advance');
    expect(third.body).toMatchObject({
      kind: 'to_open', from: { date: MON, time: '23:00' }, to: { date: TUE, time: '10:00' },
      events: 1, ordersExecuted: 1, ordersRejected: 0, playersUpdated: 1,
      clock: { date: TUE, time: '10:00', markets: { tase: { isOpen: true }, us: { isOpen: false } } },
    });
    expect(await order(sell)).toMatchObject({ status: 'executed', fill_price: '42.0000', filled_ils: '2100.00' });

    // The money, exactly: 1,000,000 − 10,000 − 20,000 + 2,100 cash; TEVA 200 units at cost 8,000.00 marked at
    // 42 = 8,400.00; NVDA 54.05405405 units marked at 100 × 3.7 = 20,000.00 (19,999.9999985 rounded).
    expect(await portfolio('alice')).toEqual({
      cash: '972100.0000', reserved_cash: '0.00', holdings_value: '28400.00', equity: '1000500.0000',
      realized_pnl: '100.00', unrealized_pnl: '400.00',
    });
    expect(await positionsOf('alice')).toEqual([
      { symbol: 'NVDA', status: 'open', units: '54.05405405', reserved_units: '0.00000000', cost_basis_ils: '20000.00',
        realized_pnl_ils: '0.00', market_value_ils: '20000.00' },
      { symbol: 'TEVA', status: 'open', units: '200.00000000', reserved_units: '0.00000000', cost_basis_ils: '8000.00',
        realized_pnl_ils: '100.00', market_value_ils: '8400.00' },
    ]);

    // Every event in between ran, in order, each with a balanced ledger.
    expect(await events()).toEqual([
      { market: 'US', kind: 'open', day: MON, status: 'done', ledger_balanced: true },
      { market: 'TASE', kind: 'close', day: MON, status: 'done', ledger_balanced: true },
      { market: 'US', kind: 'close', day: MON, status: 'done', ledger_balanced: true },
      { market: 'TASE', kind: 'open', day: TUE, status: 'done', ledger_balanced: true },
    ]);

    // One log row per move, with the run's counts (D-027).
    expect(await actions()).toEqual([
      { uid: 'root', action: 'clock_to_close', world_from: israel(MON, '12:00').toISOString(), world_to: israel(MON, '17:30').toISOString(),
        detail: { events: 2, ordersExecuted: 1, ordersRejected: 1, playersUpdated: 1 } },
      { uid: 'root', action: 'clock_to_close', world_from: israel(MON, '17:30').toISOString(), world_to: israel(MON, '23:00').toISOString(),
        detail: { events: 1, ordersExecuted: 1, ordersRejected: 0, playersUpdated: 1 } },
      { uid: 'root', action: 'clock_to_open', world_from: israel(MON, '23:00').toISOString(), world_to: israel(TUE, '10:00').toISOString(),
        detail: { events: 1, ordersExecuted: 1, ordersRejected: 0, playersUpdated: 1 } },
    ]);
  });

  it('a running clock keeps running from the jump\'s target', async () => {
    await world({ nowAt: israel(MON, '12:00'), running: true });
    const before = Date.now();
    const res = await admin('/admin/clock/advance');
    expect(res.body).toMatchObject({ kind: 'to_close', to: { time: '17:30' }, clock: { running: true, time: '17:30' } });
    const c = await clock();
    expect(c).toMatchObject({ now_at: israel(MON, '17:30').toISOString(), running: true });
    expect(c.real_at.getTime()).toBeGreaterThanOrEqual(before - 1000);   // the anchor's real time is the move's
  });

  it('is capped at ends_at, and answers 409 CLOCK_AT_END once the clock is there', async () => {
    await world({ nowAt: israel(MON, '12:00'), endsAt: israel(MON, '15:00') });
    const capped = await admin('/admin/clock/advance');
    expect(capped.body).toMatchObject({ kind: 'to_close', to: { time: '15:00' }, events: 0 });
    expect(await clock()).toMatchObject({ now_at: israel(MON, '15:00').toISOString() });

    const atEnd = await admin('/admin/clock/advance');
    expect(atEnd).toMatchObject({ status: 409, body: { code: 'CLOCK_AT_END', reason: expect.any(String) } });
    expect(await clock()).toMatchObject({ now_at: israel(MON, '15:00').toISOString() });
    expect(await actions()).toHaveLength(1);
    expect(await events()).toEqual([]);
  });

  it('answers 409 CLOCK_BUSY while another runner holds the lock; start still works (it runs nothing)', async () => {
    await world({ nowAt: israel(MON, '12:00') });
    const release = await holdRunnerLock();
    try {
      expect(await admin('/admin/clock/advance')).toMatchObject({ status: 409, body: { code: 'CLOCK_BUSY', reason: expect.any(String) } });
      expect(await admin('/admin/clock/start')).toMatchObject({ status: 200, body: { changed: true } });
      expect(await admin('/admin/clock/stop')).toMatchObject({ status: 409, body: { code: 'CLOCK_BUSY' } });
    } finally {
      await release();
    }
    expect(await clock()).toMatchObject({ now_at: israel(MON, '12:00').toISOString(), running: true });
    expect((await actions()).map((a) => a.action)).toEqual(['clock_start']);
    expect(await events()).toEqual([]);
  });

  it('a failure inside the final transaction leaves no log row and no clock move', async () => {
    await world({ nowAt: israel(MON, '12:00') });
    await signUp('alice');
    await price('TEVA', MON, '40.0000', '40.0000');
    const teva = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '10000.00' });

    const failing = poolFailingTheLog();
    try {
      await expect(advanceClock(failing, 'root')).rejects.toThrow('the disk is full');
    } finally {
      await failing.end();
    }
    expect(await clock()).toMatchObject({ now_at: israel(MON, '12:00').toISOString(), running: false });
    expect(await actions()).toEqual([]);
    // The run before it had already committed, event by event: those are safe to re-run and are not undone.
    expect(await order(teva)).toMatchObject({ status: 'executed' });
    expect(await clock()).toMatchObject({ events_through: israel(MON, '17:30').toISOString() });

    // The runner lock was let go. The close has run, so the effective "now" is already 17:30 (D-029).
    const again = await admin('/admin/clock/advance');
    expect(again.body).toMatchObject({ kind: 'to_close', from: { time: '17:30' }, to: { time: '23:00' } });
    expect((await actions()).map((a) => a.action)).toEqual(['clock_to_close']);
  });
});

// ---------- start and stop ----------

describe('POST /admin/clock/start and /stop', () => {
  it('are idempotent: a second start or stop changes nothing and logs nothing', async () => {
    await world({ nowAt: israel(MON, '12:00') });
    await db.query(`UPDATE world_clock SET real_at = '2026-01-01T00:00:00Z'`);
    const before = Date.now();

    const started = await admin('/admin/clock/start');
    expect(started).toMatchObject({ status: 200, body: { changed: true, clock: { running: true, date: MON, time: '12:00' } } });
    const c = await clock();
    expect(c).toMatchObject({ now_at: israel(MON, '12:00').toISOString(), running: true });
    expect(c.real_at.getTime()).toBeGreaterThanOrEqual(before - 1000);   // runs from now, not from January

    expect(await admin('/admin/clock/start')).toMatchObject({ status: 200, body: { changed: false, clock: { running: true } } });
    expect(await clock()).toEqual(c);

    const stopped = await admin('/admin/clock/stop');
    expect(stopped).toMatchObject({
      status: 200,
      body: { changed: true, events: 0, ordersExecuted: 0, ordersRejected: 0, playersUpdated: 0, clock: { running: false } },
    });
    const s = await clock();
    expect(s.running).toBe(false);
    expect(stopped.body.at.at).toBe(s.now_at);
    const ranMs = new Date(s.now_at).getTime() - israel(MON, '12:00').getTime();
    expect(ranMs).toBeGreaterThanOrEqual(0);
    expect(ranMs).toBeLessThan(Date.now() - before + 1000);

    expect(await admin('/admin/clock/stop')).toMatchObject({ status: 200, body: { changed: false, clock: { running: false } } });
    expect(await clock()).toEqual(s);

    expect(await actions()).toEqual([
      { uid: 'root', action: 'clock_start', world_from: israel(MON, '12:00').toISOString(), world_to: israel(MON, '12:00').toISOString(), detail: {} },
      { uid: 'root', action: 'clock_stop', world_from: s.now_at, world_to: s.now_at,
        detail: { events: 0, ordersExecuted: 0, ordersRejected: 0, playersUpdated: 0 } },
    ]);
  });

  it('stop freezes the clock at the moment it took the lock, after running every event up to it', async () => {
    await world({ nowAt: israel(MON, '17:29'), running: true });
    await signUp('alice');
    await price('TEVA', MON, '40.0000', '40.0000');
    const teva = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '10000.00' });   // runs at the 17:30 close
    // Two minutes of real time pass: the running clock is now past the close, which hasn't run yet.
    await db.query(`UPDATE world_clock SET real_at = real_at - interval '2 minutes'`);

    const res = await admin('/admin/clock/stop');
    expect(res.body).toMatchObject({
      changed: true, at: { date: MON, time: '17:31' }, events: 1, ordersExecuted: 1, ordersRejected: 0, playersUpdated: 1,
      clock: { running: false, time: '17:31', markets: { tase: { isOpen: false } } },
    });
    const c = await clock();
    expect(c).toMatchObject({ running: false, events_through: israel(MON, '17:30').toISOString() });
    expect(c.now_at).toBe(res.body.at.at);
    expect(new Date(c.now_at).getTime()).toBeGreaterThanOrEqual(israel(MON, '17:31').getTime());
    expect(new Date(c.now_at).getTime()).toBeLessThan(israel(MON, '17:32').getTime());
    expect(await order(teva)).toMatchObject({ status: 'executed', event_kind: 'close', event_day: MON });
    expect(await portfolio('alice')).toMatchObject({ cash: '990000.0000', reserved_cash: '0.00', holdings_value: '10000.00' });

    // Frozen: real time passing doesn't move it.
    await sleep(30);
    expect((await clock()).now_at).toBe(c.now_at);
    expect(await actions()).toEqual([
      { uid: 'root', action: 'clock_stop', world_from: c.now_at, world_to: c.now_at,
        detail: { events: 1, ordersExecuted: 1, ordersRejected: 0, playersUpdated: 1 } },
    ]);
  });

  it('a failure inside stop\'s final transaction leaves the clock running and logs nothing', async () => {
    await world({ nowAt: israel(MON, '12:00'), running: true });
    const before = await clock();
    const failing = poolFailingTheLog();
    try {
      await expect(stopClock(failing, 'root')).rejects.toThrow('the disk is full');
    } finally {
      await failing.end();
    }
    expect(await clock()).toEqual(before);
    expect(await actions()).toEqual([]);
  });
});

// ---------- the ticker ----------

describe('the ticker', () => {
  // A running clock two minutes past Monday's 17:29, with alice's buy due at the 17:30 close (not run yet).
  async function closeIsDue(): Promise<string> {
    await world({ nowAt: israel(MON, '17:29'), running: true });
    await signUp('alice');
    await price('TEVA', MON, '40.0000', '40.0000');
    const id = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '10000.00' });
    await db.query(`UPDATE world_clock SET real_at = real_at - interval '2 minutes'`);
    return id;
  }

  it('writes its heartbeat on every tick, even while another runner holds the lock (and then runs nothing)', async () => {
    const teva = await closeIsDue();
    const release = await holdRunnerLock();
    const stop = startTicker(db, { intervalMs: 20 });
    try {
      await until(async () => (await clock()).last_tick_at !== null);
      const first = (await clock()).last_tick_at;
      await until(async () => (await clock()).last_tick_at !== first);   // it keeps beating
    } finally {
      await stop();
      await release();
    }
    expect(await events()).toEqual([]);
    expect(await order(teva)).toMatchObject({ status: 'pending' });
  });

  it('runs the events a running clock has passed, and never moves the clock itself', async () => {
    const teva = await closeIsDue();
    const before = await clock();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stop = startTicker(db, { intervalMs: 20 });
    try {
      await until(async () => (await order(teva)).status === 'executed' && (await events())[0]?.status === 'done');
    } finally {
      await stop();
      log.mockRestore();
    }
    expect(await events()).toEqual([{ market: 'TASE', kind: 'close', day: MON, status: 'done', ledger_balanced: true }]);
    expect(await portfolio('alice')).toMatchObject({ cash: '990000.0000', reserved_cash: '0.00', holdings_value: '10000.00' });
    const after = await clock();
    expect(after).toMatchObject({ now_at: before.now_at, real_at: before.real_at, running: true });
    expect(after.last_tick_at).not.toBeNull();
    expect(await actions()).toEqual([]);   // the ticker is not an admin action
  });

  it('finishes an event a crash left unfinished', async () => {
    await world({ nowAt: israel(MON, '17:29') });
    await signUp('alice');
    await price('TEVA', MON, '40.0000', '40.0000');
    const teva = await send('alice', { symbol: 'TEVA', side: 'buy', amountIls: '10000.00' });
    // An admin jump started the 17:30 close, then the process died before running it or moving the clock.
    const client = await db.connect();
    try {
      await startEvent(client, ev('TASE', 'close', MON));
    } finally {
      client.release();
    }
    expect(await events()).toMatchObject([{ status: 'pending' }]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stop = startTicker(db, { intervalMs: 20 });
    try {
      await until(async () => (await events())[0].status === 'done');
    } finally {
      await stop();
      log.mockRestore();
    }
    expect(await order(teva)).toMatchObject({ status: 'executed', event_kind: 'close' });
    expect(await clock()).toMatchObject({ now_at: israel(MON, '17:29').toISOString(), running: false });
  });

  it('never runs twice at once, even when a run takes longer than the interval', async () => {
    await world({ nowAt: israel(MON, '12:00') });
    let active = 0;
    let most = 0;
    let runs = 0;
    const targets: string[] = [];
    const slow = async (_c: pg.PoolClient, target: Date) => {
      active++;
      runs++;
      most = Math.max(most, active);
      targets.push(target.toISOString());
      await sleep(60);
      active--;
      return NOTHING;
    };
    const stop = startTicker(db, { intervalMs: 5, run: slow });
    await sleep(300);
    await stop();
    expect(most).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(active).toBe(0);   // stop() waited for the run in progress
    // Each run's target is the effective now: here the stopped clock's time.
    expect(new Set(targets)).toEqual(new Set([israel(MON, '12:00').toISOString()]));
  });

  it('logs a failing run and keeps ticking: nothing is thrown out of the timer', async () => {
    await world({ nowAt: israel(MON, '12:00') });
    let runs = 0;
    const failing = async () => {
      runs++;
      throw new Error('the database went away');
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = startTicker(db, { intervalMs: 10, run: failing });
    try {
      await until(async () => runs >= 3);
      await stop();
      expect(errors).toHaveBeenCalledWith('ticker: run failed; the next tick resumes it', expect.any(Error));
    } finally {
      await stop();
      errors.mockRestore();
    }
  });

  it('stop() halts it: no run and no heartbeat after it resolves', async () => {
    await world({ nowAt: israel(MON, '12:00') });
    let runs = 0;
    const count = async () => {
      runs++;
      return NOTHING;
    };
    const stop = startTicker(db, { intervalMs: 10, run: count });
    await until(async () => runs >= 2);
    await stop();
    const n = runs;
    const beat = (await clock()).last_tick_at;
    await sleep(80);
    expect(runs).toBe(n);
    expect((await clock()).last_tick_at).toBe(beat);
  });

  it('runDue: null while the lock is busy, nothing to do without a world', async () => {
    expect(await runDue(db)).toEqual(NOTHING);   // no world_clock row
    await world({ nowAt: israel(MON, '12:00') });
    const release = await holdRunnerLock();
    try {
      expect(await runDue(db)).toBeNull();
    } finally {
      await release();
    }
    expect(await runDue(db)).toEqual(NOTHING);   // 12:00, stopped: nothing due
  });
});
