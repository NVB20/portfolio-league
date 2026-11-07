// The HTTP routes. Everything the API needs from outside (database, token check, allowed origins)
// is passed in, so tests can build the same app with a test database and test keys.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import type { Pool } from 'pg';
import { requireAuth, type AppEnv, type VerifyToken } from './auth.js';
import { setTheme, upsertUser } from './users.js';

export type Deps = {
  db: Pool;
  verifyToken: VerifyToken;
  corsOrigins: string[];   // web origins allowed to call the API, e.g. the Firebase Hosting domains
};

export function createApp({ db, verifyToken, corsOrigins }: Deps) {
  const app = new Hono<AppEnv>();

  // The web app and the API are on different domains, so the browser asks permission first (CORS).
  // No cookies are used (the token goes in a header), so credentials stay off.
  app.use(
    '*',
    cors({
      origin: corsOrigins,
      allowMethods: ['GET', 'POST', 'PATCH'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 7200,
    }),
  );

  // Refuse bodies over 16 KB before reading them, so one huge request can't fill the server's memory.
  app.use('*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'body too large' }, 413) }));

  // For Railway's healthcheck and uptime monitors: is the API up, and can it reach the database?
  app.get('/health', async (c) => {
    await db.query('SELECT 1');
    return c.json({ ok: true });
  });

  // Everything under /me needs a valid Firebase token.
  const me = new Hono<AppEnv>();
  me.use(requireAuth(verifyToken));

  // Called by the app right after login: creates the user row the first time, and returns it.
  me.post('/', async (c) => {
    const { uid, email } = c.get('user');
    return c.json(await upsertUser(db, uid, email));
  });

  // Body: { "theme": "dark" | "light" }. Any other field (like roles) is ignored.
  me.patch('/theme', async (c) => {
    const body = await c.req.json().catch(() => null);
    const theme = body?.theme;
    if (theme !== 'dark' && theme !== 'light') {
      return c.json({ error: 'theme must be "dark" or "light"' }, 400);
    }
    const updated = await setTheme(db, c.get('user').uid, theme);
    if (!updated) return c.json({ error: 'user not found, call POST /me first' }, 404);
    return c.json(updated);
  });

  app.route('/me', me);

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  // Log the real error on the server; never send its details to the browser.
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
