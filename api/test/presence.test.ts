// POST /me/seen (D-026) against a real Postgres (TEST_DATABASE_URL).
// "Time passing" is simulated by moving last_seen_at back with SQL, so the tests don't wait.

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
  await db.query('TRUNCATE users CASCADE');
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

const seen = (uid = 'alice') => call('POST', '/me/seen', uid);

async function visits(uid = 'alice'): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app_opens WHERE uid = $1', [uid]);
  return rows[0].n;
}

async function secondsSinceSeen(uid = 'alice'): Promise<number | null> {
  const { rows } = await db.query<{ s: number | null }>(
    'SELECT extract(epoch FROM now() - last_seen_at)::float8 AS s FROM users WHERE uid = $1',
    [uid],
  );
  return rows[0].s;
}

// Pretend the last check-in was this long ago.
async function moveSeenBack(interval: string, uid = 'alice') {
  await db.query(`UPDATE users SET last_seen_at = now() - $2::interval WHERE uid = $1`, [uid, interval]);
}

describe('POST /me/seen', () => {
  it('returns 401 without a token', async () => {
    expect((await app.request('/me/seen', { method: 'POST' })).status).toBe(401);
  });

  it('returns 404 before POST /me', async () => {
    expect((await seen('ghost')).status).toBe(404);
  });

  it('a new user has never been seen', async () => {
    await call('POST', '/me', 'alice');
    expect(await secondsSinceSeen()).toBeNull();
    expect(await visits()).toBe(0);
  });

  it('the first check-in marks the player seen and starts a visit', async () => {
    await call('POST', '/me', 'alice');
    const res = await seen();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await secondsSinceSeen()).toBeLessThan(5);
    expect(await visits()).toBe(1);
  });

  it('check-ins within 30 seconds write nothing', async () => {
    await call('POST', '/me', 'alice');
    await seen();
    await moveSeenBack('10 seconds');
    await seen();
    expect(await secondsSinceSeen()).toBeGreaterThanOrEqual(10);   // not moved forward
    expect(await visits()).toBe(1);
  });

  it('the once-a-minute check-in keeps the player online without starting a visit', async () => {
    await call('POST', '/me', 'alice');
    await seen();
    await moveSeenBack('1 minute');
    await seen();
    expect(await secondsSinceSeen()).toBeLessThan(5);
    expect(await visits()).toBe(1);
  });

  it('coming back after more than 30 minutes starts a new visit', async () => {
    await call('POST', '/me', 'alice');
    await seen();
    await moveSeenBack('31 minutes');
    await seen();
    expect(await visits()).toBe(2);
  });

  it('many check-ins at the same moment start exactly one visit', async () => {
    await call('POST', '/me', 'alice');
    const results = await Promise.all(Array.from({ length: 10 }, () => seen()));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await visits()).toBe(1);
  });

  it('ignores the body: a client cannot claim a new visit', async () => {
    await call('POST', '/me', 'alice');
    await seen();
    await call('POST', '/me/seen', 'alice', { newVisit: true, open: true });
    expect(await visits()).toBe(1);
  });

  it('only touches the caller', async () => {
    await call('POST', '/me', 'alice');
    await call('POST', '/me', 'bob');
    await seen('alice');
    expect(await secondsSinceSeen('bob')).toBeNull();
    expect(await visits('bob')).toBe(0);
  });
});

// The daily streak (D-039): real Israel calendar days, counted by the check-in under its row lock. "Yesterday"
// is set with SQL from Postgres's own Israel date, so the tests don't wait for midnight.
describe('POST /me/seen counts the daily streak', () => {
  const TODAY = `(now() AT TIME ZONE 'Asia/Jerusalem')::date`;

  async function streak(uid = 'alice') {
    const { rows } = await db.query<{ days: number; best: number; lastDay: string | null; isToday: boolean | null; weekDays: number; dow: number }>(
      `SELECT streak_days AS days, streak_best AS best, streak_last_day::text AS "lastDay",
              streak_last_day = ${TODAY} AS "isToday", streak_week_days AS "weekDays",
              extract(dow FROM ${TODAY})::int AS dow
       FROM users WHERE uid = $1`,
      [uid],
    );
    return rows[0];
  }

  // Pretend the last day counted was `daysAgo` real days ago, with `days` in a row up to it.
  async function lastCounted(daysAgo: number, days: number, best = days, uid = 'alice') {
    await db.query(
      `UPDATE users SET streak_days = $2, streak_best = $3, streak_last_day = ${TODAY} - $4::int,
                        streak_week = NULL, streak_week_days = 0
       WHERE uid = $1`,
      [uid, days, best, daysAgo],
    );
  }

  it('a new player has no streak', async () => {
    await call('POST', '/me', 'alice');
    expect(await streak()).toMatchObject({ days: 0, best: 0, lastDay: null, weekDays: 0 });
  });

  it('the first check-in counts today: a streak of 1, and today marked in this week', async () => {
    await call('POST', '/me', 'alice');
    await seen();
    const s = await streak();
    expect(s).toMatchObject({ days: 1, best: 1, isToday: true });
    expect(s.weekDays).toBe(1 << s.dow);
  });

  it('in yesterday and today: one more day, whatever the hours between', async () => {
    await call('POST', '/me', 'alice');
    await lastCounted(1, 4);
    await seen();
    expect(await streak()).toMatchObject({ days: 5, best: 5, isToday: true });
  });

  it('a whole day missed: starts again at 1, the best stays', async () => {
    await call('POST', '/me', 'alice');
    await lastCounted(2, 4);
    await seen();
    expect(await streak()).toMatchObject({ days: 1, best: 4, isToday: true });
  });

  it('more check-ins the same day change nothing, a new visit included', async () => {
    await call('POST', '/me', 'alice');
    await seen();
    await moveSeenBack('31 minutes');
    await seen();
    expect(await visits()).toBe(2);
    expect(await streak()).toMatchObject({ days: 1, best: 1 });
  });

  it('a check-in under 30 seconds after the last one still counts a new day (just before and after midnight)', async () => {
    await call('POST', '/me', 'alice');
    await seen();
    await lastCounted(1, 2);
    await moveSeenBack('10 seconds');
    await seen();
    expect(await streak()).toMatchObject({ days: 3, isToday: true });
    expect(await secondsSinceSeen()).toBeGreaterThanOrEqual(10);   // the presence part still wrote nothing
  });

  it('many check-ins at the same moment count the day once', async () => {
    await call('POST', '/me', 'alice');
    await lastCounted(1, 6);
    const results = await Promise.all(Array.from({ length: 10 }, () => seen()));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await streak()).toMatchObject({ days: 7, best: 7 });
  });

  it('only counts the caller', async () => {
    await call('POST', '/me', 'alice');
    await call('POST', '/me', 'bob');
    await seen('alice');
    expect(await streak('bob')).toMatchObject({ days: 0, lastDay: null });
  });
});
