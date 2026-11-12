// The admin users page (D-044): GET /admin/users and PATCH /admin/users/:uid against a real Postgres
// (TEST_DATABASE_URL), plus users.visits kept by POST /me/seen. The rows inserted below are TEST fixtures.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { setAdminRole } from '../src/adminUsers.js';
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
  await call('POST', '/me', 'root', { claims: { name: 'Root' } });
  await db.query(`UPDATE users SET roles = '{admin,user}' WHERE uid = 'root'`);
});

afterAll(async () => {
  await db.end();
});

async function call(method: string, path: string, uid: string, opts: { claims?: Record<string, unknown>; body?: unknown } = {}) {
  const token = await signToken(privateKey, uid, { claims: opts.claims });
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function roles(uid: string): Promise<string[]> {
  const { rows } = await db.query<{ roles: string[] }>('SELECT roles FROM users WHERE uid = $1', [uid]);
  return rows[0].roles;
}

async function actions() {
  const { rows } = await db.query<{ uid: string; action: string; detail: Record<string, unknown> }>(
    'SELECT uid, action, detail FROM admin_actions ORDER BY id',
  );
  return rows;
}

// Players with set visits, last check-ins and sign-up times, so every order has a clear answer.
async function seedPlayers() {
  for (const [uid, name] of [['ann', 'Ann Levi'], ['ben', 'Ben Cohen'], ['dan', null]] as const) {
    await call('POST', '/me', uid, { claims: name ? { name } : {} });
  }
  await db.query(`UPDATE users SET visits = 7, last_seen_at = now() - interval '3 hours', created_at = now() - interval '9 days' WHERE uid = 'ann'`);
  await db.query(`UPDATE users SET visits = 2, last_seen_at = now() - interval '1 minute', created_at = now() - interval '5 days' WHERE uid = 'ben'`);
  await db.query(`UPDATE users SET visits = 12, last_seen_at = NULL, created_at = now() - interval '1 day' WHERE uid = 'dan'`);
  await db.query(`UPDATE users SET visits = 0, created_at = now() - interval '30 days' WHERE uid = 'root'`);
}

describe('admin users: access', () => {
  it('returns 401 without a token and 403 to a player', async () => {
    expect((await app.request('/admin/users')).status).toBe(401);
    await call('POST', '/me', 'mallory');
    expect((await call('GET', '/admin/users', 'mallory')).status).toBe(403);
    expect((await call('PATCH', '/admin/users/mallory', 'mallory', { body: { admin: true } })).status).toBe(403);
    expect(await roles('mallory')).toEqual(['user']);
  });
});

describe('GET /admin/users', () => {
  beforeEach(seedPlayers);

  it('lists every user, newest first by default, with visits and last check-in', async () => {
    const res = await call('GET', '/admin/users', 'root');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ total: 4, page: 1, pageSize: 50 });
    expect(body.users.map((u: { uid: string }) => u.uid)).toEqual(['dan', 'ben', 'ann', 'root']);
    expect(body.users[1]).toMatchObject({ uid: 'ben', email: 'ben@example.com', name: 'Ben Cohen', isAdmin: false, visits: 2 });
    expect(body.users[0]).toMatchObject({ uid: 'dan', name: null, lastSeenAt: null });
    expect(body.users[3]).toMatchObject({ uid: 'root', isAdmin: true });
  });

  it('sorts by visits and by last check-in, never-seen last', async () => {
    const byVisits = await (await call('GET', '/admin/users?sort=visits', 'root')).json();
    expect(byVisits.users.map((u: { uid: string }) => u.uid)).toEqual(['dan', 'ann', 'ben', 'root']);
    // POST /me isn't a check-in, so root and dan were never seen: they come last, by uid.
    const bySeen = await (await call('GET', '/admin/users?sort=lastSeen', 'root')).json();
    expect(bySeen.users.map((u: { uid: string }) => u.uid)).toEqual(['ben', 'ann', 'dan', 'root']);
  });

  it('filters to admins only', async () => {
    const body = await (await call('GET', '/admin/users?role=admin', 'root')).json();
    expect(body.total).toBe(1);
    expect(body.users.map((u: { uid: string }) => u.uid)).toEqual(['root']);
  });

  it('searches by name or email, case-insensitive, with % and _ as plain characters', async () => {
    const byName = await (await call('GET', '/admin/users?q=COHEN', 'root')).json();
    expect(byName.users.map((u: { uid: string }) => u.uid)).toEqual(['ben']);
    const byEmail = await (await call('GET', '/admin/users?q=dan%40example', 'root')).json();
    expect(byEmail.users.map((u: { uid: string }) => u.uid)).toEqual(['dan']);
    const wildcard = await (await call('GET', '/admin/users?q=%25', 'root')).json();
    expect(wildcard).toMatchObject({ total: 0, users: [] });
  });

  it('pages 50 at a time, and a page past the end still counts the users', async () => {
    await db.query(
      `INSERT INTO users (uid, email, created_at)
       SELECT 'p' || lpad(i::text, 3, '0'), 'p' || i || '@example.com', now() - make_interval(days => 40 + i)
       FROM generate_series(1, 60) AS i`,
    );
    const first = await (await call('GET', '/admin/users', 'root')).json();
    expect(first.total).toBe(64);
    expect(first.users).toHaveLength(50);
    const second = await (await call('GET', '/admin/users?page=2', 'root')).json();
    expect(second.users).toHaveLength(14);
    expect(second.users.at(-1).uid).toBe('p060');
    const seen = new Set([...first.users, ...second.users].map((u: { uid: string }) => u.uid));
    expect(seen.size).toBe(64);
    const past = await (await call('GET', '/admin/users?page=3', 'root')).json();
    expect(past).toMatchObject({ total: 64, page: 3, users: [] });
  });

  it('refuses a bad sort, role, page or search', async () => {
    for (const q of ['sort=email', 'role=user', 'page=0', 'page=abc', 'page=1.5', `q=${'x'.repeat(101)}`]) {
      expect((await call('GET', `/admin/users?${q}`, 'root')).status, q).toBe(400);
    }
  });
});

describe('PATCH /admin/users/:uid', () => {
  beforeEach(async () => {
    await call('POST', '/me', 'ann', { claims: { name: 'Ann Levi' } });
  });

  it('makes a player an admin and logs it in the same transaction', async () => {
    const res = await call('PATCH', '/admin/users/ann', 'root', { body: { admin: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: true, user: { uid: 'ann', isAdmin: true } });
    expect(await roles('ann')).toEqual(['admin', 'user']);
    expect(await actions()).toEqual([{ uid: 'root', action: 'role_grant', detail: { target: 'ann', email: 'ann@example.com' } }]);
    // The new admin can use the admin side at once.
    expect((await call('GET', '/admin/users', 'ann')).status).toBe(200);
  });

  it('takes the admin role away, and the next admin request is refused', async () => {
    await db.query(`UPDATE users SET roles = '{admin,user}' WHERE uid = 'ann'`);
    const res = await call('PATCH', '/admin/users/ann', 'root', { body: { admin: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: true, user: { isAdmin: false } });
    expect(await roles('ann')).toEqual(['user']);
    expect((await actions()).map((a) => a.action)).toEqual(['role_revoke']);
    expect((await call('GET', '/admin/users', 'ann')).status).toBe(403);
  });

  it('leaves the user role when an admin-only row loses admin', async () => {
    await db.query(`UPDATE users SET roles = '{admin}' WHERE uid = 'ann'`);
    expect((await call('PATCH', '/admin/users/ann', 'root', { body: { admin: false } })).status).toBe(200);
    expect(await roles('ann')).toEqual(['user']);
  });

  it('changes nothing and logs nothing when the user already has that role', async () => {
    const res = await call('PATCH', '/admin/users/ann', 'root', { body: { admin: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: false, user: { isAdmin: false } });
    expect(await actions()).toEqual([]);
  });

  it('refuses to take your own admin role, and writes nothing', async () => {
    const res = await call('PATCH', '/admin/users/root', 'root', { body: { admin: false } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'SELF_DEMOTE' });
    expect(await roles('root')).toEqual(['admin', 'user']);
    expect(await actions()).toEqual([]);
  });

  it('answers 404 for a user who does not exist', async () => {
    const res = await call('PATCH', '/admin/users/nobody', 'root', { body: { admin: true } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('refuses a body without a true/false admin, and ignores a roles field', async () => {
    for (const body of [{}, { admin: 'yes' }, { admin: 1 }, { roles: ['admin'] }]) {
      expect((await call('PATCH', '/admin/users/ann', 'root', { body })).status).toBe(400);
    }
    expect(await roles('ann')).toEqual(['user']);
  });

  it('leaves an admin when two admins take each other\'s role at the same moment', async () => {
    await db.query(`UPDATE users SET roles = '{admin,user}' WHERE uid = 'ann'`);
    // Straight to the function, so both start before either commits (the HTTP admin check is per request).
    const results = await Promise.all([setAdminRole(db, 'root', 'ann', false), setAdminRole(db, 'ann', 'root', false)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE 'admin' = ANY(roles)`);
    expect(rows[0].n).toBe(1);
    expect(await actions()).toHaveLength(1);
  });
});

describe('users.visits (D-044), kept by POST /me/seen', () => {
  async function visits(uid: string): Promise<number> {
    const { rows } = await db.query<{ visits: number }>('SELECT visits FROM users WHERE uid = $1', [uid]);
    return rows[0].visits;
  }

  it('adds 1 for each new visit, as app_opens does, and nothing for a check-in during a visit', async () => {
    await call('POST', '/me', 'ann');
    expect(await visits('ann')).toBe(0);
    await call('POST', '/me/seen', 'ann');
    expect(await visits('ann')).toBe(1);
    // A minute later: the same visit.
    await db.query(`UPDATE users SET last_seen_at = now() - interval '1 minute' WHERE uid = 'ann'`);
    await call('POST', '/me/seen', 'ann');
    expect(await visits('ann')).toBe(1);
    // Back after 31 minutes away: a new visit.
    await db.query(`UPDATE users SET last_seen_at = now() - interval '31 minutes' WHERE uid = 'ann'`);
    await call('POST', '/me/seen', 'ann');
    expect(await visits('ann')).toBe(2);
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM app_opens WHERE uid = 'ann'`);
    expect(rows[0].n).toBe(2);
  });
});
