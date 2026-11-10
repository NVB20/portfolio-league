// The API's Postgres pool (api/src/db.ts, used by server.ts) when the database ends a connection: a database
// restart, a failover, a dropped proxy connection, an idle-session timeout. pg_terminate_backend does the same
// here. Only the query that was running may fail. The process must keep serving everyone else (D-021, D-030):
// node-postgres emits 'error' on a client whose session ends, the pool stops listening to a client while it is
// checked out, and an 'error' nobody listens to is thrown by Node and ends the whole process.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createPool } from '../src/db.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

// Ends other sessions, as the database server would.
const killer = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pidOf = async (c: pg.PoolClient) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
const terminate = (pid: number) => killer.query('SELECT pg_terminate_backend($1)', [pid]);

// What would have ended the process, caught here so the test can say so.
let uncaught: unknown[] = [];
const onUncaught = (err: unknown) => { uncaught.push(err); };

beforeEach(() => {
  uncaught = [];
  process.on('uncaughtException', onUncaught);
});

afterEach(() => {
  process.off('uncaughtException', onUncaught);
});

afterAll(async () => {
  await killer.end();
});

describe('createPool: a connection the database ends', () => {
  it('between two queries of a checked-out client: the next query fails, the process does not', async () => {
    const db = createPool(DATABASE_URL);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const c = await db.connect();
      await terminate(await pidOf(c));
      await sleep(200);   // the end of the session reaches the client while it is checked out
      await expect(c.query('SELECT 1')).rejects.toThrow();
      c.release();
      expect(uncaught).toEqual([]);
      expect(errors).toHaveBeenCalled();   // logged, not thrown
      // The dead connection is not handed out again: the pool keeps working.
      expect((await db.query<{ n: number }>('SELECT 1 AS n')).rows[0].n).toBe(1);
      expect(db.totalCount).toBe(1);
    } finally {
      errors.mockRestore();
      await db.end();
    }
  });

  it('in the middle of a query: that query fails, the process does not', async () => {
    const db = createPool(DATABASE_URL);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const c = await db.connect();
      const pid = await pidOf(c);
      const slow = c.query('SELECT pg_sleep(5)');
      await sleep(100);
      await terminate(pid);
      await expect(slow).rejects.toThrow();
      await sleep(200);   // the session's end arrives after the query's own error
      c.release();
      expect(uncaught).toEqual([]);
      expect((await db.query<{ n: number }>('SELECT 2 AS n')).rows[0].n).toBe(2);
    } finally {
      errors.mockRestore();
      await db.end();
    }
  });

  it('has the API\'s settings: 10 connections, a 5 s wait for one, a 10 s statement timeout', async () => {
    const db = createPool(DATABASE_URL);
    try {
      expect(db.options).toMatchObject({ max: 10, connectionTimeoutMillis: 5000 });
      expect((await db.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('10s');
    } finally {
      await db.end();
    }
  });
});
