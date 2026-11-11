// GET /admin/overview and GET /admin/players against a real Postgres (TEST_DATABASE_URL).
// The rows inserted below are TEST fixtures, not game data.
//
// The seeded world is the dashboard test's: Wednesday 2026-11-11, 12:40 Israel time (10:40 UTC).
// TASE is open and hasn't closed yet, so the latest KNOWN closes are Tuesday's.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';
import { addDays, ISRAEL, zonedParts, zonedToInstant } from '../src/game/time.js';

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
  await call('POST', '/me', 'root', { name: 'Root' });
  await db.query(`UPDATE users SET roles = '{admin,user}' WHERE uid = 'root'`);
});

afterAll(async () => {
  await db.end();
});

async function call(method: string, path: string, uid: string, claims: Record<string, unknown> = {}) {
  const token = await signToken(privateKey, uid, { claims });
  return app.request(path, { method, headers: { Authorization: `Bearer ${token}` } });
}

describe('admin access', () => {
  it('returns 401 without a token', async () => {
    expect((await app.request('/admin/overview')).status).toBe(401);
    expect((await app.request('/admin/players')).status).toBe(401);
  });

  it('returns 403 to a normal player', async () => {
    await call('POST', '/me', 'mallory');
    expect((await call('GET', '/admin/overview', 'mallory')).status).toBe(403);
    expect((await call('GET', '/admin/players', 'mallory')).status).toBe(403);
  });

  it('returns 403 before the user row exists', async () => {
    expect((await call('GET', '/admin/overview', 'ghost')).status).toBe(403);
  });

  it('stops working as soon as the role is removed with SQL', async () => {
    expect((await call('GET', '/admin/overview', 'root')).status).toBe(200);
    await db.query(`UPDATE users SET roles = '{user}' WHERE uid = 'root'`);
    expect((await call('GET', '/admin/overview', 'root')).status).toBe(403);
  });

  it('ignores an admin claim in the token', async () => {
    await call('POST', '/me', 'mallory');
    const res = await call('GET', '/admin/overview', 'mallory', { roles: ['admin'], admin: true });
    expect(res.status).toBe(403);
  });
});

describe('GET /admin/overview, empty world', () => {
  it('counts the players and shows no clock', async () => {
    const res = await call('GET', '/admin/overview', 'root');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clock: null,
      players: { total: 1, joinedToday: 1, withHoldings: 0 },
      presence: {
        onlineNow: 0,
        seenToday: 0,
        visitsToday: 0,
        returningToday: 0,
        visitBuckets: { two: 0, threeToFive: 0, sixPlus: 0 },
        avgVisits: null,
      },
      orders: { pending: { tase: 0, us: 0 }, rejectedThisWeek: 0, rejectReasons: [] },
      world: { securities: 0, pricesUntil: { tase: null, us: null }, usdIlsUntil: null },
      lastRun: null,
      eventsBehind: 0,
      recentActions: [],
    });
  });
});

describe('the engine runs and the action log', () => {
  beforeEach(async () => {
    // World time: Wednesday 2026-11-11 12:40 Israel (10:40 UTC), clock stopped.
    await db.query(`INSERT INTO world_clock (now_at) VALUES ('2026-11-11T10:40:00Z')`);
  });

  it('shows the latest event the engine started, with its counts', async () => {
    await db.query(`INSERT INTO market_events
      (market, kind, day, at, status, started_at, finished_at, orders_executed, orders_rejected, players_updated, duration_ms, ledger_balanced)
      VALUES
      ('TASE', 'open',  '2026-11-10', '2026-11-10T08:00:00Z', 'done', now(), now(), 3, 0, 10, 120, TRUE),
      ('TASE', 'close', '2026-11-10', '2026-11-10T15:30:00Z', 'done', now(), now(), 14, 2, 40, 850, TRUE)`);
    const { lastRun, eventsBehind } = await (await call('GET', '/admin/overview', 'root')).json();
    expect(lastRun).toMatchObject({
      market: 'TASE',
      kind: 'close',
      at: { date: '2026-11-10', time: '17:30' },
      status: 'done',
      ordersExecuted: 14,
      ordersRejected: 2,
      playersUpdated: 40,
      durationMs: 850,
      ledgerBalanced: true,
    });
    expect(typeof lastRun.finishedAt).toBe('string');
    expect(eventsBehind).toBe(0);
  });

  it('counts due events that are not done, and ignores the ones not due yet', async () => {
    await db.query(`INSERT INTO market_events (market, kind, day, at, status) VALUES
      ('TASE', 'open',  '2026-11-11', '2026-11-11T08:00:00Z', 'pending'),
      ('US',   'open',  '2026-11-11', '2026-11-11T14:30:00Z', 'pending')`);
    const { lastRun, eventsBehind } = await (await call('GET', '/admin/overview', 'root')).json();
    expect(lastRun).toBeNull();   // nothing was started
    expect(eventsBehind).toBe(1); // 10:00 is past at 12:40; 16:30 isn't
  });

  it('shows a ledger that did not balance', async () => {
    await db.query(`INSERT INTO market_events (market, kind, day, at, status, started_at, ledger_balanced)
      VALUES ('TASE', 'open', '2026-11-11', '2026-11-11T08:00:00Z', 'orders_done', now(), FALSE)`);
    const { lastRun, eventsBehind } = await (await call('GET', '/admin/overview', 'root')).json();
    expect(lastRun).toMatchObject({ status: 'orders_done', ledgerBalanced: false, durationMs: null, finishedAt: null });
    expect(eventsBehind).toBe(1);
  });

  it('lists the newest admin actions first, up to 5', async () => {
    await db.query(`INSERT INTO admin_actions (uid, action, world_from, world_to, detail, at) VALUES
      ('root', 'clock_stop',     NULL, NULL, '{}', now() - interval '7 minutes'),
      ('root', 'clock_to_open',  '2026-11-10T20:00:00Z', '2026-11-11T08:00:00Z', '{"events": 2, "ordersExecuted": 5}', now() - interval '6 minutes'),
      ('root', 'clock_to_close', '2026-11-11T08:00:00Z', '2026-11-11T15:30:00Z', '{"events": 1}', now() - interval '5 minutes'),
      ('root', 'clock_start',    NULL, NULL, '{}', now() - interval '4 minutes'),
      ('root', 'clock_stop',     NULL, NULL, '{}', now() - interval '3 minutes'),
      ('root', 'clock_to_open',  '2026-11-11T15:30:00Z', '2026-11-12T08:00:00Z', '{"events": 3}', now() - interval '1 minute')`);
    const { recentActions } = await (await call('GET', '/admin/overview', 'root')).json();
    expect(recentActions).toHaveLength(5);
    expect(recentActions[0]).toMatchObject({
      admin: 'Root',
      action: 'clock_to_open',
      worldFrom: '2026-11-11T15:30:00.000Z',
      worldTo: '2026-11-12T08:00:00.000Z',
      detail: { events: 3 },
    });
    expect(recentActions.map((a: { action: string }) => a.action)).toEqual([
      'clock_to_open', 'clock_stop', 'clock_start', 'clock_to_close', 'clock_to_open',
    ]);
  });

  it('refuses an action name the log does not know', async () => {
    await expect(db.query(`INSERT INTO admin_actions (uid, action) VALUES ('root', 'give_cash')`)).rejects.toThrow();
  });
});

describe('GET /admin/activity', () => {
  // Real Israel dates, relative to today. Each event is placed at noon so no time zone shift moves its day.
  const today = zonedParts(new Date(), ISRAEL).date;
  const noon = (daysAgo: number) => zonedToInstant(addDays(today, -daysAgo), 12 * 60, ISRAEL).toISOString();

  beforeEach(async () => {
    // alice: signed up 3 days ago, back the next day (day 1).
    // bob:   signed up 10 days ago, back exactly 7 days later (day 7), not on day 1.
    // carol: signed up 9 days ago, never back.
    // root:  signed up today, too new to measure.
    for (const [uid, daysAgo] of [['alice', 3], ['bob', 10], ['carol', 9]] as const) {
      await call('POST', '/me', uid);
      await db.query(`UPDATE users SET created_at = $2 WHERE uid = $1`, [uid, noon(daysAgo)]);
    }
    await db.query(
      `INSERT INTO app_opens (uid, at) VALUES ('alice', $1), ('alice', $2), ('bob', $3), ('bob', $4), ('carol', $5)`,
      [noon(3), noon(2), noon(10), noon(3), noon(9)],
    );
  });

  it('measures next-day and 7-day return over players old enough to measure', async () => {
    const { retention } = await (await call('GET', '/admin/activity', 'root')).json();
    expect(retention).toEqual({
      d1: { cohort: 3, returned: 1, pct: 33.3 },   // alice, bob, carol; alice came back
      d7: { cohort: 2, returned: 1, pct: 50 },     // bob, carol; bob came back
    });
  });

  it('gives one row per day, oldest first, ending today', async () => {
    const { days } = await (await call('GET', '/admin/activity', 'root')).json();
    expect(days).toHaveLength(30);
    expect(days[29].date).toBe(today);
    const at = (daysAgo: number) => days.find((d: { date: string }) => d.date === addDays(today, -daysAgo));
    expect(at(3)).toEqual({ date: addDays(today, -3), activePlayers: 2, visits: 2, signups: 1 });   // alice + bob
    expect(at(10)).toEqual({ date: addDays(today, -10), activePlayers: 1, visits: 1, signups: 1 });
    expect(at(0)).toMatchObject({ signups: 1 });   // root
  });

  it('shows the requested number of days', async () => {
    const { days } = await (await call('GET', '/admin/activity?days=7', 'root')).json();
    expect(days).toHaveLength(7);
  });

  it('refuses a bad number of days', async () => {
    for (const bad of ['6', '91', 'abc', '7.5']) {
      expect((await call('GET', `/admin/activity?days=${bad}`, 'root')).status).toBe(400);
    }
  });

  it('is admins only', async () => {
    await call('POST', '/me', 'mallory');
    expect((await call('GET', '/admin/activity', 'mallory')).status).toBe(403);
  });
});

describe('admin, seeded world', () => {
  beforeEach(async () => {
    await call('POST', '/me', 'alice', { name: 'Alice' });
    await call('POST', '/me', 'bob');   // email sign-up: no name
    await db.query(`UPDATE users SET created_at = now() - interval '3 days' WHERE uid = 'bob'`);

    await db.query(`INSERT INTO world_clock (now_at, running, ends_at) VALUES ('2026-11-11T10:40:00Z', TRUE, '2026-11-20T07:59:00Z')`);
    // Freeze the running clock at its start: real_at = now() makes the elapsed real time ~0.
    await db.query(`UPDATE world_clock SET real_at = now()`);
    await db.query(`INSERT INTO securities VALUES
      ('TEVA', 'טבע', 'TASE', 'TASE', 'ILS'),
      ('NVDA', 'אנבידיה', 'US', 'NASDAQ', 'USD')`);
    // Wednesday's 999 closes are in the future at 12:40 and must not be used for values.
    await db.query(`INSERT INTO prices VALUES
      ('TEVA', '2026-11-09', 39, 40), ('TEVA', '2026-11-10', 41, 50), ('TEVA', '2026-11-11', 51, 999),
      ('NVDA', '2026-11-09', 99, 100), ('NVDA', '2026-11-10', 101, 110), ('NVDA', '2026-11-12', 111, 999)`);
    await db.query(`INSERT INTO usd_ils VALUES
      ('2026-11-09', 3.76, 3.75), ('2026-11-10', 3.74, 3.70), ('2026-11-11', 9, 9.99)`);

    // Alice: 760,000 cash + 4,000 TEVA (200,000) + 100 NVDA ($11,000 = ₪40,700) = 1,000,700.
    // The runner stores holdings_value after each event; equity = cash + holdings_value (D-019, D-024).
    await db.query(`UPDATE portfolios SET cash = 760000, holdings_value = 240700 WHERE uid = 'alice'`);
    await db.query(`INSERT INTO holdings VALUES ('alice', 'TEVA', 4000), ('alice', 'NVDA', 100)`);

    // A rejected or executed order points at the market event that ran it (the runner's orders_event_check),
    // and that event exists only once the runner started it.
    await db.query(`INSERT INTO market_events (market, kind, day, at, status, started_at, finished_at) VALUES
      ('TASE', 'close', '2026-11-10', '2026-11-10T15:30:00Z', 'done', now(), now()),
      ('US',   'open',  '2026-11-10', '2026-11-10T14:30:00Z', 'done', now(), now()),
      ('TASE', 'close', '2026-11-05', '2026-11-05T15:30:00Z', 'done', now(), now())`);
    await db.query(`INSERT INTO orders (uid, symbol, side, amount_ils, units, status, placed_at, executes_at, price_type, reject_reason, event_id)
      SELECT o.uid, o.symbol, o.side, o.amount_ils, o.units, o.status, o.placed_at, o.executes_at, o.price_type, o.reject_reason, e.id
      FROM (VALUES
        ('alice', 'NVDA', 'buy',  40000, NULL::numeric, 'pending',  '2026-11-11T10:00:00Z'::timestamptz, '2026-11-11T14:30:00Z'::timestamptz, 'open',  NULL),
        ('alice', 'TEVA', 'sell', NULL,  600,  'pending',  '2026-11-11T10:10:00Z', '2026-11-11T15:30:00Z', 'close', NULL),
        ('bob',   'TEVA', 'buy',  5000,  NULL, 'pending',  '2026-11-11T09:00:00Z', '2026-11-11T15:30:00Z', 'close', NULL),
        ('bob',   'TEVA', 'buy',  9000,  NULL, 'rejected', '2026-11-10T09:00:00Z', '2026-11-10T15:30:00Z', 'close', 'אין מספיק מזומן'),
        ('bob',   'NVDA', 'buy',  9000,  NULL, 'rejected', '2026-11-10T09:00:00Z', '2026-11-10T14:30:00Z', 'open',  'אין מספיק מזומן'),
        ('bob',   'NVDA', 'buy',  9000,  NULL, 'rejected', '2026-11-10T09:00:00Z', '2026-11-10T14:30:00Z', 'open',  'מעל 20%'),
        ('bob',   'TEVA', 'buy',  9000,  NULL, 'rejected', '2026-11-05T09:00:00Z', '2026-11-05T15:30:00Z', 'close', 'last week')
      ) AS o (uid, symbol, side, amount_ils, units, status, placed_at, executes_at, price_type, reject_reason)
      LEFT JOIN market_events e ON o.status <> 'pending' AND e.at = o.executes_at`);

    await db.query(`INSERT INTO standings VALUES
      ('2026-11-09', 'alice', 0.5, 0.2, 50, 50, 50, 2), ('2026-11-09', 'bob', 0.6, 0.1, 100, 100, 100, 1),
      ('2026-11-10', 'alice', 2.0, 0.0, 100, 100, 90, 1), ('2026-11-10', 'bob', 0.0, 0.0, 50, 50, 40, 2)`);
  });

  it('shows the clock with its running flag and end', async () => {
    const { clock } = await (await call('GET', '/admin/overview', 'root')).json();
    expect(clock).toMatchObject({ date: '2026-11-11', weekday: 3, week: 46, running: true, lastTickAt: null });
    expect(clock.endsAt).toMatchObject({ at: '2026-11-20T07:59:00.000Z', date: '2026-11-20' });
    expect(clock.time).toMatch(/^12:4\d$/);   // running: a second or two may pass during the test
    expect(clock.markets.tase.isOpen).toBe(true);
  });

  it('shows the ticker last beat (D-030)', async () => {
    await db.query(`UPDATE world_clock SET last_tick_at = '2026-11-10T12:34:00Z'`);
    const { clock } = await (await call('GET', '/admin/overview', 'root')).json();
    expect(clock.lastTickAt).toBe('2026-11-10T12:34:00.000Z');
  });

  it('counts players, sign-ups today and players who own something', async () => {
    const { players } = await (await call('GET', '/admin/overview', 'root')).json();
    expect(players).toEqual({ total: 3, joinedToday: 2, withHoldings: 1 });
  });

  describe('presence (D-026)', () => {
    // Midnight of today's real date in Israel, as Postgres sees it. Visits are placed there so they count as today.
    const TODAY = `(date_trunc('day', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem')`;

    beforeEach(async () => {
      // alice: online now, 3 visits today. bob: seen today but 10 minutes ago, 2 visits today, 1 yesterday.
      // root: last seen yesterday, so not today and not online.
      await db.query(`UPDATE users SET last_seen_at = now() WHERE uid = 'alice'`);
      await db.query(`UPDATE users SET last_seen_at = GREATEST(now() - interval '10 minutes', ${TODAY}) WHERE uid = 'bob'`);
      await db.query(`UPDATE users SET last_seen_at = ${TODAY} - interval '1 hour' WHERE uid = 'root'`);
      await db.query(`INSERT INTO app_opens (uid, at) VALUES
        ('alice', ${TODAY}), ('alice', ${TODAY}), ('alice', ${TODAY}),
        ('bob', ${TODAY}), ('bob', ${TODAY}), ('bob', ${TODAY} - interval '1 hour'),
        ('root', ${TODAY} - interval '1 hour')`);
    });

    it('counts who is online, who came today, and how often they came back', async () => {
      const { presence } = await (await call('GET', '/admin/overview', 'root')).json();
      expect(presence).toEqual({
        onlineNow: 1,
        seenToday: 2,
        visitsToday: 5,
        returningToday: 2,
        visitBuckets: { two: 1, threeToFive: 1, sixPlus: 0 },
        avgVisits: 2.5,
      });
    });

    it('shows each player their last check-in and visits today', async () => {
      const { players } = await (await call('GET', '/admin/players', 'root')).json();
      const byUid = Object.fromEntries(players.map((p: { uid: string }) => [p.uid, p]));
      expect(byUid.alice.visitsToday).toBe(3);
      expect(byUid.bob.visitsToday).toBe(2);
      expect(byUid.root.visitsToday).toBe(0);
      expect(typeof byUid.alice.lastSeenAt).toBe('string');
    });

    it('shows never-seen players with no last check-in', async () => {
      await db.query(`UPDATE users SET last_seen_at = NULL WHERE uid = 'bob'`);
      const { players } = await (await call('GET', '/admin/players', 'root')).json();
      expect(players.find((p: { uid: string }) => p.uid === 'bob').lastSeenAt).toBeNull();
    });
  });

  it('counts pending orders per market and this week rejections by reason', async () => {
    const { orders } = await (await call('GET', '/admin/overview', 'root')).json();
    expect(orders).toEqual({
      pending: { tase: 2, us: 1 },
      rejectedThisWeek: 3,   // last week's rejection is not counted
      rejectReasons: [
        { reason: 'אין מספיק מזומן', count: 2 },
        { reason: 'מעל 20%', count: 1 },
      ],
    });
  });

  it('shows how far the price data goes', async () => {
    const { world } = await (await call('GET', '/admin/overview', 'root')).json();
    expect(world).toEqual({ securities: 2, pricesUntil: { tase: '2026-11-11', us: '2026-11-12' }, usdIlsUntil: '2026-11-11' });
  });

  it('lists players by this week rank with their value and pending orders', async () => {
    const res = await call('GET', '/admin/players', 'root');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(5);
    expect(body.players.map((p: { uid: string }) => p.uid)).toEqual(['alice', 'bob', 'root']);
    expect(body.players[0]).toMatchObject({
      uid: 'alice',
      name: 'Alice',
      email: 'alice@example.com',
      isAdmin: false,
      totalValue: 1_000_700,
      rank: 1,
      pendingOrders: 2,
    });
    expect(body.players[1]).toMatchObject({ uid: 'bob', name: null, rank: 2, pendingOrders: 1, totalValue: 1_000_000 });
    expect(body.players[2]).toMatchObject({ uid: 'root', isAdmin: true, rank: null, pendingOrders: 0 });
  });

  it('searches by name or email, case-insensitive', async () => {
    const byName = await (await call('GET', '/admin/players?q=ali', 'root')).json();
    expect(byName.players.map((p: { uid: string }) => p.uid)).toEqual(['alice']);
    const byEmail = await (await call('GET', '/admin/players?q=BOB@EXAMPLE', 'root')).json();
    expect(byEmail.players.map((p: { uid: string }) => p.uid)).toEqual(['bob']);
  });

  it('treats % and _ in the search as plain characters', async () => {
    const res = await (await call('GET', '/admin/players?q=%25', 'root')).json();
    expect(res.players).toEqual([]);
  });

  it('refuses a search longer than 100 characters', async () => {
    const res = await call('GET', `/admin/players?q=${'a'.repeat(101)}`, 'root');
    expect(res.status).toBe(400);
  });
});
