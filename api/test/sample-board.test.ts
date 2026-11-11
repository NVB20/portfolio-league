// The dev-only sample board (D-033): its safety check, its ranking and its made-up weeks. Pure, no database.
// The script itself (scripts/seed-sample-board.ts) was run by hand against a private local database.

import { describe, expect, it } from 'vitest';
import {
  byPlace,
  checkPlayers,
  checkTarget,
  type Entry,
  MAX_DEV_PLAYERS,
  parseArgs,
  planBoard,
  rankDay,
  SAMPLE_NAMES,
  SAMPLE_PLAYERS,
  SAMPLE_UIDS,
  sampleEmail,
  sampleWeek,
  sampleWeekBoards,
} from '../src/sampleBoard.js';

const LOCAL = 'postgres://hof:hof_dev@localhost:5432/portfolio';

describe('checkTarget: only a local development database', () => {
  const check = (databaseUrl: string | undefined, nodeEnv?: string) => checkTarget({ databaseUrl, nodeEnv });

  it('accepts localhost and 127.0.0.1, and says which database', () => {
    expect(check(LOCAL)).toEqual({ ok: true, target: { host: 'localhost', database: 'portfolio' } });
    expect(check('postgresql://hof@127.0.0.1/portfolio_p4a_seed', 'development')).toEqual({
      ok: true,
      target: { host: '127.0.0.1', database: 'portfolio_p4a_seed' },
    });
  });

  it.each([
    ['a remote host', 'postgres://u:p@db.example.com:5432/portfolio', /db\.example\.com/],
    ['a cloud proxy host', 'postgres://u:p@roundhouse.proxy.rlwy.net:41234/railway', /localhost or 127\.0\.0\.1/],
    ['an IPv6 address', 'postgres://u:p@[::1]:5432/portfolio', /localhost or 127\.0\.0\.1/],
    ['a host that only starts like localhost', 'postgres://u:p@localhost.example.com/portfolio', /localhost or/],
    ['a host in the query string', `${LOCAL}?host=db.example.com`, /query string/],
    ['a hostaddr in the query string', `${LOCAL}?hostaddr=10.0.0.5`, /query string/],
    ['no host at all (pg would fall back to PGHOST)', 'postgres:///portfolio', /\(none\)/],
    ['the shared test database', 'postgres://hof:hof_dev@localhost:5432/portfolio_test', /portfolio_test/],
    ['the test database spelled with an escape', 'postgres://hof:hof_dev@localhost:5432/portfolio%5Ftest', /portfolio_test/],
    ['no database name', 'postgres://hof:hof_dev@localhost:5432/', /no database name/],
    ['another protocol', 'mysql://u:p@localhost/portfolio', /postgres:\/\//],
    ['a unix socket path', '/var/run/postgresql portfolio', /not a postgres/],
    ['not a URL', 'portfolio', /not a postgres/],
  ])('refuses %s', (_label, url, reason) => {
    const r = check(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it('refuses when DATABASE_URL is missing', () => {
    expect(check(undefined)).toEqual({ ok: false, reason: 'DATABASE_URL is not set.' });
    expect(check('')).toEqual({ ok: false, reason: 'DATABASE_URL is not set.' });
  });

  it('refuses in production even for a local database, however NODE_ENV is spelled', () => {
    for (const env of ['production', 'Production', 'PRODUCTION', ' production ']) {
      const r = check(LOCAL, env);
      expect(r.ok, env).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/NODE_ENV is production/);
    }
  });
});

describe('checkPlayers: a database that looks real', () => {
  it('allows up to MAX_DEV_PLAYERS real players', () => {
    expect(MAX_DEV_PLAYERS).toBe(1000);
    expect(checkPlayers(0, false)).toBeNull();
    expect(checkPlayers(MAX_DEV_PLAYERS, false)).toBeNull();
  });

  it('refuses more (a port forward or proxy on localhost), unless --force', () => {
    expect(checkPlayers(MAX_DEV_PLAYERS + 1, false)).toMatch(/more than 1,000 players.*--force/);
    expect(checkPlayers(MAX_DEV_PLAYERS + 1, true)).toBeNull();
  });
});

describe('parseArgs', () => {
  it('reads --clear and --force, and nothing else', () => {
    expect(parseArgs([])).toEqual({ clear: false, force: false });
    expect(parseArgs(['--clear'])).toEqual({ clear: true, force: false });
    expect(parseArgs(['--force'])).toEqual({ clear: false, force: true });
    expect(parseArgs(['--clean'])).toEqual({ error: 'Unknown option: --clean' });
    expect(parseArgs(['--clear', '--force'])).toHaveProperty('error');
  });
});

describe('the sample players', () => {
  it('are 40 users with fixed uids, a reserved email domain and a few without a name', () => {
    expect(SAMPLE_UIDS).toHaveLength(SAMPLE_PLAYERS);
    expect(SAMPLE_UIDS[0]).toBe('sample-01');
    expect(SAMPLE_UIDS[39]).toBe('sample-40');
    expect(new Set(SAMPLE_UIDS).size).toBe(SAMPLE_PLAYERS);
    expect(sampleEmail('sample-07')).toBe('sample-07@sample.invalid');
    expect(SAMPLE_NAMES).toHaveLength(SAMPLE_PLAYERS);
    expect(SAMPLE_NAMES.filter((n) => n === null).length).toBeGreaterThan(0);
  });
});

describe('rankDay', () => {
  it('gives percentile ranks, the score formula and places, worked by hand', () => {
    // returns (1/10,000 %): d -1%, e 0, b 3%, c 3%, a 5%   → return ranks 0, 25, 50, 50, 100
    // drawdowns:            d 3%, c 2%, a 1%, b 0, e 0     → stability ranks 0, 25, 50, 75, 75
    const board = rankDay([
      { uid: 'a', ret: 50_000, dd: 10_000 },
      { uid: 'b', ret: 30_000, dd: 0 },
      { uid: 'c', ret: 30_000, dd: 20_000 },
      { uid: 'd', ret: -10_000, dd: 30_000 },
      { uid: 'e', ret: 0, dd: 0 },
    ]);
    expect(board.map((r) => [r.uid, r.returnRank, r.stabilityRank, r.score, r.rank])).toEqual([
      ['a', 10_000, 5_000, 9_250, 1],   // 0.85 × 100 + 0.15 × 50 = 92.50
      ['b', 5_000, 7_500, 5_375, 2],    // 42.50 + 11.25 = 53.75
      ['c', 5_000, 2_500, 4_625, 3],    // 42.50 + 3.75 = 46.25
      ['e', 2_500, 7_500, 3_250, 4],    // 21.25 + 11.25 = 32.50
      ['d', 0, 0, 0, 5],
    ]);
  });

  it('rounds each rank to 2 decimals, and the score from the rounded ranks, half up', () => {
    // 4 players: steps of 100/3 → 33.33 and 66.67
    const board = rankDay([
      { uid: 'w', ret: 1, dd: 4 },
      { uid: 'x', ret: 2, dd: 3 },
      { uid: 'y', ret: 3, dd: 2 },
      { uid: 'z', ret: 4, dd: 1 },
    ]);
    const x = board.find((r) => r.uid === 'x')!;
    expect([x.returnRank, x.stabilityRank]).toEqual([3_333, 3_333]);
    expect(x.score).toBe(3_333);   // 0.85 × 33.33 + 0.15 × 33.33 = 33.33
    const y = board.find((r) => r.uid === 'y')!;
    expect([y.returnRank, y.stabilityRank, y.score]).toEqual([6_667, 6_667, 6_667]);
    for (const r of board) expect(r.score).toBe(Math.round((85 * r.returnRank + 15 * r.stabilityRank) / 100));
  });

  it('gives a lone player 100 everywhere and place 1', () => {
    expect(rankDay([{ uid: 'solo', ret: -5_000, dd: 9_000 }])).toEqual([
      { uid: 'solo', ret: -5_000, dd: 9_000, returnRank: 10_000, stabilityRank: 10_000, score: 10_000, rank: 1 },
    ]);
  });

  it('gives equal values the same percentile, but never the same place', () => {
    const same: Entry[] = ['p3', 'p1', 'p2'].map((uid) => ({ uid, ret: 0, dd: 0 }));
    const board = rankDay([...same, { uid: 'up', ret: 10, dd: 5 }]);
    const tied = board.filter((r) => r.ret === 0);
    expect(new Set(tied.map((r) => r.score)).size).toBe(1);
    expect(tied.map((r) => [r.uid, r.rank])).toEqual([['p1', 2], ['p2', 3], ['p3', 4]]);   // uid order
  });

  it('returns an empty board for no players', () => {
    expect(rankDay([])).toEqual([]);
  });
});

describe('byPlace: equal scores go by % gain, then stability, then uid', () => {
  const row = (uid: string, score: number, ret: number, dd: number) => ({ uid, score, ret, dd });
  const order = (rows: ReturnType<typeof row>[]) => [...rows].sort(byPlace).map((r) => r.uid);

  it('puts the higher score first', () => {
    expect(order([row('low', 10, 900, 0), row('high', 20, -900, 900)])).toEqual(['high', 'low']);
  });

  it('on an equal score, the higher return first', () => {
    expect(order([row('a', 50, 100, 10), row('b', 50, 200, 90)])).toEqual(['b', 'a']);
  });

  it('on an equal score and return, the smaller drawdown first', () => {
    expect(order([row('a', 50, 100, 30), row('b', 50, 100, 20)])).toEqual(['b', 'a']);
  });

  it('on everything equal, by uid', () => {
    expect(order([row('m', 50, 1, 1), row('k', 50, 1, 1), row('z', 50, 1, 1)])).toEqual(['k', 'm', 'z']);
  });
});

describe('sampleWeek: the made-up numbers', () => {
  it('is the same on every run, and a longer week keeps the earlier days', () => {
    const three = sampleWeek('sample-05', '2026-11-09', 3);
    expect(sampleWeek('sample-05', '2026-11-09', 3)).toEqual(three);
    expect(sampleWeek('sample-05', '2026-11-09', 5).slice(0, 3)).toEqual(three);
    expect(sampleWeek('sample-05', '2026-11-16', 3)).not.toEqual(three);   // another week, another walk
  });

  it('never lowers the drawdown within the week, and stays inside the table CHECKs', () => {
    for (const uid of [...SAMPLE_UIDS, 'realUser1']) {
      const week = sampleWeek(uid, '2026-11-09', 5);
      for (let i = 0; i < week.length; i++) {
        const { ret, dd } = week[i];
        expect(Number.isInteger(ret) && Number.isInteger(dd)).toBe(true);
        expect(dd).toBeGreaterThanOrEqual(i > 0 ? week[i - 1].dd : 0);
        expect(ret).toBeGreaterThan(-1_000_000);   // above -100%: NUMERIC(10,4) holds it
        expect(dd).toBeLessThan(1_000_000);
      }
    }
  });

  it('keeps sample-39 and sample-40 still, so the board always shows a tie broken by uid', () => {
    expect(sampleWeek('sample-39', '2026-11-09', 5).every((d) => d.ret === 0 && d.dd === 0)).toBe(true);
    const board = sampleWeekBoards(SAMPLE_UIDS, '2026-11-09', 5)[4];
    const [a, b] = ['sample-39', 'sample-40'].map((uid) => board.find((r) => r.uid === uid)!);
    expect(a.score).toBe(b.score);
    expect(b.rank).toBe(a.rank + 1);
  });
});

describe('sampleWeekBoards', () => {
  it('ranks every player on every day, places 1..N with no gap', () => {
    const uids = [...SAMPLE_UIDS, 'realUser1', 'realUser2'];
    const boards = sampleWeekBoards(uids, '2026-11-09', 5);
    expect(boards).toHaveLength(5);
    for (const board of boards) {
      expect(board.map((r) => r.rank)).toEqual(uids.map((_, i) => i + 1));
      expect(new Set(board.map((r) => r.uid)).size).toBe(uids.length);
      for (let i = 1; i < board.length; i++) expect(byPlace(board[i - 1], board[i])).toBeLessThan(0);
    }
  });
});

describe('planBoard: which days and weeks get rows', () => {
  const everyWeekday = () => true;

  it('on a Wednesday: Monday to today, and the 4 weeks before as final boards', () => {
    const plan = planBoard('2026-11-11', false, everyWeekday);
    expect(plan.monday).toBe('2026-11-09');
    expect(plan.weekDays).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
    expect(plan.days).toEqual(['2026-11-09', '2026-11-10', '2026-11-11']);
    expect(plan.finalWeeks.map((w) => w.start)).toEqual(['2026-11-02', '2026-10-26', '2026-10-19', '2026-10-12']);
    expect(plan.finalWeeks[0].days).toHaveLength(5);
  });

  it('on a Saturday: Monday to Friday, and the week just closed is final too', () => {
    const plan = planBoard('2026-11-14', true, everyWeekday);
    expect(plan.monday).toBe('2026-11-09');
    expect(plan.days).toEqual(plan.weekDays);
    expect(plan.finalWeeks.map((w) => w.start)).toEqual([
      '2026-11-09', '2026-11-02', '2026-10-26', '2026-10-19', '2026-10-12',
    ]);
  });

  it('on a Sunday: still the week that ended on Friday', () => {
    expect(planBoard('2026-11-15', true, everyWeekday).days).toEqual([
      '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13',
    ]);
  });

  it('skips a weekday when no market opens', () => {
    const closed = new Set(['2026-11-10', '2026-10-28']);
    const plan = planBoard('2026-11-11', false, (d) => !closed.has(d));
    expect(plan.days).toEqual(['2026-11-09', '2026-11-11']);
    expect(plan.finalWeeks.find((w) => w.start === '2026-10-26')!.days).toEqual([
      '2026-10-26', '2026-10-27', '2026-10-29', '2026-10-30',
    ]);
  });
});
