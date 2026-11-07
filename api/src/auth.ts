// Checks the Firebase ID token (a JWT) that the app sends as `Authorization: Bearer <token>`.
// Firebase signs these tokens with Google's private keys; we check them with Google's public keys.
// Nothing here talks to Firebase or needs a Firebase secret.
// The checks follow https://firebase.google.com/docs/auth/admin/verify-id-tokens
// ("Verify ID tokens using a third-party JWT library").

import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { MiddlewareHandler } from 'hono';

export type AuthUser = { uid: string; email: string };
export type VerifyToken = (token: string) => Promise<AuthUser>;

// What every route after `requireAuth` can read with c.get('user').
export type AppEnv = { Variables: { user: AuthUser } };

// Google's public keys for Firebase ID tokens, as a JWK set. Same keys as the x509 URL in the docs.
// jose caches them and re-fetches when it sees a key id (`kid`) it doesn't know.
const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const CLOCK_TOLERANCE_SECONDS = 5;

export function googleKeys(): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
}

// Thrown for tokens that are well-formed but break one of Firebase's rules.
class InvalidTokenError extends Error {}

// `keys` is Google's key set in production, and a local test key set in tests.
export function makeFirebaseVerifier(projectId: string, keys: JWTVerifyGetKey): VerifyToken {
  return async (token) => {
    // jose checks: signature, alg = RS256, iss, aud, exp (not expired), and that the listed claims exist.
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      requiredClaims: ['exp', 'iat', 'auth_time', 'sub'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });

    // jose doesn't check these two, so we do: both must be in the past.
    const latest = Math.floor(Date.now() / 1000) + CLOCK_TOLERANCE_SECONDS;
    if (typeof payload.iat !== 'number' || payload.iat > latest) {
      throw new InvalidTokenError('iat is in the future');
    }
    if (typeof payload.auth_time !== 'number' || payload.auth_time > latest) {
      throw new InvalidTokenError('auth_time is in the future');
    }
    // sub = the Firebase uid. Must be a non-empty string.
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new InvalidTokenError('sub is empty');
    }

    return { uid: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' };
  };
}

// Middleware: rejects the request with 401 unless it carries a valid Firebase token.
export function requireAuth(verifyToken: VerifyToken): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const [scheme, token] = (c.req.header('Authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      return c.json({ error: 'missing token' }, 401);
    }

    try {
      c.set('user', await verifyToken(token));
    } catch (e) {
      // Google's key server timing out, erroring or sending junk is our problem, not a bad token:
      // let it become a 500. (jose reports a non-200 key response as a generic JOSEError.)
      if (
        e instanceof errors.JWKSTimeout ||
        e instanceof errors.JWKSInvalid ||
        (e instanceof errors.JOSEError && e.code === 'ERR_JOSE_GENERIC')
      ) {
        throw e;
      }
      if (e instanceof errors.JOSEError || e instanceof InvalidTokenError) {
        return c.json({ error: 'invalid token' }, 401);
      }
      throw e;
    }

    await next();
  };
}
