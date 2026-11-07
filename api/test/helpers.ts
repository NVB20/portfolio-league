// Test helpers: a local signing key that stands in for Google's, and a way to make Firebase-like tokens.

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

export const PROJECT_ID = 'test-project';

export async function makeTestKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' };
  return { keys: createLocalJWKSet({ keys: [jwk] }), privateKey };
}

type TokenOptions = {
  claims?: JWTPayload;                 // extra or overriding claims
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
};

// Signs a token shaped like a real Firebase ID token.
export async function signToken(privateKey: CryptoKey, uid: string, opts: TokenOptions = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: `${uid}@example.com`, auth_time: now, ...opts.claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(uid)
    .setIssuer(opts.issuer ?? `https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(opts.audience ?? PROJECT_ID)
    .setIssuedAt(now)
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(privateKey);
}
