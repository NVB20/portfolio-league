// The scoring step (D-034): at every market open and close, rank every player who is competing this week and
// write that day of the live board (`standings`, D-032). At the week's last event the day is also copied to the
// week's final board (`weekly_scores`). The runner calls it inside its finish transaction (runner.ts,
// finishEvent), with the median and the event's 'done', so a day is always replaced whole, and a crash before the
// commit leaves the event 'orders_done' for the next run to score again.
//
// game/score.ts is the same rule in pure TypeScript: the spec, and the oracle the tests compare this SQL with.
// This is the production path: set-based SQL, one statement per step, nothing per player in JavaScript. Its cost
// is one pass over the portfolios and a few sorts of the ranked players, at any size. The runner's connection
// allows each statement 5 minutes (D-029).

import type { PoolClient } from 'pg';
import { RETURN_WEIGHT, STABILITY_WEIGHT } from './game/score.js';
import { mondayOf } from './game/time.js';
import { weekOf } from './game/week.js';

export type ScoringInput = {
  day: string;        // the event's Israel date: the standings day written
  at: Date;           // the event's instant: its week is weekOf(at)
  weekEnds: boolean;  // the week's last event (isLastEventOfWeek): also write the week's final board
};

export type ScoringResult = {
  players: number;          // N, the players ranked (the day's rows, places 1..N)
  newDay: boolean;          // the day had no rows before and has rows now: the planner has never seen it
  weekWritten: boolean;     // weekly_scores rows were written (this week's, or an earlier week's left without)
  closedWeeks: string[];    // earlier weeks whose final board was written here from their last scored day
};

// Who is ranked at an event of week $2 (game/score.ts isRanked): week_start is this week, or the player holds an
// open position now. One place, used by the ranking and by the guard on the day's delete.
const RANKED_WHERE = `p.week_start = $2::date
       OR EXISTS (SELECT 1 FROM positions x WHERE x.uid = p.uid AND x.status = 'open')`;

// Ranks the event's players and writes the board. Runs inside the caller's transaction; it never commits.
export async function scoreEvent(client: PoolClient, input: ScoringInput): Promise<ScoringResult> {
  const week = weekOf(input.at);

  // 1. The day: deleted and written again whole, so places run 1..N without gaps (a deleted player's gap goes
  //    too). standings_day_rank_key is DEFERRABLE, so it can't be an ON CONFLICT arbiter; and a delete of the
  //    earlier statement never collides with this insert.
  //    Not while nobody is ranked: the day keeps what it holds (a D-033 sample day on a database with no trades).
  //    It can't hold real rows then: within a week the ranked set only grows, except through user deletes, and
  //    those cascade to their rows.
  const deleted = await client.query(
    `DELETE FROM standings WHERE day = $1::date AND EXISTS (SELECT 1 FROM portfolios p WHERE ${RANKED_WHERE})`,
    [input.day, week],
  );
  const { rows } = await client.query<{ n: number }>(RANK_SQL, [input.day, week, Number(RETURN_WEIGHT), Number(STABILITY_WEIGHT)]);
  const players = rows[0].n;
  const newDay = players > 0 && (deleted.rowCount ?? 0) === 0;

  // 2. A new week's first scoring: the weeks before it get their final board if they have none, and their days go.
  //    Not while nobody is ranked this week: the board keeps showing the closed week until someone is (D-032).
  const closedWeeks = players > 0 ? await closeEarlierWeeks(client, week) : [];

  // 3. This week's final board. Only the week's last event writes it. Any other event of the week removes one
  //    already there (normally none): it was written by an event that is no longer the week's last (the world's
  //    end moved later), and a final board would mark a live week as closed (loadBoard's `final`).
  await client.query('DELETE FROM weekly_scores WHERE week_start = $1::date', [week]);
  if (input.weekEnds) await copyDayToWeek(client, input.day, week);

  return { players, newDay, weekWritten: input.weekEnds || closedWeeks.length > 0, closedWeeks };
}

// The ranking, in one statement (game/score.ts, line for line):
//   ranked  isRanked: week_start is this week, or the player holds an open position. weekNumbers: the return in
//           0.0001 % units, round_half_away(10^6 × (equity − week_start_value) / week_start_value) with the
//           exact numeric div(), as medians() in runner.ts; 0 / 0 for a row whose totals are another week's
//   pct     N, and each player's rank() by return (high first) and by drawdown (low first). N − rank() = the
//           OTHER players with a return ≤ mine (a drawdown ≥ mine): ties share the higher percentile
//   ranks   percentile: round_half_away(10000 × k / (N − 1)) in 0.01 units, exact in integers (k ≥ 0, so half
//           up is (2a + b) / 2b); 10000 (100.00) when N = 1
//   scored  scoreOf: round_half_away((85 × rr + 15 × sr) / 100) from the rounded ranks, the same way
//   insert  the place: row_number() by score, % return, the smaller drawdown, the earlier sign-up, the uid in
//           byte order (COLLATE "C", as compareBytes): unique, 1..N
// Only the count comes back to Node.
const RANK_SQL = `
  WITH ranked AS (
    SELECT p.uid, u.created_at,
           CASE WHEN p.week_start = $2::date AND p.week_start_value > 0
                THEN sign(p.equity - p.week_start_value)
                     * div(2000000 * abs(p.equity - p.week_start_value) + p.week_start_value, 2 * p.week_start_value)
                ELSE 0 END AS r,
           CASE WHEN p.week_start = $2::date THEN p.max_drawdown_pct ELSE 0 END AS dd
    FROM portfolios p
    JOIN users u ON u.uid = p.uid
    WHERE ${RANKED_WHERE}
  ),
  pct AS (
    SELECT uid, created_at, r, dd,
           count(*) OVER () AS n,
           rank() OVER (ORDER BY r DESC) AS r_place,
           rank() OVER (ORDER BY dd ASC) AS dd_place
    FROM ranked
  ),
  ranks AS (
    SELECT uid, created_at, r, dd,
           CASE WHEN n = 1 THEN 10000 ELSE (20000 * (n - r_place) + (n - 1)) / (2 * (n - 1)) END AS rr,
           CASE WHEN n = 1 THEN 10000 ELSE (20000 * (n - dd_place) + (n - 1)) / (2 * (n - 1)) END AS sr
    FROM pct
  ),
  scored AS (
    SELECT uid, created_at, r, dd, rr, sr,
           (2 * ($3::int * rr + $4::int * sr) + ($3::int + $4::int)) / (2 * ($3::int + $4::int)) AS sc
    FROM ranks
  ),
  written AS (
    INSERT INTO standings (day, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
    SELECT $1::date, uid, r * 0.0001, dd, rr * 0.01, sr * 0.01, sc * 0.01,
           row_number() OVER (ORDER BY sc DESC, r DESC, dd ASC, created_at ASC, uid COLLATE "C" ASC)
    FROM scored
    RETURNING 1
  )
  SELECT count(*)::int AS n FROM written`;

// Every earlier week that still has standings days: written to weekly_scores from its LAST scored day when it
// has no final board (its last event never wrote one: the calendar changed after it, or the world stopped),
// then all of those days are deleted. Returns the weeks whose final board was written here. The days are found
// by backward probes of standings_pkey (day, uid), one per day: there are a handful, and nothing scans them.
async function closeEarlierWeeks(client: PoolClient, week: string): Promise<string[]> {
  const days: string[] = [];   // newest first
  for (let before = week; ;) {
    const { rows } = await client.query<{ day: string | null }>(
      'SELECT max(day)::text AS day FROM standings WHERE day < $1::date',
      [before],
    );
    const day = rows[0].day;
    if (day === null) break;
    days.push(day);
    before = day;
  }
  if (days.length === 0) return [];

  const lastDay = new Map<string, string>();   // week → its last scored day (the first one met, newest first)
  for (const day of days) if (!lastDay.has(mondayOf(day))) lastDay.set(mondayOf(day), day);
  const closed: string[] = [];
  for (const [w, day] of lastDay) {
    const res = await client.query(
      `INSERT INTO weekly_scores (week_start, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
       SELECT $1::date, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank
       FROM standings
       WHERE day = $2::date AND (SELECT max(rank) FROM weekly_scores WHERE week_start = $1::date) IS NULL`,
      [w, day],
    );
    if ((res.rowCount ?? 0) > 0) closed.push(w);
  }
  await client.query('DELETE FROM standings WHERE day < $1::date', [week]);
  return closed;
}

// The week's final board: an exact copy of the day's standings rows just written.
async function copyDayToWeek(client: PoolClient, day: string, week: string): Promise<void> {
  await client.query(
    `INSERT INTO weekly_scores (week_start, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
     SELECT $1::date, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank
     FROM standings WHERE day = $2::date`,
    [week, day],
  );
}

// After the transaction commits: fresh planner statistics for a new day (and week). The board's reads are
// index lookups only when the planner knows the newest day; until autoanalyze runs, a day it has never seen is
// estimated at 1 row and "my row" becomes a scan of the whole day (D-032). A failure is logged, never thrown:
// the event is already done, and autoanalyze catches up later.
// Only after a new day or weekly rows, not after a rewrite of a day the planner already knows (its statistics
// still hold: the same day, about as many rows). ANALYZE waits for a running autovacuum of the table and then
// cancels it (after deadlock_timeout, 1 s), so running it at every event of back-to-back events (an admin jump, a
// catch-up) kept standings from ever being vacuumed (measured at 200,000 players: 3 million dead rows after four
// days, and rewrites 40% slower). Autoanalyze still runs on its own after rewrites.
export async function analyzeBoard(client: PoolClient, result: Pick<ScoringResult, 'newDay' | 'weekWritten'>): Promise<void> {
  if (!result.newDay && !result.weekWritten) return;
  try {
    // weekWritten alone (the week's last event rewriting its day): standings too, once a week.
    await client.query(result.weekWritten ? 'ANALYZE standings, weekly_scores' : 'ANALYZE standings');
  } catch (err) {
    console.error('scoring: ANALYZE of the board failed', err instanceof Error ? err.message : err);
  }
}
