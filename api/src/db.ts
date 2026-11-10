// The API's Postgres pool, built here (not in server.ts) so tests can build the very same one.

import pg from 'pg';

export function createPool(connectionString: string): pg.Pool {
  const db = new pg.Pool({
    connectionString,
    max: 10,                        // Postgres allows ~100 connections in total; keep room for replicas and migrations
    connectionTimeoutMillis: 5000,  // fail fast instead of waiting forever for a free connection
    statement_timeout: 10000,       // no single query may run longer than 10 s
  });
  // An idle connection dropped by the server must not crash the process.
  db.on('error', (err) => console.error('Postgres pool error', err.message));
  // Nor may a connection that is checked out. node-postgres emits 'error' on a client whose session ends (a
  // database restart, a failover, a dropped proxy connection), and the pool listens only while a client is idle:
  // it takes its listener off while the client is in use. An 'error' nobody listens to is thrown by Node and
  // ends the whole process: every request in flight, and the ticker's run (D-030). With a listener for the
  // client's whole life, a dead connection only fails the query that was running (it rejects as usual, and the
  // caller's catch handles it), and the pool drops the dead client instead of handing it out again.
  db.on('connect', (client) => {
    client.on('error', (err) => console.error('Postgres connection lost', err.message));
  });
  return db;
}
