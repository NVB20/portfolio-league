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
  await db.query('TRUNCATE users');
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
    expect(await res.json()).toEqual({ email: 'alice@example.com', roles: ['user'], theme: 'dark' });
    expect(await countUsers()).toBe(1);
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
