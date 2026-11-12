// Fills the leaderboard with SAMPLE DATA for development (D-033): a full board on a local database with few
// players and no trades. It was written before the scoring mechanism existed.
//
// THIS IS NOT THE SCORING MECHANISM. The numbers are a seeded random walk (api/src/sampleBoard.ts), not anyone's
// portfolio. The runner's scoring step writes the real places into the same tables (scoreEvent, D-034).
//
//   cd api && npm run seed:sample-board              write the sample board
//   cd api && npm run seed:sample-board -- --clear   remove it: the sample rows and the 40 sample users
//   cd api && npm run seed:sample-board -- --force   also write over days that hold rows it didn't write, and
//                                                    into a database with more than 1,000 players
//
// What it writes, in one transaction:
//   - 40 sample users, 'sample-01'..'sample-40': users rows only. No portfolio and no journal (the ledger is
//     append-only), so they can always be deleted.
//   - standings: every player's row on each trading day of the world's current week, Monday to today
//     (on Sat/Sun, Monday to Friday)
//   - weekly_scores: the final board of the 4 weeks before it, and of this week once its last event has passed
// The players are the 40 samples plus every real user in the database, so you see yourself on the board.
//
// Safe to run again: each day and week it writes is deleted and written again, with the same numbers. Older
// sample days and weeks are removed. A day or week that holds rows but none of the samples' was written by
// something else (a real scoring run): the script refuses it unless --force.
//
// Safety: only a database on localhost or 127.0.0.1, never portfolio_test, never with NODE_ENV=production, and
// (unless --force) never one with more than 1,000 players: a port forward to a real database is on localhost too.
// Reads DATABASE_URL from the environment or api/.env. A variable already set wins over the file (Node's
// --env-file), so `DATABASE_URL=postgres://...localhost.../other npm run seed:sample-board` uses `other`.

import pg from 'pg';
import { ANONYMOUS_NAME, loadNow } from '../src/dashboard.js';
import { eventsBetween, isTradingDay } from '../src/game/clock.js';
import { format } from '../src/game/fixed.js';
import { addDays, ISRAEL, zonedToInstant } from '../src/game/time.js';
import {
  checkPlayers,
  checkTarget,
  MAX_DEV_PLAYERS,
  parseArgs,
  planBoard,
  type Ranked,
  SAMPLE_CREATED_AT,
  SAMPLE_NAMES,
  SAMPLE_UIDS,
  sampleEmail,
  sampleWeekBoards,
} from '../src/sampleBoard.js';
import { clearSamples } from './sample-clear.js';

type Db = pg.PoolClient;

const USAGE = 'Usage: npm run seed:sample-board [-- --clear | -- --force]';
const BANNER = 'SAMPLE BOARD for development (D-033). Made-up numbers, NOT the scoring mechanism (D-034).';
const SAMPLES = [...SAMPLE_UIDS];

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) {
    console.error(`${args.error}\n${USAGE}`);
    return 1;
  }
  const check = checkTarget({ databaseUrl: process.env.DATABASE_URL, nodeEnv: process.env.NODE_ENV });
  if (!check.ok) {
    console.error(`Refusing to run: ${check.reason}`);
    return 1;
  }
  console.log(BANNER);
  console.log(`Database: ${check.target.database} on ${check.target.host}`);

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    return args.clear ? await clear(pool) : await seed(pool, args.force);
  } finally {
    await pool.end();
  }
}

// ---------- write ----------

async function seed(pool: pg.Pool, force: boolean): Promise<number> {
  const now = await loadNow(pool);
  if (!now) {
    console.error('Refusing to run: there is no world clock row. Run `npm run seed:world` first.');
    return 1;
  }
  // The week is over when no open or close is left before Saturday 00:00 (Israel time).
  const weekEnd = zonedToInstant(addDays(now.monday, 5), 0, ISRAEL);
  const weekClosed = eventsBetween(now.at, weekEnd, now.calendar).length === 0;
  const plan = planBoard(now.today, weekClosed, (d) => isTradingDay(d, now.calendar));
  const weeks = plan.finalWeeks.map((w) => w.start);
  console.log(`World today: ${now.today} (week of ${plan.monday}${weekClosed ? ', closed' : ''})`);
  if (plan.days.length === 0) console.log('No trading day of this week has started yet: no standings days to write.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Counted only up to the limit: the check needs "more than", not the total.
    const counted = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM (SELECT 1 FROM users WHERE uid <> ALL($1::text[]) LIMIT $2) x',
      [SAMPLES, MAX_DEV_PLAYERS + 1],
    );
    const tooBig = checkPlayers(counted.rows[0].n, force);
    if (tooBig) {
      await client.query('ROLLBACK');
      console.error(`Refusing to run: ${tooBig}`);
      return 1;
    }

    // The samples play a real game (npm run seed:sample-game, D-038): the runner's scoring writes their board, and
    // every day it wrote has sample rows, so the check below would take those days for this script's own.
    const playing = await client.query<{ yes: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM orders WHERE uid = ANY($1::text[])) AS yes',
      [SAMPLES],
    );
    if (playing.rows[0].yes) {
      await client.query('ROLLBACK');
      console.error(
        'Refusing to run: the sample players have orders (npm run seed:sample-game, D-038), so their board is the real ' +
          'scoring. Remove the sample game first with -- --clear.',
      );
      return 1;
    }

    const foreign = await foreignDays(client, plan.days, weeks);
    if (foreign.length > 0 && !force) {
      await client.query('ROLLBACK');
      console.error(
        `Refusing to run: these days hold rows the sample board didn't write (a real scoring run?):\n  ${foreign.join('\n  ')}\n` +
          'Run again with -- --force to replace them.',
      );
      return 1;
    }
    if (foreign.length > 0) console.log(`--force: replacing rows the sample board didn't write: ${foreign.join(', ')}`);

    await client.query(
      `INSERT INTO users (uid, email, display_name, created_at)
       SELECT u, e, n, $4::timestamptz FROM unnest($1::text[], $2::text[], $3::text[]) AS t(u, e, n)
       ON CONFLICT (uid) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name`,
      [SAMPLES, SAMPLES.map(sampleEmail), [...SAMPLE_NAMES], SAMPLE_CREATED_AT],
    );
    const real = await client.query<{ uid: string; display_name: string | null }>(
      'SELECT uid, display_name FROM users WHERE uid <> ALL($1::text[]) ORDER BY uid',
      [SAMPLES],
    );
    const uids = [...SAMPLES, ...real.rows.map((r) => r.uid)];
    const names = new Map<string, string | null>([
      ...SAMPLES.map((uid, i) => [uid, SAMPLE_NAMES[i]] as const),
      ...real.rows.map((r) => [r.uid, r.display_name] as const),
    ]);
    const nameOf = (uid: string) => names.get(uid) ?? ANONYMOUS_NAME;
    console.log(`Players: ${SAMPLES.length} samples + ${real.rows.length} real`);

    // ----- standings: the current week, Monday to today -----
    const boards = sampleWeekBoards(uids, plan.monday, plan.weekDays.length);
    const days = plan.days.map((day, i) => ({ day, board: boards[i] }));   // days is the start of weekDays
    await client.query('DELETE FROM standings WHERE day = ANY($1::date[])', [plan.days]);
    const staleDays = await client.query(
      'DELETE FROM standings WHERE day IN (SELECT day FROM standings WHERE uid = ANY($1::text[]))',
      [SAMPLES],
    );
    const st = columns(days.flatMap(({ day, board }) => board.map((r) => ({ key: day, r }))));
    await client.query(
      `INSERT INTO standings (day, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
       SELECT * FROM unnest($1::date[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[],
                            $7::numeric[], $8::int[])`,
      st,
    );

    // ----- weekly_scores: final boards, each a copy of its week's last trading day -----
    const finals = plan.finalWeeks.map((w) => ({
      start: w.start,
      board: sampleWeekBoards(uids, w.start, w.days.length).at(-1)!,
    }));
    await client.query('DELETE FROM weekly_scores WHERE week_start = ANY($1::date[])', [weeks]);
    const staleWeeks = await client.query(
      'DELETE FROM weekly_scores WHERE week_start IN (SELECT week_start FROM weekly_scores WHERE uid = ANY($1::text[]))',
      [SAMPLES],
    );
    const ws = columns(finals.flatMap(({ start, board }) => board.map((r) => ({ key: start, r }))));
    await client.query(
      `INSERT INTO weekly_scores (week_start, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
       SELECT * FROM unnest($1::date[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[],
                            $7::numeric[], $8::int[])`,
      ws,
    );

    await client.query('COMMIT');
    // New days the planner has no statistics for would turn the board's (uid, day) probes into whole-day scans
    // until autoanalyze runs (SCHEMA.md, standings): the same step the real scoring takes after a new day (D-034).
    await client.query('ANALYZE standings, weekly_scores').catch((err: unknown) => {
      console.warn('ANALYZE standings, weekly_scores failed (the rows are written; autoanalyze catches up):', err);
    });

    // ----- what it did -----
    for (const { day, board } of days) console.log(`standings ${day}: ${board.length} players, ${leader(board, nameOf)}`);
    for (const { start, board } of finals) {
      console.log(`weekly_scores week of ${start}: ${board.length} players, ${leader(board, nameOf)}`);
    }
    if (staleDays.rowCount || staleWeeks.rowCount) {
      console.log(`Removed older sample rows: ${staleDays.rowCount ?? 0} standings, ${staleWeeks.rowCount ?? 0} weekly_scores`);
    }
    const last = days.at(-1)?.board;
    for (const r of real.rows) {
      const mine = last?.find((x) => x.uid === r.uid);
      if (mine) console.log(`Real player ${r.display_name ?? r.uid}: #${mine.rank} of ${last!.length} on ${days.at(-1)!.day}`);
    }
    console.log('SAMPLE DATA. Remove it with: npm run seed:sample-board -- --clear');
    return 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Days and weeks among those about to be written that hold rows but none of a sample player: written by
// something else (the scoring mechanism), so not the script's to replace without --force.
async function foreignDays(db: Db, days: string[], weeks: string[]): Promise<string[]> {
  const { rows } = await db.query<{ what: string }>(
    `SELECT 'standings ' || day::text AS what FROM standings WHERE day = ANY($1::date[])
     GROUP BY day HAVING NOT bool_or(uid = ANY($3::text[]))
     UNION ALL
     SELECT 'weekly_scores ' || week_start::text FROM weekly_scores WHERE week_start = ANY($2::date[])
     GROUP BY week_start HAVING NOT bool_or(uid = ANY($3::text[]))
     ORDER BY 1`,
    [days, weeks, SAMPLES],
  );
  return rows.map((r) => r.what);
}

// The rows as the eight column arrays of the INSERTs above. Numbers become NUMERIC text at their scale.
function columns(rows: { key: string; r: Ranked }[]): unknown[] {
  return [
    rows.map((x) => x.key),
    rows.map((x) => x.r.uid),
    rows.map((x) => format(BigInt(x.r.ret), 4)),
    rows.map((x) => format(BigInt(x.r.dd), 4)),
    rows.map((x) => format(BigInt(x.r.returnRank), 2)),
    rows.map((x) => format(BigInt(x.r.stabilityRank), 2)),
    rows.map((x) => format(BigInt(x.r.score), 2)),
    rows.map((x) => x.r.rank),
  ];
}

function leader(board: Ranked[], nameOf: (uid: string) => string): string {
  const top = board[0];
  return top ? `#1 ${nameOf(top.uid)} (score ${format(BigInt(top.score), 2)}, ${format(BigInt(top.ret), 4)}%)` : 'empty';
}

// ---------- clear ----------

// Every standings day and weekly_scores week a sample player has a row in, then the sample users (sample-clear.ts,
// shared with the sample game's --clear).
async function clear(pool: pg.Pool): Promise<number> {
  await clearSamples(pool);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
