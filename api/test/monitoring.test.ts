// Usage monitoring (D-036) against a real Postgres (TEST_DATABASE_URL): POST /me/seen with a usage report,
// GET /admin/monitoring and GET /admin/db. The rows inserted below are TEST fixtures, not game data.
//
// Usage is real time and real Israel dates, so the fixtures are placed relative to Postgres's own "today"
// (the same expression the API uses), never to a fixed date.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { MAX_REPORT_COUNT, MAX_REPORT_MS, recordUsage } from '../src/usage.js';
import { addDays, mondayOf, weekdayOf } from '../src/game/time.js';
import type { AdminDbHealth, AdminMonitoring, UsagePage } from '../src/contract.js';
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
  await db.query(
    'TRUNCATE users, usage_pages_daily, usage_confirms_daily, securities, usd_ils, world_clock, market_events CASCADE',
  );
  await call('POST', '/me', 'root');
  await db.query(`UPDATE users SET roles = '{admin,user}' WHERE uid = 'root'`);
});

afterAll(async () => {
  await db.end();
});

// body: undefined = no body at all; a string is sent as it is; anything else as JSON.
async function call(method: string, path: string, uid: string, body?: unknown) {
  const token = await signToken(privateKey, uid);
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const seen = (uid: string, body?: unknown) => call('POST', '/me/seen', uid, body);

async function monitoring(): Promise<AdminMonitoring> {
  const res = await call('GET', '/admin/monitoring', 'root');
  expect(res.status).toBe(200);
  return res.json();
}

// Postgres's real Israel date: the one the API writes and reads with.
async function pgToday(): Promise<string> {
  const { rows } = await db.query<{ today: string }>(`SELECT (now() AT TIME ZONE 'Asia/Jerusalem')::date::text AS today`);
  return rows[0].today;
}

async function pageRows(uid: string) {
  const { rows } = await db.query<{ day: string; page: string; views: number; ms: string }>(
    'SELECT day::text AS day, page, views, ms::text AS ms FROM usage_pages_daily WHERE uid = $1 ORDER BY day, page',
    [uid],
  );
  return rows.map((r) => ({ ...r, ms: Number(r.ms) }));
}

async function confirmRows(uid: string) {
  const { rows } = await db.query<{ day: string; opened: number; backed: number }>(
    'SELECT day::text AS day, opened, backed FROM usage_confirms_daily WHERE uid = $1 ORDER BY day',
    [uid],
  );
  return rows;
}

async function visits(uid: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app_opens WHERE uid = $1', [uid]);
  return rows[0].n;
}

async function lastSeen(uid: string): Promise<Date | null> {
  const { rows } = await db.query<{ last_seen_at: Date | null }>('SELECT last_seen_at FROM users WHERE uid = $1', [uid]);
  return rows[0].last_seen_at;
}

// ---------- POST /me/seen with a usage report ----------

describe('POST /me/seen with a usage report', () => {
  it('writes the report to today\'s rows, and adds the next ones to them', async () => {
    await call('POST', '/me', 'alice');
    const today = await pgToday();
    const first = await seen('alice', {
      pages: { trade: { views: 2, ms: 30_000 }, dashboard: { views: 1, ms: 5_000 } },
      confirms: { opened: 2, backed: 1 },
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    // The second check-in is seconds after the first, so presence writes nothing (D-026); usage still adds up.
    expect((await seen('alice', { pages: { trade: { views: 1, ms: 10_000 } }, confirms: { opened: 1, backed: 0 } })).status).toBe(200);
    expect((await seen('alice', { pages: { journal: { views: 1, ms: 2_500 } } })).status).toBe(200);

    expect(await pageRows('alice')).toEqual([
      { day: today, page: 'dashboard', views: 1, ms: 5_000 },
      { day: today, page: 'journal', views: 1, ms: 2_500 },
      { day: today, page: 'trade', views: 3, ms: 40_000 },
    ]);
    expect(await confirmRows('alice')).toEqual([{ day: today, opened: 3, backed: 1 }]);
    expect(await visits('alice')).toBe(1);
  });

  it('a new day gets its own row; earlier days are never touched', async () => {
    await call('POST', '/me', 'alice');
    const today = await pgToday();
    const yesterday = addDays(today, -1);
    await db.query(`INSERT INTO usage_pages_daily (day, page, uid, views, ms) VALUES ($1, 'trade', 'alice', 4, 9000)`, [yesterday]);
    await db.query(`INSERT INTO usage_confirms_daily (day, uid, opened, backed) VALUES ($1, 'alice', 2, 2)`, [yesterday]);
    await seen('alice', { pages: { trade: { views: 1, ms: 1_000 } }, confirms: { opened: 1, backed: 0 } });
    expect(await pageRows('alice')).toEqual([
      { day: yesterday, page: 'trade', views: 4, ms: 9_000 },
      { day: today, page: 'trade', views: 1, ms: 1_000 },
    ]);
    expect(await confirmRows('alice')).toEqual([
      { day: yesterday, opened: 2, backed: 2 },
      { day: today, opened: 1, backed: 0 },
    ]);
  });

  it('check-ins at the same moment all add up', async () => {
    await call('POST', '/me', 'alice');
    const body = { pages: { trade: { views: 1, ms: 1_000 }, dashboard: { views: 2, ms: 500 } }, confirms: { opened: 1, backed: 1 } };
    const results = await Promise.all(Array.from({ length: 8 }, () => seen('alice', body)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const rows = await pageRows('alice');
    expect(rows.map((r) => [r.page, r.views, r.ms])).toEqual([['dashboard', 16, 4_000], ['trade', 8, 8_000]]);
    expect((await confirmRows('alice')).map((r) => [r.opened, r.backed])).toEqual([[8, 8]]);
    expect(await visits('alice')).toBe(1);
  });

  it('caps what one request can add', async () => {
    await call('POST', '/me', 'alice');
    await seen('alice', { pages: { trade: { views: 999, ms: 3_600_000 } }, confirms: { opened: 500, backed: 70 } });
    const [row] = await pageRows('alice');
    expect([row.views, row.ms]).toEqual([MAX_REPORT_COUNT, MAX_REPORT_MS]);
    expect((await confirmRows('alice')).map((r) => [r.opened, r.backed])).toEqual([[MAX_REPORT_COUNT, MAX_REPORT_COUNT]]);
  });

  it('pages it does not track are dropped, and the check-in still counts', async () => {
    await call('POST', '/me', 'alice');
    const res = await seen('alice', { pages: { 'admin-dashboard': { views: 5, ms: 30_000 }, login: { views: 1, ms: 1_000 } } });
    expect(res.status).toBe(200);
    expect(await pageRows('alice')).toEqual([]);
    expect(await visits('alice')).toBe(1);
  });

  it('a plain check-in with no body still works and writes no usage', async () => {
    await call('POST', '/me', 'alice');
    expect((await seen('alice')).status).toBe(200);
    expect((await seen('alice', {})).status).toBe(200);
    expect((await seen('alice', '')).status).toBe(200);
    expect(await visits('alice')).toBe(1);
    expect(await lastSeen('alice')).not.toBeNull();
    expect(await pageRows('alice')).toEqual([]);
    expect(await confirmRows('alice')).toEqual([]);
  });

  it('a bad body is a 400 that writes nothing, not even the check-in', async () => {
    await call('POST', '/me', 'alice');
    for (const body of [
      'not json',
      '{"pages":',
      [],
      { pages: [] },
      { pages: { trade: { views: '3', ms: 1000 } } },
      { pages: { dashboard: { views: 1, ms: 10 }, trade: { views: 1 } } },
      { confirms: { opened: 1 } },
      '{"pages":{"trade":{"views":1,"ms":1e999}}}',
    ]) {
      const res = await seen('alice', body);
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
    }
    expect(await lastSeen('alice')).toBeNull();
    expect(await visits('alice')).toBe(0);
    expect(await pageRows('alice')).toEqual([]);
    expect(await confirmRows('alice')).toEqual([]);
  });

  it('returns 404 before POST /me, and writes nothing', async () => {
    const res = await seen('ghost', { pages: { trade: { views: 1, ms: 1_000 } } });
    expect(res.status).toBe(404);
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM usage_pages_daily`);
    expect(rows[0].n).toBe(0);
  });

  it('writes a report whole or not at all, so a failed check-in can be sent again', async () => {
    await call('POST', '/me', 'alice');
    // The popup part breaks a CHECK (a parsed report never could), after the pages part has a row to write.
    // Written in two statements, the pages would stay and a resend would count them twice.
    await expect(
      recordUsage(db, 'alice', { pages: { trade: { views: 1, ms: 1_000 } }, confirms: { opened: -1, backed: 1 } }),
    ).rejects.toThrow(/check constraint/);
    expect(await pageRows('alice')).toEqual([]);
    expect(await confirmRows('alice')).toEqual([]);

    // Each part alone still writes, and a report with neither writes nothing.
    await recordUsage(db, 'alice', { pages: { trade: { views: 1, ms: 1_000 } } });
    await recordUsage(db, 'alice', { confirms: { opened: 1, backed: 0 } });
    await recordUsage(db, 'alice', {});
    expect((await pageRows('alice')).map((r) => [r.page, r.views, r.ms])).toEqual([['trade', 1, 1_000]]);
    expect((await confirmRows('alice')).map((r) => [r.opened, r.backed])).toEqual([[1, 0]]);
  });

  it('only touches the caller', async () => {
    await call('POST', '/me', 'alice');
    await call('POST', '/me', 'bob');
    await seen('alice', { pages: { trade: { views: 1, ms: 1_000 } }, confirms: { opened: 1, backed: 0 } });
    expect(await pageRows('bob')).toEqual([]);
    expect(await confirmRows('bob')).toEqual([]);
  });
});

// ---------- access ----------

describe('monitoring access', () => {
  it('returns 401 without a token', async () => {
    expect((await app.request('/admin/monitoring')).status).toBe(401);
    expect((await app.request('/admin/db')).status).toBe(401);
  });

  it('returns 403 to a normal player', async () => {
    await call('POST', '/me', 'mallory');
    expect((await call('GET', '/admin/monitoring', 'mallory')).status).toBe(403);
    expect((await call('GET', '/admin/db', 'mallory')).status).toBe(403);
  });

  it('returns 403 before the user row exists', async () => {
    expect((await call('GET', '/admin/monitoring', 'ghost')).status).toBe(403);
    expect((await call('GET', '/admin/db', 'ghost')).status).toBe(403);
  });
});

// ---------- GET /admin/monitoring ----------

const zeros = { dashboard: 0, trade: 0, journal: 0, leaderboard: 0 };
const emptyTotals = {
  orders: { sent: 0, executed: 0, rejected: 0, pending: 0 },
  confirms: { opened: 0, backed: 0 },
  pages: [],
  ms: 0,
  players: 0,
};

describe('GET /admin/monitoring, nothing measured yet', () => {
  it('says so: no since, zeros everywhere, and the full 30 days and 12 weeks', async () => {
    const today = await pgToday();
    const m = await monitoring();
    expect(m.today).toBe(today);
    expect(m.since).toBeNull();
    expect(m.totals).toEqual({ today: emptyTotals, d7: emptyTotals, d30: emptyTotals });

    expect(m.daily).toHaveLength(30);
    expect(m.daily.map((b) => b.start)).toEqual(Array.from({ length: 30 }, (_, i) => addDays(today, i - 29)));
    for (const b of m.daily) expect(b).toEqual({ start: b.start, players: 0, ms: zeros });

    expect(m.weekly).toHaveLength(12);
    expect(m.weekly.map((b) => b.start)).toEqual(Array.from({ length: 12 }, (_, i) => addDays(mondayOf(today), 7 * (i - 11))));
    expect(m.weekly.every((b) => weekdayOf(b.start) === 1)).toBe(true);
    for (const b of m.weekly) expect(b).toEqual({ start: b.start, players: 0, ms: zeros });
  });
});

describe('GET /admin/monitoring, from seeded rows', () => {
  let today: string;
  type Row = { ago: number; page: UsagePage; uid: string; views: number; ms: number };
  // Days back from today. 0..6 is the 7-day range, 0..29 the 30-day one.
  const rows: Row[] = [
    { ago: 0, page: 'trade', uid: 'alice', views: 3, ms: 60_000 },
    { ago: 0, page: 'dashboard', uid: 'alice', views: 2, ms: 30_000 },
    { ago: 0, page: 'trade', uid: 'bob', views: 1, ms: 15_000 },
    { ago: 3, page: 'journal', uid: 'carol', views: 4, ms: 20_000 },
    { ago: 3, page: 'trade', uid: 'alice', views: 1, ms: 5_000 },
    { ago: 6, page: 'leaderboard', uid: 'bob', views: 1, ms: 1_000 },     // the 7-day range's first day
    { ago: 7, page: 'trade', uid: 'carol', views: 2, ms: 7_000 },         // just outside 7 days
    { ago: 29, page: 'dashboard', uid: 'bob', views: 5, ms: 50_000 },     // the 30-day range's first day
    { ago: 30, page: 'dashboard', uid: 'alice', views: 9, ms: 90_000 },   // just outside 30 days, inside 12 weeks
    { ago: 200, page: 'trade', uid: 'alice', views: 1, ms: 1_000 },       // outside everything: only `since`
  ];

  beforeEach(async () => {
    today = await pgToday();
    for (const uid of ['alice', 'bob', 'carol']) await call('POST', '/me', uid);
    for (const r of rows) {
      await db.query('INSERT INTO usage_pages_daily (day, page, uid, views, ms) VALUES ($1, $2, $3, $4, $5)', [
        addDays(today, -r.ago), r.page, r.uid, r.views, r.ms,
      ]);
    }
    // A page that is no longer tracked: its old rows must stay out of every number.
    await db.query(`INSERT INTO usage_pages_daily (day, page, uid, views, ms) VALUES ($1, 'history', 'carol', 7, 70000)`, [today]);
  });

  it('since = the first day with any usage', async () => {
    expect((await monitoring()).since).toBe(addDays(today, -200));
  });

  it('since also sees a confirm row older than every page row', async () => {
    await db.query(`INSERT INTO usage_confirms_daily (day, uid, opened, backed) VALUES ($1, 'bob', 1, 0)`, [addDays(today, -365)]);
    expect((await monitoring()).since).toBe(addDays(today, -365));
  });

  it('totals each range: pages by time, distinct players, and all time in the app', async () => {
    const { totals } = await monitoring();
    expect(totals.today.pages).toEqual([
      { page: 'trade', views: 4, ms: 75_000, players: 2 },
      { page: 'dashboard', views: 2, ms: 30_000, players: 1 },
    ]);
    expect([totals.today.ms, totals.today.players]).toEqual([105_000, 2]);

    expect(totals.d7.pages).toEqual([
      { page: 'trade', views: 5, ms: 80_000, players: 2 },
      { page: 'dashboard', views: 2, ms: 30_000, players: 1 },
      { page: 'journal', views: 4, ms: 20_000, players: 1 },
      { page: 'leaderboard', views: 1, ms: 1_000, players: 1 },
    ]);
    expect([totals.d7.ms, totals.d7.players]).toEqual([131_000, 3]);

    expect(totals.d30.pages).toEqual([
      { page: 'trade', views: 7, ms: 87_000, players: 3 },
      { page: 'dashboard', views: 7, ms: 80_000, players: 2 },
      { page: 'journal', views: 4, ms: 20_000, players: 1 },
      { page: 'leaderboard', views: 1, ms: 1_000, players: 1 },
    ]);
    expect([totals.d30.ms, totals.d30.players]).toEqual([188_000, 3]);
  });

  it('the 30 daily bars: each seeded day in its place, every other day zero', async () => {
    const { daily, totals } = await monitoring();
    expect(daily).toHaveLength(30);
    const at = (ago: number) => daily[29 - ago];
    expect(at(0)).toEqual({ start: today, players: 2, ms: { ...zeros, trade: 75_000, dashboard: 30_000 } });
    expect(at(3)).toEqual({ start: addDays(today, -3), players: 2, ms: { ...zeros, journal: 20_000, trade: 5_000 } });
    expect(at(6)).toEqual({ start: addDays(today, -6), players: 1, ms: { ...zeros, leaderboard: 1_000 } });
    expect(at(7)).toEqual({ start: addDays(today, -7), players: 1, ms: { ...zeros, trade: 7_000 } });
    expect(at(29)).toEqual({ start: addDays(today, -29), players: 1, ms: { ...zeros, dashboard: 50_000 } });
    const seeded = new Set([0, 3, 6, 7, 29]);
    for (let ago = 0; ago < 30; ago++) {
      if (!seeded.has(ago)) expect(at(ago)).toEqual({ start: addDays(today, -ago), players: 0, ms: zeros });
    }
    const sum = daily.reduce((s, b) => s + Object.values(b.ms).reduce((a, x) => a + x, 0), 0);
    expect(sum).toBe(totals.d30.ms);
  });

  it('the 12 weekly bars start on Mondays, and each holds its week\'s days', async () => {
    const { weekly } = await monitoring();
    const firstMonday = addDays(mondayOf(today), -77);
    expect(weekly.map((b) => b.start)).toEqual(Array.from({ length: 12 }, (_, i) => addDays(firstMonday, 7 * i)));

    // The expected bars, worked out the plain way: each row to the Monday of its day.
    const expected = new Map(weekly.map((b) => [b.start, { ms: { ...zeros }, players: new Set<string>() }]));
    for (const r of rows) {
      const week = expected.get(mondayOf(addDays(today, -r.ago)));
      if (!week) continue;   // older than 12 weeks
      week.ms[r.page] += r.ms;
      week.players.add(r.uid);
    }
    expect(weekly).toEqual([...expected].map(([start, w]) => ({ start, players: w.players.size, ms: w.ms })));
    // Everything but the 200-day-old row is inside the 12 weeks (30 days ago always is).
    expect(weekly.reduce((s, b) => s + Object.values(b.ms).reduce((a, x) => a + x, 0), 0)).toBe(188_000 + 90_000);
  });

  it('the confirm popup per range', async () => {
    const confirm = (ago: number, uid: string, opened: number, backed: number) =>
      db.query('INSERT INTO usage_confirms_daily (day, uid, opened, backed) VALUES ($1, $2, $3, $4)', [
        addDays(today, -ago), uid, opened, backed,
      ]);
    await confirm(0, 'alice', 3, 1);
    await confirm(0, 'bob', 1, 1);
    await confirm(6, 'carol', 2, 0);
    await confirm(7, 'alice', 5, 4);
    await confirm(29, 'bob', 1, 1);
    await confirm(30, 'alice', 10, 10);   // outside 30 days
    const { totals } = await monitoring();
    expect(totals.today.confirms).toEqual({ opened: 4, backed: 2 });
    expect(totals.d7.confirms).toEqual({ opened: 6, backed: 2 });
    expect(totals.d30.confirms).toEqual({ opened: 12, backed: 7 });
  });
});

describe('GET /admin/monitoring, orders sent', () => {
  it('counts orders by when they were really sent, from midnight Israel time, by their status now', async () => {
    const today = await pgToday();
    await call('POST', '/me', 'alice');
    await db.query(
      `INSERT INTO securities (symbol, name_he, name_en, market, exchange, currency) VALUES ('TEVA', 'טבע', 'Teva', 'TASE', 'TASE', 'ILS')`,
    );
    const ev = await db.query<{ id: string }>(
      `INSERT INTO market_events (market, kind, day, at, status) VALUES ('TASE', 'open', '2026-11-11', '2026-11-11T08:00:00Z', 'done')
       RETURNING id::text AS id`,
    );
    const event = ev.rows[0].id;
    const pos = await db.query<{ id: string }>(
      `INSERT INTO positions (uid, symbol, units, avg_cost_ils, cost_basis_ils, opened_at)
       VALUES ('alice', 'TEVA', 100, 130, 13000.00, '2026-11-04T08:00:00Z') RETURNING id::text AS id`,
    );
    const position = pos.rows[0].id;

    // `created_at` = midnight Israel time of (today - daysBack), moved by `shift` (a Postgres interval).
    const sentAt = `($1::date - $2::int)::timestamp AT TIME ZONE 'Asia/Jerusalem' + $3::interval`;
    const pending = (daysBack: number, shift: string) =>
      db.query(
        `INSERT INTO orders (uid, symbol, side, amount_ils, placed_at, executes_at, price_type, created_at)
         VALUES ('alice', 'TEVA', 'buy', 1000, now(), now(), 'open', ${sentAt})`,
        [today, daysBack, shift],
      );
    const rejected = (daysBack: number, shift: string) =>
      db.query(
        `INSERT INTO orders (uid, symbol, side, amount_ils, status, placed_at, executes_at, price_type, event_id,
                             reject_code, reject_reason, created_at)
         VALUES ('alice', 'TEVA', 'buy', 1000, 'rejected', now(), now(), 'open', $4, 'NO_PRICE', 'אין מחיר', ${sentAt})`,
        [today, daysBack, shift, event],
      );
    const executed = (daysBack: number, shift: string) =>
      db.query(
        `INSERT INTO orders (uid, symbol, side, amount_ils, status, placed_at, executes_at, price_type, event_id,
                             fill_price, filled_units, filled_ils, position_id, executed_at, created_at)
         VALUES ('alice', 'TEVA', 'buy', 1000, 'executed', now(), now(), 'open', $4, 130, 7.69230769, 1000, $5, now(), ${sentAt})`,
        [today, daysBack, shift, event, position],
      );

    await pending(0, '0 seconds');      // today's first instant
    await executed(0, '1 hour');        // today
    await rejected(0, '-1 second');     // yesterday's last second: 7 and 30 days only
    await executed(6, '0 seconds');     // the 7-day range's first instant
    await pending(6, '-1 second');      // just before it: 30 days only
    await rejected(29, '0 seconds');    // the 30-day range's first instant
    await executed(29, '-1 second');    // just before it: in no range

    const { totals } = await monitoring();
    expect(totals.today.orders).toEqual({ sent: 2, executed: 1, rejected: 0, pending: 1 });
    expect(totals.d7.orders).toEqual({ sent: 4, executed: 2, rejected: 1, pending: 1 });
    expect(totals.d30.orders).toEqual({ sent: 6, executed: 2, rejected: 2, pending: 2 });
  });
});

describe('GET /admin/monitoring, distinct players', () => {
  it('a player counts once per bar and per range, however many days and pages they used', async () => {
    const today = await pgToday();
    const lastMonday = addDays(mondayOf(today), -7);
    for (const uid of ['alice', 'bob']) await call('POST', '/me', uid);
    // alice: every day of last week, on two pages. bob: one page on last Wednesday.
    for (let i = 0; i < 7; i++) {
      for (const page of ['dashboard', 'trade']) {
        await db.query(`INSERT INTO usage_pages_daily (day, page, uid, views, ms) VALUES ($1, $2, 'alice', 1, 1000)`, [
          addDays(lastMonday, i), page,
        ]);
      }
    }
    await db.query(`INSERT INTO usage_pages_daily (day, page, uid, views, ms) VALUES ($1, 'trade', 'bob', 1, 500)`, [
      addDays(lastMonday, 2),
    ]);

    const m = await monitoring();
    const week = m.weekly.find((b) => b.start === lastMonday)!;
    expect(week).toEqual({ start: lastMonday, players: 2, ms: { ...zeros, dashboard: 7_000, trade: 7_500 } });
    const wednesday = m.daily.find((b) => b.start === addDays(lastMonday, 2))!;
    expect(wednesday).toEqual({ start: addDays(lastMonday, 2), players: 2, ms: { ...zeros, dashboard: 1_000, trade: 1_500 } });
    const thursday = m.daily.find((b) => b.start === addDays(lastMonday, 3))!;
    expect(thursday.players).toBe(1);

    // Last week is inside the 30 days: alice on two pages is one player in the all-pages total.
    expect(m.totals.d30.players).toBe(2);
    expect(m.totals.d30.pages).toEqual([
      { page: 'trade', views: 8, ms: 7_500, players: 2 },
      { page: 'dashboard', views: 7, ms: 7_000, players: 1 },
    ]);
  });
});

describe('GET /admin/monitoring, one run at a time', () => {
  it('requests that arrive during a run share its answer instead of starting more', async () => {
    await call('POST', '/me', 'alice');
    await seen('alice', { pages: { trade: { views: 1, ms: 1_000 } } });
    // Another connection locks a usage table, so the run's first query waits until the test lets it go: every
    // request below arrives while that run is still going.
    const blocker = await db.connect();
    const spy = vi.spyOn(db, 'query');
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE usage_confirms_daily IN ACCESS EXCLUSIVE MODE');
      const pending = Promise.all(Array.from({ length: 4 }, () => call('GET', '/admin/monitoring', 'root')));
      for (let i = 0; i < 100; i++) {
        const { rows } = await blocker.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (rows[0].n > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 200));   // the other requests pass the admin check meanwhile
      await blocker.query('COMMIT');

      const answers = await pending;
      expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      const bodies = await Promise.all(answers.map((r) => r.json()));
      for (const b of bodies) expect(b).toEqual(bodies[0]);
      // The first query of a run reads `since`: one run for the 4 requests.
      const runs = spy.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('AS since')).length;
      expect(runs).toBe(1);
    } finally {
      spy.mockRestore();
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
    }
    // Once a run is over, the next request starts a new one and sees new usage.
    await seen('alice', { pages: { trade: { views: 1, ms: 1_000 } } });
    expect((await monitoring()).totals.today.ms).toBe(2_000);
  });
});

// ---------- GET /admin/db ----------

describe('GET /admin/db', () => {
  it('returns the health card\'s shape with sane values, and no query text', async () => {
    const res = await call('GET', '/admin/db', 'root');
    expect(res.status).toBe(200);
    const text = await res.text();
    const h: AdminDbHealth = JSON.parse(text);

    expect(Object.keys(h).sort()).toEqual(['checkedAt', 'latencyMs', 'pool', 'server', 'tables']);
    expect(Math.abs(Date.parse(h.checkedAt) - Date.now())).toBeLessThan(60_000);
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
    expect(h.latencyMs).toBeLessThan(10_000);

    expect(h.pool.max).toBe(10);   // pg's default, as the test pool sets none
    expect(h.pool.total).toBeGreaterThanOrEqual(1);
    expect(h.pool.total).toBeLessThanOrEqual(h.pool.max);
    expect(h.pool.idle).toBeLessThanOrEqual(h.pool.total);
    expect(h.pool.waiting).toBe(0);

    expect(h.server.version).toMatch(/^\d+(\.\d+)*$/);
    expect(Date.parse(h.server.startedAt)).toBeLessThanOrEqual(Date.now());
    expect(h.server.sizeBytes).toBeGreaterThan(0);
    const c = h.server.connections;
    expect(c.active).toBeGreaterThanOrEqual(1);   // this request's own query
    expect(c.active + c.idle + c.idleInTransaction).toBeLessThanOrEqual(c.total);
    expect(c.total).toBeLessThanOrEqual(c.max);
    expect(c.max).toBeGreaterThan(0);
    expect(h.server.longestQuerySec === null || h.server.longestQuerySec >= 0).toBe(true);
    expect(h.server.cacheHitPct === null || (h.server.cacheHitPct >= 0 && h.server.cacheHitPct <= 100)).toBe(true);

    expect(h.tables.length).toBeGreaterThan(0);
    expect(h.tables.length).toBeLessThanOrEqual(5);
    for (const t of h.tables) {
      expect(Object.keys(t).sort()).toEqual(['bytes', 'name', 'rows']);
      expect(t.bytes).toBeGreaterThan(0);
      expect(Number.isInteger(t.rows) && t.rows >= -1).toBe(true);   // -1 = never analyzed
    }
    expect([...h.tables].sort((a, b) => b.bytes - a.bytes).map((t) => t.bytes)).toEqual(h.tables.map((t) => t.bytes));

    // Never a statement's text: not even this request's own.
    expect(text).not.toMatch(/pg_stat_activity|SELECT/i);
  });

  it('passes on a never-analyzed table\'s row estimate as -1, never as 0 rows', async () => {
    // 6 rows of 1 MB each, stored uncompressed, so it is the largest table. Too few rows for autovacuum to
    // analyze it, so Postgres has no estimate (reltuples = -1) until ANALYZE.
    await db.query('DROP TABLE IF EXISTS zz_test_unanalyzed');
    await db.query('CREATE TABLE zz_test_unanalyzed (pad TEXT)');
    try {
      await db.query('ALTER TABLE zz_test_unanalyzed ALTER COLUMN pad SET STORAGE EXTERNAL');
      await db.query(`INSERT INTO zz_test_unanalyzed SELECT repeat('x', 1000000) FROM generate_series(1, 6)`);
      const table = async () => {
        const h: AdminDbHealth = await (await call('GET', '/admin/db', 'root')).json();
        return h.tables.find((t) => t.name === 'zz_test_unanalyzed');
      };
      expect(await table()).toMatchObject({ rows: -1 });
      await db.query('ANALYZE zz_test_unanalyzed');
      expect(await table()).toMatchObject({ rows: 6 });
    } finally {
      await db.query('DROP TABLE zz_test_unanalyzed');
    }
  });

  it('counts a long query on another connection, never this request\'s own', async () => {
    const other = await db.connect();
    const sleeping = other.query('SELECT pg_sleep(1.5)');
    try {
      await new Promise((r) => setTimeout(r, 700));
      const h: AdminDbHealth = await (await call('GET', '/admin/db', 'root')).json();
      expect(h.server.longestQuerySec).not.toBeNull();
      expect(h.server.longestQuerySec!).toBeGreaterThanOrEqual(0.5);
    } finally {
      await sleeping;
      other.release();
    }
  });
});
