// `--clear` of both sample scripts (D-033, D-038): removes the 40 sample players and everything they did, in one
// transaction. Not a script on its own: seed-sample-board.ts and seed-sample-game.ts import it.
//
// Every standings day and weekly_scores week a sample player has a row in is deleted, with the real players' rows
// on it: on a sample board they are sample numbers too, and in a sample game the places were counted with the
// samples in them. Then the sample users: the delete cascades to their portfolios, orders, stop losses, ledger
// (the one delete the ledger allows, D-019), snapshots, visits and usage totals.

import type pg from 'pg';
import { SAMPLE_UIDS } from '../src/sampleBoard.js';

export async function clearSamples(pool: pg.Pool): Promise<void> {
  const samples = [...SAMPLE_UIDS];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const st = await client.query<{ rows: number; days: number }>(
      `WITH x AS (DELETE FROM standings WHERE day IN (SELECT day FROM standings WHERE uid = ANY($1::text[])) RETURNING day)
       SELECT count(*)::int AS rows, count(DISTINCT day)::int AS days FROM x`,
      [samples],
    );
    const ws = await client.query<{ rows: number; weeks: number }>(
      `WITH x AS (DELETE FROM weekly_scores
                  WHERE week_start IN (SELECT week_start FROM weekly_scores WHERE uid = ANY($1::text[]))
                  RETURNING week_start)
       SELECT count(*)::int AS rows, count(DISTINCT week_start)::int AS weeks FROM x`,
      [samples],
    );
    const orders = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM orders WHERE uid = ANY($1::text[])', [samples]);
    const users = await client.query('DELETE FROM users WHERE uid = ANY($1::text[])', [samples]);
    await client.query('COMMIT');
    console.log(`Removed ${st.rows[0].rows} standings rows on ${st.rows[0].days} days`);
    console.log(`Removed ${ws.rows[0].rows} weekly_scores rows in ${ws.rows[0].weeks} weeks`);
    console.log(`Removed ${users.rowCount ?? 0} sample users, with their ${orders.rows[0].n} orders, ledger, visits and usage`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
