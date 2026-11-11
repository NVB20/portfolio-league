// GET /me/leaderboard against a real Postgres (TEST_DATABASE_URL, default: the local Docker database). The rows
// inserted below are TEST fixtures standing in for what the scoring step (D-034, scoring.ts) writes; the API only
// reads them (D-032). The scoring itself is tested in scoring.test.ts.
//
// The seeded world: the clock is Wednesday 2026-11-11, 12:40 Israel (10:40 UTC), in the week of Monday 2026-11-09.
// Scored days this week: Monday (24 players) and Tuesday (25 players). So the board shown is Tuesday's, the
// previous scored day is Monday, and the week is still live (not final). Last Friday has a row too: it belongs to
// the week before and must never count as "the previous day".
//
// The 25 players are p01..p25 ("Player 1".."Player 25"; p02 has no display name).
//   Tuesday:  p<g> is place g, score 100 − 2g, return (26 − g)/10 %, drawdown g/10 %, return rank 100 − 3g,
//             stability rank 100 − g.
//   Monday:   p01..p24 only (p25 joined on Tuesday): p<g> is place 25 − g, score 50 + g.
//   So the rank change since Monday is (25 − g) − g = 25 − 2g: p01 +23, p13 −1, p24 −23, p25 none.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { getDashboard } from '../src/dashboard.js';
import { avatarIndex, getLeaderboard } from '../src/leaderboard.js';
import { upsertUser } from '../src/users.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

const db = new pg.Pool({ connectionString: DATABASE_URL });
let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;

const WED_1240 = '2026-11-11T10:40:00Z';   // Wednesday 12:40 Israel
const MON = '2026-11-09';
const TUE = '2026-11-10';
const LIVE_WEEK = { start: MON, day: TUE, final: false };

beforeAll(async () => {
  await runner({ databaseUrl: DATABASE_URL, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
  const test = await makeTestKeys();
  privateKey = test.privateKey;
  app = createApp({ db, verifyToken: makeFirebaseVerifier(PROJECT_ID, test.keys), corsOrigins: [] });
});

beforeEach(async () => {
  // standings and weekly_scores cascade from users.
  await db.query('TRUNCATE users, securities, usd_ils, world_clock, market_events CASCADE');
});

afterAll(async () => {
  await db.end();
});

async function call(method: string, path: string, uid: string, opts: { claims?: Record<string, unknown> } = {}) {
  const token = await signToken(privateKey, uid, { claims: opts.claims ?? {} });
  return app.request(path, { method, headers: { Authorization: `Bearer ${token}` } });
}

async function board(uid: string, query = '') {
  const res = await call('GET', `/me/leaderboard${query}`, uid);
  expect(res.status).toBe(200);
  return res.json();
}

const pid = (g: number) => `p${String(g).padStart(2, '0')}`;

// p01..p<n>, as POST /me would leave them (the leaderboard only needs the users row).
async function addPlayers(n: number) {
  await db.query(
    `INSERT INTO users (uid, email, display_name)
     SELECT 'p' || lpad(g::text, 2, '0'), 'p' || lpad(g::text, 2, '0') || '@example.com',
            CASE WHEN g = 2 THEN NULL ELSE 'Player ' || g END
     FROM generate_series(1, $1::int) g`,
    [n],
  );
}

async function seedWeek() {
  await addPlayers(25);
  await db.query(`INSERT INTO world_clock (now_at) VALUES ($1)`, [WED_1240]);
  await db.query(
    `INSERT INTO standings (day, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
     SELECT $1::date, 'p' || lpad(g::text, 2, '0'), (26 - g) / 10.0, g / 10.0, 100 - 3 * g, 100 - g, 100 - 2 * g, g
     FROM generate_series(1, 25) g`,
    [TUE],
  );
  await db.query(
    `INSERT INTO standings (day, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
     SELECT $1::date, 'p' || lpad(g::text, 2, '0'), 0, 0, 50, 50, 50 + g, 25 - g
     FROM generate_series(1, 24) g`,
    [MON],
  );
  // Last Friday: the week before. Not this week's "previous day", and not one of this week's days.
  await db.query(
    `INSERT INTO standings (day, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
     SELECT '2026-11-06', 'p' || lpad(g::text, 2, '0'), 0, 0, 50, 50, 10, g FROM generate_series(1, 25) g`,
  );
}

// The Tuesday row of p<g> as the table shows it.
function tuesdayRow(g: number, me: number) {
  return {
    rank: g,
    name: g === 2 ? 'שחקן' : `Player ${g}`,
    returnPct: (26 - g) / 10,
    score: 100 - 2 * g,
    isMe: g === me,
    avatar: avatarIndex(pid(g)),
    maxDrawdownPct: g / 10,
    returnRank: 100 - 3 * g,
    stabilityRank: 100 - g,
    rankChange: g === 25 ? null : 25 - 2 * g,
    days: [g === 25 ? null : 50 + g, 100 - 2 * g, null, null, null],
  };
}

const ranks = (rows: { rank: number }[]) => rows.map((r) => r.rank);
const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

// The test pool, except that a connection taken for a snapshot commits `write` on ANOTHER connection right after
// its first statement matching `after`: the way a scoring run (Phase 4b) can commit between two reads of one request.
function racingPool(after: RegExp, write: string): pg.Pool {
  let fired = false;
  const connect = async () => {
    const client = await db.connect();
    return {
      query: async (text: string, values?: unknown[]) => {
        const result = await client.query(text, values);
        if (!fired && after.test(text)) {
          fired = true;
          await db.query(write);
        }
        return result;
      },
      release: (err?: Error | boolean) => client.release(err),
    };
  };
  return { query: db.query.bind(db), connect } as unknown as pg.Pool;
}

describe('GET /me/leaderboard: access and the query', () => {
  it('returns 401 without a token', async () => {
    expect((await app.request('/me/leaderboard')).status).toBe(401);
  });

  it('returns 404 before POST /me', async () => {
    const res = await call('GET', '/me/leaderboard', 'ghost');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'user not found, call POST /me first' });
  });

  it('refuses a bad view or from with 400', async () => {
    await call('POST', '/me', 'alice');
    for (const query of ['?view=x', '?view=', '?view=TOP', '?from=0', '?from=-1', '?from=1.5', '?from=abc', '?from=1e3',
      '?from=', '?from=01', '?from=99999999999', '?from=1000000000', '?view=around&from=0']) {
      const res = await call('GET', `/me/leaderboard${query}`, 'alice');
      expect(res.status, query).toBe(400);
      expect(typeof (await res.json()).error, query).toBe('string');
    }
    // The biggest place allowed is fine (an empty page).
    expect((await call('GET', '/me/leaderboard?from=999999999', 'alice')).status).toBe(200);
  });
});

describe('GET /me/leaderboard: before anything is scored', () => {
  const EMPTY = { week: null, players: 0, me: null, podium: [], view: 'top', rows: [], from: 1, hasMore: false, pastWeeks: [],
    scoredAt: null, behind: false };

  it('is empty when the world has not started, and still lists my past weeks', async () => {
    await call('POST', '/me', 'alice');
    expect(await board('alice')).toEqual({ clock: null, ...EMPTY });
    expect(await board('alice', '?view=around')).toEqual({ clock: null, ...EMPTY });   // not on a board: the top view

    await db.query(
      `INSERT INTO weekly_scores (week_start, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
       VALUES ('2026-10-26', 'alice', 1, 0.5, 80, 70, 76, 1), ('2026-11-02', 'alice', 2, 0.5, 90, 70, 82, 1)`,
    );
    expect((await board('alice')).pastWeeks).toEqual([
      { weekStart: '2026-11-02', rank: 1, players: 1, score: 82 },
      { weekStart: '2026-10-26', rank: 1, players: 1, score: 76 },
    ]);
  });

  it('is empty when the world runs but no day up to today is scored', async () => {
    await call('POST', '/me', 'alice');
    await db.query(`INSERT INTO world_clock (now_at) VALUES ($1)`, [WED_1240]);
    const { clock, ...rest } = await board('alice');
    expect(rest).toEqual(EMPTY);
    // The clock comes with the board even when nothing is scored: the top bar and the reload need it.
    expect(clock.date).toBe('2026-11-11');

    // A day after today can't be shown, even if a row exists (it would be the future).
    await db.query(
      `INSERT INTO standings (day, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
       VALUES ('2026-11-12', 'alice', 1, 0, 100, 100, 100, 1)`,
    );
    expect(await board('alice')).toEqual({ ...EMPTY, clock: expect.objectContaining({ date: '2026-11-11' }) });
  });
});

describe('GET /me/leaderboard: a live week', () => {
  beforeEach(seedWeek);

  it('shows the top 20 from place 1, the podium and my place card', async () => {
    const b = await board('p13');
    expect(b.week).toEqual(LIVE_WEEK);
    expect(b.players).toBe(25);
    expect(b.view).toBe('top');
    expect(b.from).toBe(1);
    expect(b.hasMore).toBe(true);
    expect(b.rows).toEqual(range(1, 20).map((g) => tuesdayRow(g, 13)));
    expect(b.podium).toEqual([tuesdayRow(1, 13), tuesdayRow(2, 13), tuesdayRow(3, 13)]);
    expect(b.me).toEqual({
      rank: 13,
      players: 25,
      score: 74,
      returnRank: 61,
      stabilityRank: 87,
      rankChange: -1,   // place 12 on Monday
      days: [
        { date: MON, weekday: 1, score: 63 },
        { date: TUE, weekday: 2, score: 74 },
      ],
      returnPct: 1.3,
      maxDrawdownPct: 1.3,
      ahead: { rank: 12, score: 76 },
    });
  });

  it('loads more: from=21 gives the last 5, past the end gives nothing', async () => {
    const page2 = await board('p13', '?from=21');
    expect(ranks(page2.rows)).toEqual(range(21, 25));
    expect(page2.from).toBe(21);
    expect(page2.hasMore).toBe(false);
    expect(page2.rows[4]).toEqual(tuesdayRow(25, 13));   // joined Tuesday: no rank change, no Monday score
    expect(ranks(page2.podium)).toEqual([1, 2, 3]);       // the podium doesn't depend on the page

    const past = await board('p13', '?view=top&from=40');
    expect(past.rows).toEqual([]);
    expect(past.from).toBe(1);
    expect(past.hasMore).toBe(false);
    expect(past.players).toBe(25);
    expect(past.me.rank).toBe(13);
  });

  it('shows the places around me, clamped at both ends', async () => {
    const first = await board('p01', '?view=around');
    expect(first.view).toBe('around');
    expect(ranks(first.rows)).toEqual(range(1, 6));
    expect(first.from).toBe(1);
    expect(first.hasMore).toBe(true);
    expect(first.podium).toEqual(first.rows.slice(0, 3));
    expect(first.me).toMatchObject({ rank: 1, rankChange: 23, ahead: null });

    const middle = await board('p13', '?view=around&from=3');   // from is ignored for around
    expect(middle.view).toBe('around');
    expect(ranks(middle.rows)).toEqual(range(8, 18));
    expect(middle.from).toBe(8);
    expect(middle.hasMore).toBe(true);
    expect(middle.rows.filter((r: { isMe: boolean }) => r.isMe).map((r: { rank: number }) => r.rank)).toEqual([13]);
    expect(ranks(middle.podium)).toEqual([1, 2, 3]);

    const last = await board('p25', '?view=around');
    expect(ranks(last.rows)).toEqual(range(20, 25));
    expect(last.from).toBe(20);
    expect(last.hasMore).toBe(false);
    expect(last.me).toMatchObject({ rank: 25, rankChange: null, ahead: { rank: 24, score: 52 } });
    expect(last.me.days).toEqual([{ date: TUE, weekday: 2, score: 50 }]);
  });

  it('gives a player who is not on the board no place card, and the top 20 instead of "around me"', async () => {
    await call('POST', '/me', 'zed', { claims: { name: 'Zed' } });
    const b = await board('zed', '?view=around');
    expect(b.me).toBeNull();
    expect(b.view).toBe('top');
    expect(ranks(b.rows)).toEqual(range(1, 20));
    expect(b.from).toBe(1);
    expect(b.hasMore).toBe(true);
    expect(b.rows.some((r: { isMe: boolean }) => r.isMe)).toBe(false);
    expect(b.players).toBe(25);

    // The fallback is always the top 20 from place 1: `from` is ignored for "around", as documented.
    const withFrom = await board('zed', '?view=around&from=21');
    expect(withFrom.view).toBe('top');
    expect(ranks(withFrom.rows)).toEqual(range(1, 20));
    expect(withFrom.from).toBe(1);
  });

  it('takes the podium by place, also when a place in 1..3 is missing', async () => {
    await db.query(`DELETE FROM users WHERE uid = 'p02'`);   // its rows go with it: place 2 is a gap until the next scoring
    for (const [uid, query] of [['p13', ''], ['p13', '?from=21'], ['p01', '?view=around']]) {
      expect(ranks((await board(uid, query)).podium), `${uid} ${query}`).toEqual([1, 3]);
    }
  });

  it('answers from one snapshot when the scoring re-ranks the day between two reads', async () => {
    // Right after my row is read, p13 and p20 swap places on Tuesday (one UPDATE, committed on another connection).
    const swap = `UPDATE standings SET rank = CASE rank WHEN 13 THEN 20 ELSE 13 END WHERE day = '${TUE}' AND rank IN (13, 20)`;
    const b = await getLeaderboard(racingPool(/ahead\.rank/, swap), 'p13', { view: 'around', from: 1 });
    expect(b?.me?.rank).toBe(13);
    expect(ranks(b?.rows ?? [])).toEqual(range(8, 18));
    expect(b?.rows.filter((r) => r.isMe).map((r) => r.rank)).toEqual([13]);   // my row is in "around me"
    expect((await board('p13')).me.rank).toBe(20);   // the next request sees the new places
  });

  it('answers from one snapshot when the scoring replaces the week right after the board is picked', async () => {
    // The new week's first scoring deletes the closed week's days (SCHEMA.md allows it) right after loadBoard.
    const b = await getLeaderboard(racingPool(/prev_day/, 'DELETE FROM standings'), 'p13', { view: 'top', from: 1 });
    expect(b?.week).toEqual(LIVE_WEEK);
    expect(b?.players).toBe(25);
    expect(b?.me?.rank).toBe(13);
    expect(ranks(b?.rows ?? [])).toEqual(range(1, 20));
    expect((await board('p13')).week).toBeNull();
  });

  it('gives the dashboard its top 5 and my standing from one snapshot', async () => {
    await upsertUser(db, 'p03', 'p03@example.com');   // the dashboard needs a portfolio
    // Right after the top 5 are read, p03 and p04 swap places on Tuesday.
    const swap = `UPDATE standings SET rank = 7 - rank WHERE day = '${TUE}' AND rank IN (3, 4)`;
    const d = await getDashboard(racingPool(/LEFT JOIN standings prev/, swap), 'p03');
    expect(d?.leaderboard.top.find((r) => r.isMe)?.rank).toBe(3);
    expect(d?.standing?.rank).toBe(3);
    expect((await getDashboard(db, 'p03'))?.standing?.rank).toBe(4);
  });

  it('has no rank change on the week\'s first scored day (last Friday is another week)', async () => {
    await db.query(`UPDATE world_clock SET now_at = '2026-11-09T18:00:00Z'`);   // Monday 20:00 Israel
    const b = await board('p13');
    expect(b.week).toEqual({ start: MON, day: MON, final: false });
    expect(b.players).toBe(24);
    expect(b.rows.every((r: { rankChange: number | null }) => r.rankChange === null)).toBe(true);
    expect(b.rows[0]).toMatchObject({ rank: 1, name: 'Player 24', score: 74, days: [74, null, null, null, null] });
    expect(b.me).toMatchObject({ rank: 12, rankChange: null, days: [{ date: MON, weekday: 1, score: 63 }] });
  });

  it('keeps showing the closed week on Monday before the first open (final)', async () => {
    await db.query(`UPDATE world_clock SET now_at = '2026-11-16T07:00:00Z'`);   // the next Monday, 09:00 Israel
    const b = await board('p13');
    expect(b.week).toEqual({ start: MON, day: TUE, final: true });
    expect(b.players).toBe(25);
    expect(b.me).toMatchObject({ rank: 13, rankChange: -1 });
    expect(b.rows).toEqual(range(1, 20).map((g) => tuesdayRow(g, 13)));
  });

  it('marks the week final once its final board (weekly_scores) is written', async () => {
    await db.query(
      `INSERT INTO weekly_scores (week_start, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
       VALUES ($1, 'p01', 2.5, 0.1, 97, 99, 98, 1)`,
      [MON],
    );
    const b = await board('p01');
    expect(b.week).toEqual({ ...LIVE_WEEK, final: true });
    expect(b.pastWeeks).toEqual([]);   // the board's own week is not a past week
  });

  it('lists my last 4 closed weeks before the board\'s week, newest first, with each week\'s player count', async () => {
    // Week k (5 weeks back to 1 week back) has 13 + k players, p<g> at place (14 + k) − g: p13 is place k + 1.
    const weeks = ['2026-11-02', '2026-10-26', '2026-10-19', '2026-10-12', '2026-10-05'];
    for (const [i, week] of weeks.entries()) {
      const n = 14 + i;
      await db.query(
        `INSERT INTO weekly_scores (week_start, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
         SELECT $1::date, 'p' || lpad(g::text, 2, '0'), 1, 0, 50, 50, 40 + g, $2::int + 1 - g FROM generate_series(1, $2::int) g`,
        [week, n],
      );
    }
    // The board's own week: never a past week.
    await db.query(
      `INSERT INTO weekly_scores (week_start, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
       VALUES ($1, 'p13', 1.3, 1.3, 61, 87, 74, 13)`,
      [MON],
    );
    expect((await board('p13')).pastWeeks).toEqual([
      { weekStart: '2026-11-02', rank: 2, players: 14, score: 53 },
      { weekStart: '2026-10-26', rank: 3, players: 15, score: 53 },
      { weekStart: '2026-10-19', rank: 4, players: 16, score: 53 },
      { weekStart: '2026-10-12', rank: 5, players: 17, score: 53 },
    ]);
    expect((await board('p25')).pastWeeks).toEqual([]);   // p25 played none of them
  });

  it('never sends a uid or an email', async () => {
    for (const query of ['', '?from=21', '?view=around']) {
      const json = JSON.stringify(await board('p13', query));
      expect(json).not.toMatch(/p\d\d/);
      expect(json).not.toContain('example.com');
      expect(json).not.toContain('uid');
    }
  });

  it('gives each player a stable avatar from 0 to 4', async () => {
    const tue = await board('p13');
    for (const r of [...tue.rows, ...tue.podium]) {
      expect(Number.isInteger(r.avatar) && r.avatar >= 0 && r.avatar < 5).toBe(true);
    }
    expect(tue.rows[0].avatar).toBe(avatarIndex('p01'));
    expect((await board('p13')).rows[0].avatar).toBe(tue.rows[0].avatar);
    // The same player keeps it on another day's board, in another place (p01 was 24th on Monday).
    await db.query(`UPDATE world_clock SET now_at = '2026-11-09T18:00:00Z'`);
    const mon = await board('p01', '?view=around');
    const p01OnMonday = mon.rows.find((r: { isMe: boolean }) => r.isMe);
    expect(p01OnMonday.rank).toBe(24);
    expect(p01OnMonday.avatar).toBe(tue.rows[0].avatar);
  });
});

describe('avatarIndex', () => {
  it('is FNV-1a (32-bit) of the uid, mod 5', () => {
    // Published FNV-1a test values: '' = 0x811c9dc5, 'a' = 0xe40c292c, 'foobar' = 0xbf9cf968.
    expect(avatarIndex('')).toBe(0x811c9dc5 % 5);
    expect(avatarIndex('a')).toBe(0xe40c292c % 5);
    expect(avatarIndex('foobar')).toBe(0xbf9cf968 % 5);
    expect(avatarIndex('alice')).toBe(4);
  });

  it('is always 0..4, and the same every time', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const uid = `uid-${i}-Xy9`;
      const a = avatarIndex(uid);
      expect(Number.isInteger(a) && a >= 0 && a < 5).toBe(true);
      expect(avatarIndex(uid)).toBe(a);
      seen.add(a);
    }
    expect(seen.size).toBe(5);   // all five fills get used
  });
});
