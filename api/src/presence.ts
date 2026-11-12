// Presence (D-026): who has the app open, and how many visits each player makes per day.
// The app calls POST /me/seen when it opens and about once a minute while it stays open and visible.
// Everything here is REAL time (Postgres now()), never world time.
//
// The server decides what counts, so a client can't inflate the numbers:
//   - online      = checked in during the last ONLINE_MINUTES
//   - a new visit = a check-in after more than VISIT_GAP_MINUTES away, or the very first one
//   - check-ins closer together than MIN_WRITE_SECONDS don't move last_seen_at or start a visit
// The same locked row also counts the daily streak (D-039): the first check-in of each real Israel day counts that
// day, even one under MIN_WRITE_SECONDS after the last (a check-in just before midnight and one just after).

import type { Pool } from 'pg';
import { countToday, STREAK_COLUMNS, type StreakRow } from './streak.js';

export const ONLINE_MINUTES = 2;
export const VISIT_GAP_MINUTES = 30;
export const MIN_WRITE_SECONDS = 30;

// Returns null when the user has no row yet (POST /me was never called).
export async function recordSeen(db: Pool, uid: string): Promise<{ newVisit: boolean } | null> {
  const client = await db.connect();
  try {
    // One transaction with the row locked, so two check-ins at the same moment can't both start a visit.
    // now() is the transaction's start time, so every comparison below uses the same instant.
    // FOR NO KEY UPDATE, not FOR UPDATE: only last_seen_at changes, never the key. The runner's scoring holds
    // FOR KEY SHARE on the users row of every ranked player (the standings and weekly_scores foreign keys) until
    // it commits (D-034), and FOR UPDATE would wait behind it, holding a pool connection the whole time. Two
    // check-ins of the same player still wait for each other, so a visit is counted once.
    await client.query('BEGIN');
    const { rows } = await client.query<{ fresh: boolean | null; new_visit: boolean } & StreakRow>(
      `SELECT last_seen_at > now() - make_interval(secs => $2) AS fresh,
              last_seen_at IS NULL OR last_seen_at < now() - make_interval(mins => $3) AS new_visit,
              ${STREAK_COLUMNS}
       FROM users WHERE uid = $1 FOR NO KEY UPDATE`,
      [uid, MIN_WRITE_SECONDS, VISIT_GAP_MINUTES],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const { fresh, new_visit } = rows[0];   // fresh is NULL (= not fresh) when the user was never seen
    const newVisit = !fresh && new_visit;
    if (!fresh) {
      await client.query('UPDATE users SET last_seen_at = now() WHERE uid = $1', [uid]);
      if (newVisit) await client.query('INSERT INTO app_opens (uid) VALUES ($1)', [uid]);
    }
    await countToday(client, uid, rows[0]);   // writes only on the first check-in of the day
    await client.query('COMMIT');
    return { newVisit };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
