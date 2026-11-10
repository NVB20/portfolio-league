// The database rules behind the money (D-018, D-019) against a real Postgres (TEST_DATABASE_URL).
// These are the guarantees that hold even if the API code has a bug: the database refuses the bad write.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

const db = new pg.Pool({ connectionString: DATABASE_URL });
let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;

beforeAll(async () => {
  await runner({ databaseUrl: DATABASE_URL, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
  const test = await makeTestKeys();
  privateKey = test.privateKey;
  app = createApp({ db, verifyToken: makeFirebaseVerifier(PROJECT_ID, test.keys), corsOrigins: [] });
});

beforeEach(async () => {
  await db.query('TRUNCATE users, securities, usd_ils, world_clock, market_events CASCADE');
  await db.query(`INSERT INTO securities VALUES ('TEVA', 'טבע', 'TASE', 'TASE', 'ILS')`);
});

afterAll(async () => {
  await db.end();
});

async function signUp(uid: string) {
  const token = await signToken(privateKey, uid);
  const res = await app.request('/me', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
}

// Runs `fn` in one transaction and commits, so deferred checks (the journal balance) really run.
async function inTransaction(fn: (c: pg.PoolClient) => Promise<void>) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

async function balances(uid: string) {
  const { rows } = await db.query<{ account: string; total: string }>(
    'SELECT account, sum(amount)::text AS total FROM ledger_entries WHERE uid = $1 GROUP BY account ORDER BY account',
    [uid],
  );
  return Object.fromEntries(rows.map((r) => [r.account, Number(r.total)]));
}

describe('the starting cash', () => {
  it('is written to the ledger once, on the first login', async () => {
    await signUp('alice');
    await signUp('alice');   // second login: no second journal
    const journals = await db.query(`SELECT kind FROM journals WHERE uid = 'alice'`);
    expect(journals.rows).toEqual([{ kind: 'start' }]);
    expect(await balances('alice')).toEqual({ capital: -1_000_000, cash_free: 1_000_000 });
  });

  it('starts every stored total at the brief\'s numbers', async () => {
    await signUp('alice');
    const { rows } = await db.query(
      `SELECT cash::float8, reserved_cash::float8, available_cash::float8, holdings_value::float8, equity::float8
       FROM portfolios WHERE uid = 'alice'`,
    );
    expect(rows[0]).toEqual({ cash: 1_000_000, reserved_cash: 0, available_cash: 1_000_000, holdings_value: 0, equity: 1_000_000 });
  });
});

describe('double entry', () => {
  it('accepts a journal whose entries sum to 0', async () => {
    await signUp('alice');
    await inTransaction(async (c) => {
      const j = await c.query(`INSERT INTO journals (uid, kind) VALUES ('alice', 'reversal') RETURNING id`);
      await c.query(
        `INSERT INTO ledger_entries (journal_id, uid, account, amount) VALUES ($1, 'alice', 'cash_free', -100), ($1, 'alice', 'cash_locked', 100)`,
        [j.rows[0].id],
      );
    });
    expect(await balances('alice')).toMatchObject({ cash_free: 999_900, cash_locked: 100 });
  });

  it('refuses a journal that does not balance, at commit', async () => {
    await signUp('alice');
    await expect(
      inTransaction(async (c) => {
        const j = await c.query(`INSERT INTO journals (uid, kind) VALUES ('alice', 'reversal') RETURNING id`);
        // A bug: cash added, nothing taken away. Money from nothing.
        await c.query(
          `INSERT INTO ledger_entries (journal_id, uid, account, amount) VALUES ($1, 'alice', 'cash_free', 1100), ($1, 'alice', 'realized_pnl', -100)`,
          [j.rows[0].id],
        );
      }),
    ).rejects.toThrow(/does not balance/);
    expect(await balances('alice')).toEqual({ capital: -1_000_000, cash_free: 1_000_000 });   // nothing was kept
  });

  it('refuses a journal with a single entry', async () => {
    await signUp('alice');
    await expect(
      inTransaction(async (c) => {
        await c.query(`INSERT INTO journals (uid, kind) VALUES ('alice', 'reversal')`);
      }),
    ).rejects.toThrow(/needs at least 2/);
  });

  it('refuses an entry for a different player than its journal', async () => {
    await signUp('alice');
    await signUp('bob');
    await expect(
      inTransaction(async (c) => {
        const j = await c.query(`INSERT INTO journals (uid, kind) VALUES ('alice', 'reversal') RETURNING id`);
        await c.query(
          `INSERT INTO ledger_entries (journal_id, uid, account, amount) VALUES ($1, 'alice', 'cash_free', -100), ($1, 'bob', 'cash_free', 100)`,
          [j.rows[0].id],
        );
      }),
    ).rejects.toThrow(/foreign key/);
  });

  it('keeps stock_cost tied to a symbol', async () => {
    await signUp('alice');
    await expect(
      inTransaction(async (c) => {
        const j = await c.query(`INSERT INTO journals (uid, kind) VALUES ('alice', 'reversal') RETURNING id`);
        await c.query(
          `INSERT INTO ledger_entries (journal_id, uid, account, amount) VALUES ($1, 'alice', 'cash_free', -100), ($1, 'alice', 'stock_cost', 100)`,
          [j.rows[0].id],
        );
      }),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('append-only', () => {
  it('refuses to change or delete ledger rows', async () => {
    await signUp('alice');
    await expect(db.query(`UPDATE ledger_entries SET amount = 2000000 WHERE uid = 'alice' AND account = 'cash_free'`))
      .rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM ledger_entries WHERE uid = 'alice'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM journals WHERE uid = 'alice'`)).rejects.toThrow(/append-only/);
  });

  it('still lets a whole player be deleted', async () => {
    await signUp('alice');
    await db.query(`DELETE FROM users WHERE uid = 'alice'`);
    expect((await db.query(`SELECT 1 FROM ledger_entries WHERE uid = 'alice'`)).rowCount).toBe(0);
  });
});

describe('positions and cash limits', () => {
  it('allows only one open position per player per stock', async () => {
    await signUp('alice');
    await db.query(`INSERT INTO positions (uid, symbol, units) VALUES ('alice', 'TEVA', 10)`);
    await expect(db.query(`INSERT INTO positions (uid, symbol, units) VALUES ('alice', 'TEVA', 5)`)).rejects.toThrow(/duplicate key/);
  });

  it('refuses locking more units than are held (no short selling)', async () => {
    await signUp('alice');
    await expect(db.query(`INSERT INTO positions (uid, symbol, units, reserved_units) VALUES ('alice', 'TEVA', 10, 11)`))
      .rejects.toThrow(/check constraint/);
  });

  it('closes a position only at 0 units', async () => {
    await signUp('alice');
    await expect(db.query(`INSERT INTO positions (uid, symbol, units, status, closed_at) VALUES ('alice', 'TEVA', 1, 'closed', now())`))
      .rejects.toThrow(/check constraint/);
  });

  it('shows open positions through the old holdings name', async () => {
    await signUp('alice');
    await db.query(`INSERT INTO positions (uid, symbol, units) VALUES ('alice', 'TEVA', 10)`);
    const { rows } = await db.query(`SELECT uid, symbol, units::float8 FROM holdings`);
    expect(rows).toEqual([{ uid: 'alice', symbol: 'TEVA', units: 10 }]);
  });

  it('refuses locking more cash than the player has (no leverage)', async () => {
    await signUp('alice');
    await expect(db.query(`UPDATE portfolios SET reserved_cash = 1000000.01 WHERE uid = 'alice'`)).rejects.toThrow(/check constraint/);
    await db.query(`UPDATE portfolios SET reserved_cash = 400000 WHERE uid = 'alice'`);
    const { rows } = await db.query(`SELECT available_cash::float8 FROM portfolios WHERE uid = 'alice'`);
    expect(rows[0].available_cash).toBe(600_000);
  });
});

describe('orders', () => {
  const insert = (side: string, amount: number | null, units: number | null) =>
    db.query(
      `INSERT INTO orders (uid, symbol, side, amount_ils, units, placed_at, executes_at, price_type)
       VALUES ('alice', 'TEVA', $1, $2, $3, now(), now(), 'close')`,
      [side, amount, units],
    );

  it('sizes buys in ₪ and sells in units, never the other way', async () => {
    await signUp('alice');
    await insert('buy', 1000, null);
    await insert('sell', null, 5);
    await expect(insert('sell', 1000, null)).rejects.toThrow(/orders_size_check/);
    await expect(insert('buy', null, 5)).rejects.toThrow(/orders_size_check/);
  });

  it('refuses the same client order id twice for one player', async () => {
    await signUp('alice');
    const send = () =>
      db.query(
        `INSERT INTO orders (uid, symbol, side, amount_ils, placed_at, executes_at, price_type, client_order_id)
         VALUES ('alice', 'TEVA', 'buy', 1000, now(), now(), 'close', 'abc-1')`,
      );
    await send();
    await expect(send()).rejects.toThrow(/duplicate key/);
  });

  it('needs a reason to reject and a fill to execute', async () => {
    await signUp('alice');
    await insert('buy', 1000, null);
    // A processed order also names the event that ran it (orders_event_check), so give it one.
    const { rows } = await db.query(
      `INSERT INTO market_events (market, kind, day, at) VALUES ('TASE', 'close', '2026-11-11', '2026-11-11T15:30:00Z') RETURNING id`,
    );
    const event = rows[0].id;
    await expect(db.query(`UPDATE orders SET status = 'rejected', event_id = $1`, [event])).rejects.toThrow(/orders_reject_check/);
    await expect(db.query(`UPDATE orders SET status = 'executed', event_id = $1`, [event])).rejects.toThrow(/orders_fill_check/);
  });
});
