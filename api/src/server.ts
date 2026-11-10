// Starts the API: reads the environment, connects to Postgres, listens on PORT, and starts the per-minute
// ticker (D-030) unless TICKER=off.

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { googleKeys, makeFirebaseVerifier } from './auth.js';
import { startTicker } from './clockActions.js';
import { createPool } from './db.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

// 10 connections, 10 s per statement, and a lost connection never crashes the process (db.ts).
const db = createPool(requireEnv('DATABASE_URL'));

const app = createApp({
  db,
  verifyToken: makeFirebaseVerifier(requireEnv('FIREBASE_PROJECT_ID'), googleKeys()),
  corsOrigins: requireEnv('CORS_ORIGINS').split(',').map((origin) => origin.trim()),
});

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) =>
  console.log(`API listening on port ${info.port}`),
);

// The ticker runs the opens and closes the running clock passes, and writes the heartbeat the admin page
// watches. Here and not in createApp, so tests never start it. Several instances may each tick: the runner's
// advisory lock lets one run at a time. TICKER=off turns it off (e.g. a local API on a copy of the database).
const stopTicker = process.env.TICKER === 'off' ? null : startTicker(db);
if (!stopTicker) console.log('Ticker is off (TICKER=off): world events run only on admin clock moves');

// The host sends SIGTERM before replacing a container: stop ticking and finish open requests (and the tick in
// progress), then close the pool. A tick cut short is safe: the next instance resumes the event (D-021).
process.on('SIGTERM', () => {
  const ticking = stopTicker ? stopTicker() : Promise.resolve();
  server.close(() => {
    void ticking.finally(() => db.end().finally(() => process.exit(0)));
  });
});
