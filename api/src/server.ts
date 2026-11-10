// Starts the API: reads the environment, connects to Postgres, listens on PORT, and starts the per-minute
// ticker (D-030) unless TICKER=off.

import { serve } from '@hono/node-server';
import pg from 'pg';
import { createApp } from './app.js';
import { googleKeys, makeFirebaseVerifier } from './auth.js';
import { startTicker } from './clockActions.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const db = new pg.Pool({
  connectionString: requireEnv('DATABASE_URL'),
  max: 10,                        // Postgres allows ~100 connections in total; keep room for replicas and migrations
  connectionTimeoutMillis: 5000,  // fail fast instead of waiting forever for a free connection
  statement_timeout: 10000,       // no single query may run longer than 10 s
});
// An idle connection dropped by the server must not crash the process.
db.on('error', (err) => console.error('Postgres pool error', err));

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

// Railway sends SIGTERM before replacing a deployment: stop ticking and finish open requests (and the tick in
// progress), then close the pool. A tick cut short is safe: the next instance resumes the event (D-021).
process.on('SIGTERM', () => {
  const ticking = stopTicker ? stopTicker() : Promise.resolve();
  server.close(() => {
    ticking.finally(() => db.end().finally(() => process.exit(0)));
  });
});
