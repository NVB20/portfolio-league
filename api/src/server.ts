// Starts the API: reads the environment, connects to Postgres, listens on PORT.

import { serve } from '@hono/node-server';
import pg from 'pg';
import { createApp } from './app.js';
import { googleKeys, makeFirebaseVerifier } from './auth.js';

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

// Railway sends SIGTERM before replacing a deployment: finish open requests, then close the pool.
process.on('SIGTERM', () => {
  server.close(() => {
    db.end().finally(() => process.exit(0));
  });
});
