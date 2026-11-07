// The token check, without a database.

import { beforeAll, describe, expect, it } from 'vitest';
import { errors, generateKeyPair, SignJWT } from 'jose';
import { Hono } from 'hono';
import { makeFirebaseVerifier, requireAuth, type AppEnv, type VerifyToken } from '../src/auth.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';

let verify: VerifyToken;
let privateKey: CryptoKey;

beforeAll(async () => {
  const test = await makeTestKeys();
  privateKey = test.privateKey;
  verify = makeFirebaseVerifier(PROJECT_ID, test.keys);
});

const now = () => Math.floor(Date.now() / 1000);

describe('makeFirebaseVerifier', () => {
  it('accepts a valid token and returns uid and email', async () => {
    const token = await signToken(privateKey, 'alice');
    await expect(verify(token)).resolves.toEqual({ uid: 'alice', email: 'alice@example.com' });
  });

  it('returns an empty email when the token has none', async () => {
    const token = await signToken(privateKey, 'alice', { claims: { email: undefined } });
    await expect(verify(token)).resolves.toEqual({ uid: 'alice', email: '' });
  });

  it('rejects a token for another Firebase project', async () => {
    const token = await signToken(privateKey, 'alice', { audience: 'other-project' });
    await expect(verify(token)).rejects.toThrow();
  });

  it('rejects a token from another issuer', async () => {
    const token = await signToken(privateKey, 'alice', { issuer: 'https://evil.example.com' });
    await expect(verify(token)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await signToken(privateKey, 'alice', { expiresIn: now() - 60 });
    await expect(verify(token)).rejects.toThrow();
  });

  it('rejects a token without auth_time', async () => {
    const token = await signToken(privateKey, 'alice', { claims: { auth_time: undefined } });
    await expect(verify(token)).rejects.toThrow();
  });

  it('rejects a token whose auth_time is in the future', async () => {
    const token = await signToken(privateKey, 'alice', { claims: { auth_time: now() + 3600 } });
    await expect(verify(token)).rejects.toThrow('auth_time');
  });

  it('rejects a token signed by a different key', async () => {
    const other = await generateKeyPair('RS256');
    const token = await signToken(other.privateKey, 'alice');
    await expect(verify(token)).rejects.toThrow();
  });

  it('rejects a token signed with a shared secret (HS256)', async () => {
    const token = await new SignJWT({ auth_time: now() })
      .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
      .setSubject('alice')
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(PROJECT_ID)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-secret-that-anyone-could-guess-123456'));
    await expect(verify(token)).rejects.toThrow();
  });
});

describe('requireAuth', () => {
  const app = () => {
    const a = new Hono<AppEnv>();
    a.use(requireAuth(verify));
    a.get('/', (c) => c.json(c.get('user')));
    return a;
  };

  it('returns 401 with no Authorization header', async () => {
    const res = await app().request('/');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a bad token', async () => {
    const res = await app().request('/', { headers: { Authorization: 'Bearer not-a-jwt' } });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the scheme is not Bearer', async () => {
    const token = await signToken(privateKey, 'alice');
    const res = await app().request('/', { headers: { Authorization: `Basic ${token}` } });
    expect(res.status).toBe(401);
  });

  it("returns 500, not 401, when Google's key server fails", async () => {
    const failing = new Hono<AppEnv>();
    failing.use(requireAuth(async () => {
      throw new errors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response');
    }));
    failing.get('/', (c) => c.text('ok'));
    const res = await failing.request('/', { headers: { Authorization: 'Bearer anything' } });
    expect(res.status).toBe(500);
  });

  it('passes the user to the route for a valid token', async () => {
    const token = await signToken(privateKey, 'alice');
    const res = await app().request('/', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 'alice', email: 'alice@example.com' });
  });
});
