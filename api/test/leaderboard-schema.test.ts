// The leaderboard migration (20261110172700000_leaderboard.sql) against a real Postgres (TEST_DATABASE_URL).
// The database rules here hold even if the scoring mechanism (Phase 4b) has a bug: one player per place per day
// or week (D-032), Monday weeks, no negative drawdown, and a deleted player's rows go with them.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

const db = new pg.Pool({ connectionString: DATABASE_URL });

const TUE = '2026-11-10';
const MON = '2026-11-09';

beforeAll(async () => {
  await runner({ databaseUrl: DATABASE_URL, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
});

beforeEach(async () => {
  await db.query('TRUNCATE users, securities, usd_ils, world_clock, market_events CASCADE');
  await db.query(`INSERT INTO users (uid, email) VALUES ('alice', 'alice@example.com'), ('bob', 'bob@example.com')`);
});

afterAll(async () => {
  await db.end();
});

const standing = (uid: string, rank: number, day = TUE) =>
  db.query(
    `INSERT INTO standings (day, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
     VALUES ($1, $2, 1, 0.5, 50, 50, 50, $3)`,
    [day, uid, rank],
  );

const weekly = (uid: string, rank: number, opts: { week?: string; drawdown?: number } = {}) =>
  db.query(
    `INSERT INTO weekly_scores (week_start, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
     VALUES ($1, $2, 1, $3, 50, 50, 50, $4)`,
    [opts.week ?? MON, uid, opts.drawdown ?? 0.5, rank],
  );

describe('standings: one player per place per day', () => {
  it('refuses a second player on the same place of a day', async () => {
    await standing('alice', 1);
    await expect(standing('bob', 1)).rejects.toThrow(/standings_day_rank_key/);
    await standing('bob', 1, MON);   // the same place on another day is fine
  });

  it('lets one UPDATE swap two places (the constraint is checked at the end of the statement)', async () => {
    await standing('alice', 1);
    await standing('bob', 2);
    await db.query(`UPDATE standings SET rank = 3 - rank WHERE day = $1`, [TUE]);
    const { rows } = await db.query(`SELECT uid, rank FROM standings WHERE day = $1 ORDER BY rank`, [TUE]);
    expect(rows).toEqual([{ uid: 'bob', rank: 1 }, { uid: 'alice', rank: 2 }]);
  });

  it('has the indexes the reads use: (day, rank) unique and (uid, day)', async () => {
    const { rows } = await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'standings' ORDER BY indexname`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(['standings_day_rank_key', 'standings_pkey', 'standings_uid_day_idx']);
    expect(rows.find((r) => r.indexname === 'standings_uid_day_idx')!.indexdef).toMatch(/\(uid, day\)/);
  });
});

describe('weekly_scores: each closed week\'s final board', () => {
  it('takes only a Monday as the week', async () => {
    await weekly('alice', 1);
    await expect(weekly('bob', 1, { week: TUE })).rejects.toThrow(/weekly_scores_week_start_check/);
    await expect(weekly('bob', 1, { week: '2026-11-08' })).rejects.toThrow(/weekly_scores_week_start_check/);   // a Sunday
  });

  it('refuses a second player on the same place of a week', async () => {
    await weekly('alice', 1);
    await expect(weekly('bob', 1)).rejects.toThrow(/weekly_scores_week_rank_key/);
    await weekly('bob', 1, { week: '2026-11-02' });   // the same place in another week is fine
  });

  it('refuses the same player twice in a week', async () => {
    await weekly('alice', 1);
    await expect(weekly('alice', 2)).rejects.toThrow(/weekly_scores_pkey/);
  });

  it('refuses a negative drawdown and a place below 1', async () => {
    await expect(weekly('alice', 1, { drawdown: -0.01 })).rejects.toThrow(/weekly_scores_max_drawdown_pct_check/);
    await expect(weekly('alice', 0)).rejects.toThrow(/weekly_scores_rank_check/);
  });

  it('goes with the player when the user is deleted', async () => {
    await weekly('alice', 1);
    await weekly('bob', 2);
    await weekly('alice', 1, { week: '2026-11-02' });
    await db.query(`DELETE FROM users WHERE uid = 'alice'`);
    const { rows } = await db.query(`SELECT uid, week_start::text AS week FROM weekly_scores ORDER BY week_start`);
    expect(rows).toEqual([{ uid: 'bob', week: MON }]);
  });
});
