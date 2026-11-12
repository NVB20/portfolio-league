// The /me routes against a real Postgres (TEST_DATABASE_URL, default: the local Docker database).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';
const ORIGIN = 'http://localhost:8081';

const db = new pg.Pool({ connectionString: DATABASE_URL });
let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;

beforeAll(async () => {
  await runner({
    databaseUrl: DATABASE_URL,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
  const test = await makeTestKeys();
  privateKey = test.privateKey;
  app = createApp({ db, verifyToken: makeFirebaseVerifier(PROJECT_ID, test.keys), corsOrigins: [ORIGIN] });
});

beforeEach(async () => {
  // CASCADE: portfolios (and everything that hangs off a user) go too.
  await db.query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await db.end();
});

async function call(method: string, path: string, uid: string, body?: unknown, email?: string) {
  const token = await signToken(privateKey, uid, email ? { claims: { email } } : {});
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const countUsers = async () => (await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n;

describe('GET /health', () => {
  it('is ok when the database answers', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('POST /me', () => {
  it('creates the user on first login as a normal user with the dark theme', async () => {
    const res = await call('POST', '/me', 'alice');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: 'alice@example.com',
      roles: ['user'],
      theme: 'dark',
      onboardedAt: null,
      adminOnboardedAt: null,
    });
    expect(await countUsers()).toBe(1);
  });

  it('creates the portfolio with the starting ₪1,000,000 on first login, once', async () => {
    await Promise.all([call('POST', '/me', 'alice'), call('POST', '/me', 'alice')]);
    const { rows } = await db.query(`SELECT cash::float8 AS cash FROM portfolios WHERE uid = 'alice'`);
    expect(rows).toEqual([{ cash: 1_000_000 }]);
  });

  it('returns the same user on later logins without duplicating it', async () => {
    await call('POST', '/me', 'alice');
    await call('POST', '/me', 'alice');
    expect(await countUsers()).toBe(1);
  });

  it('keeps an admin an admin on later logins', async () => {
    await call('POST', '/me', 'alice');
    await db.query(`UPDATE users SET roles = '{admin,user}' WHERE uid = 'alice'`);
    const res = await call('POST', '/me', 'alice');
    expect((await res.json()).roles).toEqual(['admin', 'user']);
  });

  it('refreshes the email from the token', async () => {
    await call('POST', '/me', 'alice');
    const res = await call('POST', '/me', 'alice', undefined, 'new@example.com');
    expect((await res.json()).email).toBe('new@example.com');
  });

  it('ignores roles sent in the body', async () => {
    const res = await call('POST', '/me', 'mallory', { roles: ['admin'] });
    expect((await res.json()).roles).toEqual(['user']);
  });

  it('creates exactly one row when called many times at once', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/me', 'alice')));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await countUsers()).toBe(1);
  });

  it('returns 401 without a token', async () => {
    const res = await app.request('/me', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await countUsers()).toBe(0);
  });
});

describe('PATCH /me/theme', () => {
  it('changes the theme', async () => {
    await call('POST', '/me', 'alice');
    const res = await call('PATCH', '/me/theme', 'alice', { theme: 'light' });
    expect(res.status).toBe(200);
    expect((await res.json()).theme).toBe('light');
  });

  it('cannot change roles', async () => {
    await call('POST', '/me', 'mallory');
    const res = await call('PATCH', '/me/theme', 'mallory', { theme: 'light', roles: ['admin'] });
    expect((await res.json()).roles).toEqual(['user']);
  });

  it('only changes the caller, not other users', async () => {
    await call('POST', '/me', 'alice');
    await call('POST', '/me', 'bob');
    await call('PATCH', '/me/theme', 'alice', { theme: 'light' });
    const bob = await db.query(`SELECT theme FROM users WHERE uid = 'bob'`);
    expect(bob.rows[0].theme).toBe('dark');
  });

  it('returns 400 for an unknown theme', async () => {
    await call('POST', '/me', 'alice');
    const res = await call('PATCH', '/me/theme', 'alice', { theme: 'pink' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a body that is not JSON', async () => {
    const token = await signToken(privateKey, 'alice');
    const res = await app.request('/me/theme', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 413 for a body over 16 KB', async () => {
    await call('POST', '/me', 'alice');
    const res = await call('PATCH', '/me/theme', 'alice', { theme: 'light', pad: 'x'.repeat(20_000) });
    expect(res.status).toBe(413);
  });

  it('returns 404 before the user row exists', async () => {
    const res = await call('PATCH', '/me/theme', 'ghost', { theme: 'light' });
    expect(res.status).toBe(404);
  });

  it('returns the onboarding fields with the rest of Me', async () => {
    await call('POST', '/me', 'alice');
    const seen = await (await call('POST', '/me/onboarding/seen', 'alice', { flow: 'player' })).json();
    expect(seen.onboardedAt).toEqual(expect.any(String));
    const body = await (await call('PATCH', '/me/theme', 'alice', { theme: 'light' })).json();
    expect(body.theme).toBe('light');
    expect(body.onboardedAt).toBe(seen.onboardedAt);
    expect(body.adminOnboardedAt).toBeNull();
  });
});

describe('POST /me/onboarding/seen', () => {
  // The stored times in the API's format (pg gives a Date; toISOString keeps milliseconds, as the API's toMe does),
  // so they compare exactly with a response's onboardedAt / adminOnboardedAt.
  const onboarding = async (uid: string) => {
    const { rows } = await db.query(`SELECT onboarded_at, admin_onboarded_at FROM users WHERE uid = $1`, [uid]);
    return {
      player: rows[0].onboarded_at?.toISOString() ?? null,
      admin: rows[0].admin_onboarded_at?.toISOString() ?? null,
    };
  };
  const makeAdmin = (uid: string) => db.query(`UPDATE users SET roles = '{admin,user}' WHERE uid = $1`, [uid]);

  it('marks the player walkthrough seen, and POST /me returns it afterwards (a new device)', async () => {
    await call('POST', '/me', 'alice');
    const before = Date.now();
    const res = await call('POST', '/me/onboarding/seen', 'alice', { flow: 'player' });
    const after = Date.now();
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me).toMatchObject({ email: 'alice@example.com', roles: ['user'], theme: 'dark', adminOnboardedAt: null });
    expect(new Date(me.onboardedAt).toISOString()).toBe(me.onboardedAt);
    // Real time now (Postgres now()), never the world clock. 5 s of slack for the clock difference with Postgres.
    const at = Date.parse(me.onboardedAt);
    expect(at).toBeGreaterThanOrEqual(before - 5_000);
    expect(at).toBeLessThanOrEqual(after + 5_000);
    expect(await onboarding('alice')).toEqual({ player: me.onboardedAt, admin: null });
    const again = await (await call('POST', '/me', 'alice')).json();
    expect(again.onboardedAt).toBe(me.onboardedAt);
  });

  it('keeps the first time when called again', async () => {
    await call('POST', '/me', 'alice');
    const first = await (await call('POST', '/me/onboarding/seen', 'alice', { flow: 'player' })).json();
    const second = await (await call('POST', '/me/onboarding/seen', 'alice', { flow: 'player' })).json();
    expect(second.onboardedAt).toBe(first.onboardedAt);
    // A time far in the past proves the repeat keeps it rather than writing now() again.
    await db.query(`UPDATE users SET onboarded_at = '2026-01-01T00:00:00Z' WHERE uid = 'alice'`);
    const third = await (await call('POST', '/me/onboarding/seen', 'alice', { flow: 'player' })).json();
    expect(third.onboardedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('keeps the first admin time when called again', async () => {
    await call('POST', '/me', 'alice');
    await makeAdmin('alice');
    const first = await (await call('POST', '/me/onboarding/seen', 'alice', { flow: 'admin' })).json();
    expect(first.adminOnboardedAt).toEqual(expect.any(String));
    const second = await (await call('POST', '/me/onboarding/seen', 'alice', { flow: 'admin' })).json();
    expect(second.adminOnboardedAt).toBe(first.adminOnboardedAt);
    // As for the player: a time far in the past proves the repeat keeps it rather than writing now() again.
    await db.query(`UPDATE users SET admin_onboarded_at = '2026-01-01T00:00:00Z' WHERE uid = 'alice'`);
    const third = await (await call('POST', '/me/onboarding/seen', 'alice', { flow: 'admin' })).json();
    expect(third.adminOnboardedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('only marks the caller, whatever the body names', async () => {
    await call('POST', '/me', 'alice');
    await call('POST', '/me', 'bob');
    const res = await call('POST', '/me/onboarding/seen', 'alice', { flow: 'player', uid: 'bob' });
    expect(res.status).toBe(200);
    expect((await onboarding('alice')).player).not.toBeNull();
    expect(await onboarding('bob')).toEqual({ player: null, admin: null });
  });

  it('refuses the admin flow for a user without the admin role, and writes nothing', async () => {
    await call('POST', '/me', 'mallory');
    const res = await call('POST', '/me/onboarding/seen', 'mallory', { flow: 'admin', roles: ['admin'] });
    expect(res.status).toBe(403);
    expect(await onboarding('mallory')).toEqual({ player: null, admin: null });
  });

  it('marks the admin walkthrough for an admin, and POST /me and PATCH /me/theme return it afterwards', async () => {
    await call('POST', '/me', 'alice');
    await makeAdmin('alice');
    const res = await call('POST', '/me/onboarding/seen', 'alice', { flow: 'admin' });
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me).toMatchObject({ roles: ['admin', 'user'], onboardedAt: null });
    expect(new Date(me.adminOnboardedAt).toISOString()).toBe(me.adminOnboardedAt);
    const stored = await onboarding('alice');
    expect(stored.admin).not.toBeNull();
    expect(stored).toEqual({ player: null, admin: me.adminOnboardedAt });
    const login = await (await call('POST', '/me', 'alice')).json();
    expect(login.adminOnboardedAt).toBe(me.adminOnboardedAt);
    const theme = await (await call('PATCH', '/me/theme', 'alice', { theme: 'light' })).json();
    expect(theme.adminOnboardedAt).toBe(me.adminOnboardedAt);
  });

  it('keeps the two flows apart on one admin: marking one never changes the other', async () => {
    await call('POST', '/me', 'alice');
    await makeAdmin('alice');
    const player = await (await call('POST', '/me/onboarding/seen', 'alice', { flow: 'player' })).json();
    expect(player.onboardedAt).toEqual(expect.any(String));
    expect(player.adminOnboardedAt).toBeNull();
    const admin = await (await call('POST', '/me/onboarding/seen', 'alice', { flow: 'admin' })).json();
    expect(admin.adminOnboardedAt).toEqual(expect.any(String));
    expect(admin.onboardedAt).toBe(player.onboardedAt);
    const both = { player: player.onboardedAt, admin: admin.adminOnboardedAt };
    expect(await onboarding('alice')).toEqual(both);
    const playerAgain = await (await call('POST', '/me/onboarding/seen', 'alice', { flow: 'player' })).json();
    expect(playerAgain.onboardedAt).toBe(player.onboardedAt);
    expect(playerAgain.adminOnboardedAt).toBe(admin.adminOnboardedAt);
    expect(await onboarding('alice')).toEqual(both);
  });

  it('returns 400 for an unknown or missing flow, and writes nothing', async () => {
    await call('POST', '/me', 'alice');
    for (const body of [{ flow: 'pink' }, { flow: 'PLAYER' }, {}, { flow: ['player'] }, null]) {
      const res = await call('POST', '/me/onboarding/seen', 'alice', body);
      expect(res.status).toBe(400);
    }
    expect(await onboarding('alice')).toEqual({ player: null, admin: null });
  });

  it('returns 400 for a body that is not JSON, and for no body', async () => {
    await call('POST', '/me', 'alice');
    const token = await signToken(privateKey, 'alice');
    const notJson = await app.request('/me/onboarding/seen', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: 'not json',
    });
    expect(notJson.status).toBe(400);
    const noBody = await call('POST', '/me/onboarding/seen', 'alice');
    expect(noBody.status).toBe(400);
  });

  it('returns 404 before the user row exists, for either flow', async () => {
    expect((await call('POST', '/me/onboarding/seen', 'ghost', { flow: 'player' })).status).toBe(404);
    expect((await call('POST', '/me/onboarding/seen', 'ghost', { flow: 'admin' })).status).toBe(404);
    expect(await countUsers()).toBe(0);
  });

  it('returns 401 without a token', async () => {
    const res = await app.request('/me/onboarding/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow: 'player' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('CORS', () => {
  it('allows the app origin', async () => {
    const res = await app.request('/me', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('does not allow other origins', async () => {
    const res = await app.request('/me', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
