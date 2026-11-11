// The scoring step (api/src/scoring.ts, D-034) against a real Postgres (TEST_DATABASE_URL): the SQL compared field
// by field with the pure oracle (api/src/game/score.ts), who is ranked, the runner writing the board at every
// open and close (D-021, D-032), the week's final board, the new week's pruning, crash safety, and the board read
// back through GET /me/leaderboard. Every number is compared as the exact NUMERIC string Postgres stores.
//
// Calendar: November 2026. Israel is UTC+2 and New York UTC−5, so (Israel time / UTC):
//   TASE open 10:00 / 08:00Z, US open 16:30 / 14:30Z, TASE close 17:30 / 15:30Z, US close 23:00 / 21:00Z.
//   Friday 13.11 the TASE closes at 13:50 / 11:50Z.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { runner as migrate } from 'node-pg-migrate';
import { createApp } from '../src/app.js';
import { makeFirebaseVerifier } from '../src/auth.js';
import { forgetCalendar } from '../src/calendar.js';
import type { LeaderboardView } from '../src/contract.js';
import { recordSeen } from '../src/presence.js';
import { type RunOptions, runUntil } from '../src/runner.js';
import { scoreEvent, type ScoringInput } from '../src/scoring.js';
import { avgCost, format, parse, SCALE } from '../src/game/fixed.js';
import { reserveJournal } from '../src/game/ledger.js';
import { eventsBetween } from '../src/game/clock.js';
import { type Market, type MarketEvent, NO_CLOSURES } from '../src/game/marketHours.js';
import { isRanked, type RankInput, scorePlayers, weekNumbers } from '../src/game/score.js';
import { addDays, ISRAEL, mondayOf, zonedToInstant } from '../src/game/time.js';
import { upsertUser } from '../src/users.js';
import { sameBoard } from '../../src/leaderboard/board.js';
import { makeTestKeys, PROJECT_ID, signToken } from './helpers.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/portfolio_test';

const db = new pg.Pool({ connectionString: DATABASE_URL });
let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;

beforeAll(async () => {
  await migrate({ databaseUrl: DATABASE_URL, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} });
  const test = await makeTestKeys();
  privateKey = test.privateKey;
  app = createApp({ db, verifyToken: makeFirebaseVerifier(PROJECT_ID, test.keys), corsOrigins: [] });
});

beforeEach(async () => {
  // standings and weekly_scores cascade from users.
  await db.query('TRUNCATE users, securities, usd_ils, world_clock, market_events, market_closures CASCADE');
  forgetCalendar(db);
  await db.query(
    `INSERT INTO securities (symbol, name_he, market, exchange, currency) VALUES
       ('TEVA', 'טבע', 'TASE', 'TASE', 'ILS'), ('LUMI', 'לאומי', 'TASE', 'TASE', 'ILS'),
       ('NVDA', 'אנבידיה', 'US', 'NASDAQ', 'USD'), ('AAPL', 'אפל', 'US', 'NASDAQ', 'USD')`,
  );
});

afterAll(async () => {
  await db.end();
});

// ---------- the calendar ----------

const LAST_MON = '2026-11-02';
const LAST_FRI = '2026-11-06';
const MON = '2026-11-09';
const TUE = '2026-11-10';
const WED = '2026-11-11';
const THU = '2026-11-12';
const FRI = '2026-11-13';
const NEXT_MON = '2026-11-16';

function ev(market: Market, kind: 'open' | 'close', day: string): MarketEvent {
  const e = eventsBetween(zonedToInstant(day, 0, ISRAEL), zonedToInstant(addDays(day, 1), 0, ISRAEL), NO_CLOSURES)
    .find((x) => x.market === market && x.kind === kind);
  if (!e) throw new Error(`no ${market} ${kind} on ${day}`);
  return e;
}

const israel = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedToInstant(day, h * 60 + m, ISRAEL);
};

// ---------- reading the board ----------

type BoardRow = { uid: string; return_pct: string; dd: string; rr: string; sr: string; score: string; rank: number };

const BOARD_COLUMNS = `uid, return_pct::text AS return_pct, max_drawdown_pct::text AS dd, return_rank::text AS rr,
  stability_rank::text AS sr, score::text AS score, rank`;

async function standingsOf(day: string, on: pg.Pool | pg.PoolClient = db): Promise<BoardRow[]> {
  return (await on.query<BoardRow>(`SELECT ${BOARD_COLUMNS} FROM standings WHERE day = $1 ORDER BY rank`, [day])).rows;
}

async function weeklyOf(week: string): Promise<BoardRow[]> {
  return (await db.query<BoardRow>(`SELECT ${BOARD_COLUMNS} FROM weekly_scores WHERE week_start = $1 ORDER BY rank`, [week])).rows;
}

async function standingDays(): Promise<string[]> {
  return (await db.query<{ day: string }>('SELECT DISTINCT day::text AS day FROM standings ORDER BY 1')).rows.map((r) => r.day);
}

async function weeklyWeeks(): Promise<string[]> {
  return (await db.query<{ w: string }>('SELECT DISTINCT week_start::text AS w FROM weekly_scores ORDER BY 1')).rows.map((r) => r.w);
}

// The oracle's board, as the same strings.
function oracleRows(players: RankInput[]): BoardRow[] {
  return scorePlayers(players).map((s) => ({
    uid: s.uid,
    return_pct: format(s.returnPct, SCALE.PCT),
    dd: format(s.maxDrawdownPct, SCALE.PCT),
    rr: format(s.returnRank, 2),
    sr: format(s.stabilityRank, 2),
    score: format(s.score, 2),
    rank: s.place,
  }));
}

// What the oracle says the board of `day` is, from the portfolios as they are now: isRanked and weekNumbers
// picked and measured in TypeScript, then scorePlayers.
async function oracleFromDb(day: string): Promise<BoardRow[]> {
  const week = mondayOf(day);
  const { rows } = await db.query<{
    uid: string; week_start: string | null; wsv: string | null; equity: string; dd: string; us: string; open: boolean;
  }>(
    `SELECT p.uid, p.week_start::text AS week_start, p.week_start_value::text AS wsv, p.equity::text AS equity,
            p.max_drawdown_pct::text AS dd, (extract(epoch FROM u.created_at) * 1000000)::bigint::text AS us,
            EXISTS (SELECT 1 FROM positions x WHERE x.uid = p.uid AND x.status = 'open') AS open
     FROM portfolios p JOIN users u ON u.uid = p.uid`,
  );
  const ranked = rows
    .filter((r) => isRanked({ weekStart: r.week_start, hasOpenPosition: r.open }, week))
    .map((r) => ({
      uid: r.uid,
      createdAtUs: BigInt(r.us),
      ...weekNumbers({
        weekStart: r.week_start,
        weekStartValue: r.wsv === null ? null : parse(r.wsv, SCALE.ILS),
        equity: parse(r.equity, SCALE.ILS),
        maxDrawdownPct: parse(r.dd, SCALE.PCT),
      }, week),
    }));
  return oracleRows(ranked);
}

const uids = (rows: { uid: string }[]) => rows.map((r) => r.uid).sort();
const ranks = (rows: { rank: number }[]) => rows.map((r) => r.rank);
const oneToN = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

// ---------- fixtures ----------

async function withClient<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (c) => {
    await c.query('BEGIN');
    try {
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });
}

// The scoring step on its own, in one transaction, as the runner's finish calls it.
const score = (input: ScoringInput) => inTx((c) => scoreEvent(c, input));
const scoreDay = (day: string, weekEnds = false) => score({ day, at: israel(day, '17:30'), weekEnds });

const run = (target: Date, opts?: RunOptions) => withClient((c) => runUntil(c, target, opts));

async function world(nowAt: Date, opts: { endsAt?: Date | null } = {}) {
  await db.query('INSERT INTO world_clock (now_at, ends_at) VALUES ($1, $2)', [nowAt, opts.endsAt ?? null]);
}

async function player(uid: string) {
  await upsertUser(db, uid, `${uid}@example.com`);
}

async function price(symbol: string, day: string, open: string, close: string) {
  await db.query('INSERT INTO prices (symbol, day, open, close) VALUES ($1, $2, $3, $4)', [symbol, day, open, close]);
}

async function fx(day: string, open: string, close: string) {
  await db.query('INSERT INTO usd_ils (day, open, close) VALUES ($1, $2, $3)', [day, open, close]);
}

type Mark = { price: string; fx?: string; value: string; at: Date };

// A position bought before the test, kept ledger-true (as in runner.test.ts): a reversal journal moves the cost
// from cash_free to stock_cost, and the stored totals move with it.
async function holding(uid: string, symbol: string, units: string, cost: string, mark: Mark): Promise<void> {
  await inTx(async (c) => {
    const j = await c.query<{ id: string }>(`INSERT INTO journals (uid, kind) VALUES ($1, 'reversal') RETURNING id::text AS id`, [uid]);
    await c.query(
      `INSERT INTO ledger_entries (journal_id, uid, account, symbol, amount)
       VALUES ($1, $2, 'cash_free', NULL, -($3::numeric)), ($1, $2, 'stock_cost', $4, $3::numeric)`,
      [j.rows[0].id, uid, cost, symbol],
    );
    const avg = format(avgCost(parse(cost, SCALE.ILS), parse(units, SCALE.UNITS)), SCALE.AVG_COST);
    await c.query(
      `INSERT INTO positions (uid, symbol, units, avg_cost_ils, cost_basis_ils, last_price, last_fx, market_value_ils,
                              unrealized_pnl_ils, marked_at, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $8::numeric - $5::numeric, $9, '2026-11-02T08:00:00Z')`,
      [uid, symbol, units, avg, cost, mark.price, mark.fx ?? null, mark.value, mark.at],
    );
    await c.query(
      `UPDATE portfolios SET cash = cash - $2::numeric, holdings_value = holdings_value + $3::numeric,
         unrealized_pnl = unrealized_pnl + ($3::numeric - $2::numeric)
       WHERE uid = $1`,
      [uid, cost, mark.value],
    );
  });
}

// Last week's running totals, left by last Friday's close: a 2% drawdown that must not count this week.
async function lastWeekTotals(players: string[]) {
  await db.query(
    `UPDATE portfolios SET week_start = $2, week_start_value = 1000000, peak_value = 1010000, max_drawdown_pct = 2,
       last_event_at = $3
     WHERE uid = ANY($1)`,
    [players, LAST_MON, ev('TASE', 'close', LAST_FRI).at],
  );
}

// A pending buy and its reserve journal, as POST /me/orders writes them.
async function sendBuy(uid: string, symbol: string, amount: string, at: MarketEvent): Promise<void> {
  await inTx(async (c) => {
    const placed = new Date(at.at.getTime() - 3_600_000);
    const o = await c.query<{ id: string }>(
      `INSERT INTO orders (uid, symbol, side, amount_ils, placed_at, executes_at, price_type)
       VALUES ($1, $2, 'buy', $3, $4, $5, $6) RETURNING id::text AS id`,
      [uid, symbol, amount, placed, at.at, at.kind],
    );
    const journal = reserveJournal(o.rows[0].id, parse(amount, SCALE.ILS));
    const j = await c.query<{ id: string }>(
      `INSERT INTO journals (uid, kind, order_id, world_at) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
      [uid, journal.kind, o.rows[0].id, placed],
    );
    await c.query(
      `INSERT INTO ledger_entries (journal_id, uid, account, symbol, amount)
       SELECT $1, $2, x.account, x.symbol, x.amount FROM unnest($3::text[], $4::text[], $5::numeric[]) AS x (account, symbol, amount)`,
      [j.rows[0].id, uid, journal.entries.map((e) => e.account), journal.entries.map((e) => e.symbol),
        journal.entries.map((e) => format(e.amount, SCALE.ILS))],
    );
    await c.query('UPDATE portfolios SET reserved_cash = reserved_cash + $2::numeric WHERE uid = $1', [uid, amount]);
  });
}

// A pending sell: its units are locked on the open position, as POST /me/orders does.
async function sendSell(uid: string, symbol: string, units: string, at: MarketEvent): Promise<void> {
  await inTx(async (c) => {
    await c.query(
      `INSERT INTO orders (uid, symbol, side, units, placed_at, executes_at, price_type)
       VALUES ($1, $2, 'sell', $3, $4, $5, $6)`,
      [uid, symbol, units, new Date(at.at.getTime() - 3_600_000), at.at, at.kind],
    );
    await c.query(
      `UPDATE positions SET reserved_units = reserved_units + $3::numeric WHERE uid = $1 AND symbol = $2 AND status = 'open'`,
      [uid, symbol, units],
    );
  });
}

// ---------- seeded random boards, inserted directly ----------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// users.created_at to the microsecond: 2026-11-01 10:00:00 UTC + `offsetUs`.
const BASE_US = BigInt(Date.UTC(2026, 10, 1, 10, 0, 0)) * 1000n;
function isoMicros(us: bigint): string {
  const seconds = us / 1_000_000n;
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${String(us % 1_000_000n).padStart(6, '0')}Z`;
}

type Seeded = {
  uid: string;
  createdAtUs: bigint;
  weekStart: string | null;
  weekStartValue: string | null;
  equity: string;
  dd: string;
  position: 'open' | 'closed' | null;
};

// Writes the players as users + portfolios rows (and a position row where asked), straight into the tables.
async function insertSeeded(players: Seeded[]) {
  await db.query(
    `WITH u AS (
       INSERT INTO users (uid, email, created_at)
       SELECT t.uid, t.uid || '@example.com', t.created_at FROM unnest($1::text[], $2::timestamptz[]) AS t (uid, created_at)
     )
     INSERT INTO portfolios (uid, cash, week_start, week_start_value, max_drawdown_pct)
     SELECT * FROM unnest($1::text[], $3::numeric[], $4::date[], $5::numeric[], $6::numeric[])`,
    [players.map((p) => p.uid), players.map((p) => isoMicros(p.createdAtUs)), players.map((p) => p.equity),
      players.map((p) => p.weekStart), players.map((p) => p.weekStartValue), players.map((p) => p.dd)],
  );
  const open = players.filter((p) => p.position === 'open').map((p) => p.uid);
  const closed = players.filter((p) => p.position === 'closed').map((p) => p.uid);
  await db.query(`INSERT INTO positions (uid, symbol, units) SELECT uid, 'TEVA', 1 FROM unnest($1::text[]) AS t (uid)`, [open]);
  await db.query(
    `INSERT INTO positions (uid, symbol, units, status, closed_at)
     SELECT uid, 'LUMI', 0, 'closed', now() FROM unnest($1::text[]) AS t (uid)`,
    [closed],
  );
}

// The oracle's board for seeded players, from the test's own numbers (not read back from the database).
function seededOracle(players: Seeded[], week: string): BoardRow[] {
  return oracleRows(players
    .filter((p) => isRanked({ weekStart: p.weekStart, hasOpenPosition: p.position === 'open' }, week))
    .map((p) => ({
      uid: p.uid,
      createdAtUs: p.createdAtUs,
      ...weekNumbers({
        weekStart: p.weekStart,
        weekStartValue: p.weekStartValue === null ? null : parse(p.weekStartValue, SCALE.ILS),
        equity: parse(p.equity, SCALE.ILS),
        maxDrawdownPct: parse(p.dd, SCALE.PCT),
      }, week),
    })));
}

// A tie-heavy random board: few distinct returns and drawdowns (many 0% drops), equal sign-up times, uids whose
// byte order differs from a dictionary order, and every kind of row the ranking rule must sort out.
function randomBoard(seed: number): Seeded[] {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const n = 1 + Math.floor(rand() * 80);
  const starts = ['1000000.00', '999999.99', '1600000.00'];
  const deltas = ['0', '0', '0.80', '-0.80', '0.79', '12345.67', '-20000.00', '0.01', '160.00'];
  const drops = ['0', '0', '0', '0.5000', '1.2345', '9.9999'];
  const prefixes = ['a', 'B', 'b', 'Z', '_', '0', 'é'];
  return Array.from({ length: n }, (_, i) => {
    const uid = `${pick(prefixes)}${i}`;
    const createdAtUs = BASE_US + pick([0n, 0n, 1n, 999_999n, 86_400_000_000n]);
    const kind = pick(['week', 'week', 'week', 'week', 'oldHolder', 'newHolder', 'idle', 'idleClosed', 'noStart', 'zeroStart']);
    const start = pick(starts);
    const equity = format(parse(start, SCALE.ILS) + parse(pick(deltas), SCALE.ILS), SCALE.ILS);
    const dd = pick(drops);
    switch (kind) {
      case 'week': return { uid, createdAtUs, weekStart: MON, weekStartValue: start, equity, dd, position: pick(['open', null] as const) };
      case 'oldHolder': return { uid, createdAtUs, weekStart: LAST_MON, weekStartValue: start, equity, dd: '2.0000', position: 'open' as const };
      case 'newHolder': return { uid, createdAtUs, weekStart: null, weekStartValue: null, equity, dd: '0', position: 'open' as const };
      case 'idle': return { uid, createdAtUs, weekStart: pick([null, LAST_MON]), weekStartValue: null, equity: '1000000.00', dd: '0', position: null };
      case 'idleClosed': return { uid, createdAtUs, weekStart: LAST_MON, weekStartValue: start, equity, dd: '3.0000', position: 'closed' as const };
      case 'noStart': return { uid, createdAtUs, weekStart: MON, weekStartValue: null, equity, dd, position: null };
      default: return { uid, createdAtUs, weekStart: MON, weekStartValue: '0.00', equity, dd, position: 'open' as const };
    }
  });
}

// ---------- the SQL against the oracle ----------

describe('the scoring SQL against the pure oracle', () => {
  it('writes exactly the oracle\'s board on 40 seeded tie-heavy boards (1 to 80 players)', async () => {
    let total = 0;
    for (let seed = 1; seed <= 40; seed++) {
      await db.query('TRUNCATE users CASCADE');
      const players = randomBoard(seed);
      await insertSeeded(players);
      const expected = seededOracle(players, MON);
      const result = await scoreDay(WED);
      expect(result.players, `seed ${seed}`).toBe(expected.length);
      expect(await standingsOf(WED), `seed ${seed}`).toEqual(expected);
      total += expected.length;
    }
    expect(total).toBeGreaterThan(500);   // the seeds really rank players, not just empty boards
  });

  it('rounds a percentile at a .xx5 boundary half away from zero (33 players: 100 / 32 = 3.125 → 3.13)', async () => {
    const players: Seeded[] = Array.from({ length: 33 }, (_, i) => ({
      uid: `p${String(i).padStart(2, '0')}`, createdAtUs: BASE_US, weekStart: MON, weekStartValue: '1000000.00',
      equity: format(100_000_000n + BigInt(i) * 100n, SCALE.ILS), dd: '0', position: null,
    }));
    await insertSeeded(players);
    await scoreDay(WED);
    const rows = await standingsOf(WED);
    expect(rows).toEqual(seededOracle(players, MON));
    // p01 beat only p00: 0.85 × 3.13 + 0.15 × 100 = 2.6605 + 15 = 17.6605 → 17.66.
    expect(rows.find((r) => r.uid === 'p01')).toMatchObject({ rr: '3.13', sr: '100.00', score: '17.66', rank: 32 });
    expect(rows.find((r) => r.uid === 'p03')).toMatchObject({ rr: '9.38' });   // 9.375
  });

  it('rounds the score at a .xx5 boundary half away from zero (1001 players: 0.85 × 0.10 + 15 = 15.085 → 15.09)', async () => {
    const players: Seeded[] = Array.from({ length: 1001 }, (_, i) => ({
      uid: `q${String(i).padStart(4, '0')}`, createdAtUs: BASE_US + BigInt(i % 3), weekStart: MON,
      weekStartValue: '1000000.00', equity: format(100_000_000n + BigInt(i) * 1000n, SCALE.ILS), dd: '0', position: null,
    }));
    await insertSeeded(players);
    expect((await scoreDay(WED)).players).toBe(1001);
    const rows = await standingsOf(WED);
    expect(rows).toEqual(seededOracle(players, MON));
    expect(rows.find((r) => r.uid === 'q0001')).toMatchObject({ rr: '0.10', sr: '100.00', score: '15.09', rank: 1000 });
    expect(rows[0]).toMatchObject({ uid: 'q1000', rr: '100.00', score: '100.00', rank: 1 });
  });
});

// ---------- who is ranked ----------

describe('who is ranked', () => {
  it('an untouched cash-only player is not; a holder from last week is, with 0 / 0; a player who sold everything this week stays', async () => {
    await insertSeeded([
      // signed up, never traded: no week, no stock
      { uid: 'idle', createdAtUs: BASE_US, weekStart: null, weekStartValue: null, equity: '1000000.00', dd: '0', position: null },
      // cash only now, last traded last week (a closed position is history, not a holding)
      { uid: 'gone', createdAtUs: BASE_US, weekStart: LAST_MON, weekStartValue: '1000000.00', equity: '1050000.00', dd: '3', position: 'closed' },
      // holds a stock, not touched yet this week (a US-only holder at Monday's TASE open): 0 / 0, not last week's 2%
      { uid: 'holder', createdAtUs: BASE_US, weekStart: LAST_MON, weekStartValue: '1000000.00', equity: '1030000.00', dd: '2', position: 'open' },
      // sold everything on Tuesday: cash only, numbers locked in
      { uid: 'sold', createdAtUs: BASE_US, weekStart: MON, weekStartValue: '1000000.00', equity: '1010000.00', dd: '0.4', position: 'closed' },
    ]);
    expect(await scoreDay(WED)).toEqual({ players: 2, newDay: true, weekWritten: false, closedWeeks: [] });
    expect(await standingsOf(WED)).toEqual([
      { uid: 'sold', return_pct: '1.0000', dd: '0.4000', rr: '100.00', sr: '0.00', score: '85.00', rank: 1 },
      { uid: 'holder', return_pct: '0.0000', dd: '0.0000', rr: '0.00', sr: '100.00', score: '15.00', rank: 2 },
    ]);
  });

  it('nobody ranked: no rows written, the day keeps what it holds (a sample day), and last week\'s days stay', async () => {
    await player('idle');
    // A D-033 sample player: a users row only, no portfolio.
    await db.query(`INSERT INTO users (uid, email) VALUES ('sample-01', 'sample-01@sample.invalid')`);
    await db.query(
      `INSERT INTO standings (day, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
       VALUES ($1, 'idle', 0, 0, 100, 100, 100, 1), ($2, 'sample-01', 1.5, 0.5, 100, 100, 100, 1)`,
      [LAST_FRI, MON],
    );
    const sampleDay = await standingsOf(MON);
    expect(await score({ day: MON, at: ev('TASE', 'open', MON).at, weekEnds: false }))
      .toEqual({ players: 0, newDay: false, weekWritten: false, closedWeeks: [] });
    expect(await standingDays()).toEqual([LAST_FRI, MON]);
    expect(await standingsOf(MON)).toEqual(sampleDay);
    expect(await weeklyWeeks()).toEqual([]);

    // Once anyone is ranked, the day is replaced whole by the real ranking, and last week is closed from its days.
    await db.query(`UPDATE portfolios SET week_start = $1, week_start_value = 1000000 WHERE uid = 'idle'`, [MON]);
    expect(await score({ day: MON, at: ev('US', 'open', MON).at, weekEnds: false }))
      .toEqual({ players: 1, newDay: false, weekWritten: true, closedWeeks: [LAST_MON] });
    expect((await standingsOf(MON)).map((r) => [r.uid, r.rank])).toEqual([['idle', 1]]);
    expect(await standingDays()).toEqual([MON]);
  });
});

// ---------- the weeks, scored directly ----------

describe('the week\'s final board and the new week, scored directly', () => {
  async function board(day: string, uidsOnBoard: string[], scoreBase = 50) {
    await db.query(
      `INSERT INTO standings (day, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
       SELECT $1::date, u, 0, 0, 50, 50, $3 - g, g FROM unnest($2::text[]) WITH ORDINALITY AS t (u, g)`,
      [day, uidsOnBoard, scoreBase],
    );
  }

  it('closes every earlier week without a final board from its last scored day, keeps a final board already written, then drops their days', async () => {
    await insertSeeded(['a', 'b', 'c'].map((uid) => ({
      uid, createdAtUs: BASE_US, weekStart: MON, weekStartValue: '1000000.00', equity: '1000000.00', dd: '0', position: null,
    })));
    await board('2026-10-26', ['a', 'b']);
    await board('2026-10-29', ['b', 'a'], 60);          // the week of 26.10's last day, its final board already written:
    await db.query(
      `INSERT INTO weekly_scores (week_start, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
       VALUES ('2026-10-26', 'a', 9, 0, 100, 100, 99, 1)`,
    );
    await board(LAST_MON, ['a', 'b', 'c']);
    await board('2026-11-05', ['c', 'a', 'b'], 70);      // last week's last scored day (its Friday never ran)
    const thursday = await standingsOf('2026-11-05');

    const result = await score({ day: MON, at: ev('TASE', 'open', MON).at, weekEnds: false });
    expect(result).toEqual({ players: 3, newDay: true, weekWritten: true, closedWeeks: [LAST_MON] });
    expect(await weeklyOf(LAST_MON)).toEqual(thursday);
    expect(await weeklyOf('2026-10-26')).toEqual([{ uid: 'a', return_pct: '9.0000', dd: '0.0000', rr: '100.00', sr: '100.00', score: '99.00', rank: 1 }]);
    expect(await standingDays()).toEqual([MON]);
  });

  it('the week\'s last event copies its day to weekly_scores, replacing rows already there (a sample, or a retry)', async () => {
    await insertSeeded(['a', 'b'].map((uid, i) => ({
      uid, createdAtUs: BASE_US, weekStart: MON, weekStartValue: '1000000.00', equity: i === 0 ? '1010000.00' : '990000.00',
      dd: String(i), position: null,
    })));
    await db.query(
      `INSERT INTO weekly_scores (week_start, uid, return_pct, max_drawdown_pct, return_rank, stability_rank, score, rank)
       VALUES ($1, 'b', 0, 0, 0, 0, 0, 1), ($1, 'a', 0, 0, 0, 0, 0, 2)`,
      [MON],
    );
    expect(await score({ day: FRI, at: ev('US', 'close', FRI).at, weekEnds: true }))
      .toEqual({ players: 2, newDay: true, weekWritten: true, closedWeeks: [] });
    expect(await weeklyOf(MON)).toEqual(await standingsOf(FRI));
    expect(ranks(await weeklyOf(MON))).toEqual([1, 2]);
    expect((await weeklyOf(MON))[0].uid).toBe('a');
  });

  it('any other event of the week removes a final board written too early (the world\'s end moved later)', async () => {
    await insertSeeded([{ uid: 'a', createdAtUs: BASE_US, weekStart: MON, weekStartValue: '1000000.00', equity: '1000000.00', dd: '0', position: null }]);
    await score({ day: WED, at: ev('US', 'close', WED).at, weekEnds: true });
    expect(await weeklyWeeks()).toEqual([MON]);
    await score({ day: THU, at: ev('TASE', 'open', THU).at, weekEnds: false });
    expect(await weeklyWeeks()).toEqual([]);
    expect(await standingDays()).toEqual([WED, THU]);
  });

  it('replaces the day whole: a deleted player\'s gap closes, places run 1..N', async () => {
    await insertSeeded(['a', 'b', 'c'].map((uid, i) => ({
      uid, createdAtUs: BASE_US, weekStart: MON, weekStartValue: '1000000.00', equity: format(100_000_000n + BigInt(i) * 100n, SCALE.ILS),
      dd: '0', position: null,
    })));
    await scoreDay(WED);
    expect((await standingsOf(WED)).map((r) => [r.uid, r.rank])).toEqual([['c', 1], ['b', 2], ['a', 3]]);
    await db.query(`DELETE FROM users WHERE uid = 'b'`);
    expect(ranks(await standingsOf(WED))).toEqual([1, 3]);   // the gap D-032 warns about
    await scoreDay(WED);
    expect((await standingsOf(WED)).map((r) => [r.uid, r.rank])).toEqual([['c', 1], ['a', 2]]);
  });

  // A closed week is never rewritten (D-032): its places and player count (max(rank)) stay as the week closed.
  // If renumbering is ever wanted, this is the test to flip.
  it('a deletion after the week\'s final board leaves its place gap in weekly_scores for good', async () => {
    await insertSeeded(['a', 'b', 'c', 'd'].map((uid, i) => ({
      uid, createdAtUs: BASE_US, weekStart: MON, weekStartValue: '1000000.00',
      equity: format(100_000_000n - BigInt(i) * 100n, SCALE.ILS), dd: '0', position: 'open' as const,
    })));
    await score({ day: FRI, at: ev('US', 'close', FRI).at, weekEnds: true });
    expect((await weeklyOf(MON)).map((r) => [r.uid, r.rank])).toEqual([['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
    await db.query(`DELETE FROM users WHERE uid = 'b'`);
    await score({ day: NEXT_MON, at: ev('TASE', 'open', NEXT_MON).at, weekEnds: false });
    expect(ranks(await standingsOf(NEXT_MON))).toEqual([1, 2, 3]);   // the live board closes its gap
    expect((await weeklyOf(MON)).map((r) => [r.uid, r.rank])).toEqual([['a', 1], ['c', 3], ['d', 4]]);
    expect(await standingDays()).toEqual([NEXT_MON]);
  });
});

// ---------- the runner writes the board ----------

describe('the runner writes the board at every open and close', () => {
  it('writes the day at each event, rewrites it at the next, places 1..N, always the oracle\'s board', async () => {
    await world(israel(MON, '09:00'));
    for (const uid of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) await player(uid);
    const old = ev('TASE', 'close', LAST_FRI).at;
    await holding('alice', 'TEVA', '1000', '100000.00', { price: '100.0000', value: '100000.00', at: old });
    await holding('bob', 'NVDA', '100', '55500.00', { price: '150.0000', fx: '3.7000', value: '55500.00', at: old });
    await holding('erin', 'LUMI', '2000', '100000.00', { price: '50.0000', value: '100000.00', at: old });
    await lastWeekTotals(['alice', 'bob', 'erin']);
    await price('TEVA', MON, '101.0000', '98.0000');
    await price('LUMI', MON, '50.0000', '52.0000');
    await price('NVDA', MON, '152.0000', '149.0000');
    await price('TEVA', TUE, '99.0000', '103.0000');
    await fx(MON, '3.7000', '3.7100');
    await sendBuy('dave', 'TEVA', '50000.00', ev('TASE', 'open', MON));    // a mid-week (here: Monday) joiner
    await sendBuy('frank', 'NVDA', '20000.00', ev('US', 'open', MON));     // ranked only once New York fills it
    await sendSell('erin', 'LUMI', '2000', ev('TASE', 'close', MON));      // sells everything at the close
    // carol only holds cash and never trades: never on the board.

    // TASE open: alice re-marked, dave filled, erin re-marked; bob holds only US stocks: ranked, 0 / 0.
    await run(ev('TASE', 'open', MON).at);
    const atOpen = await standingsOf(MON);
    expect(atOpen).toEqual(await oracleFromDb(MON));
    expect(uids(atOpen)).toEqual(['alice', 'bob', 'dave', 'erin']);
    expect(ranks(atOpen)).toEqual(oneToN(4));
    expect(atOpen.find((r) => r.uid === 'bob')).toMatchObject({ return_pct: '0.0000', dd: '0.0000' });
    expect(atOpen.find((r) => r.uid === 'alice')).toMatchObject({ return_pct: '0.1000' });   // 1,000 × (101 − 100) / 1,000,000

    // US open: frank's buy fills, bob is re-marked (152 × 3.70 × 100 = 56,240 → +0.0740%).
    await run(ev('US', 'open', MON).at);
    const atUsOpen = await standingsOf(MON);
    expect(atUsOpen).toEqual(await oracleFromDb(MON));
    expect(uids(atUsOpen)).toEqual(['alice', 'bob', 'dave', 'erin', 'frank']);
    expect(atUsOpen.find((r) => r.uid === 'bob')).toMatchObject({ return_pct: '0.0740' });

    // TASE close: erin sells everything and stays, alice drops to 98: the day is rewritten.
    await run(ev('TASE', 'close', MON).at);
    const atClose = await standingsOf(MON);
    expect(atClose).toEqual(await oracleFromDb(MON));
    expect(atClose).not.toEqual(atUsOpen);
    expect(uids(atClose)).toEqual(['alice', 'bob', 'dave', 'erin', 'frank']);
    expect(atClose.find((r) => r.uid === 'alice')).toMatchObject({ return_pct: '-0.2000' });
    expect(atClose.find((r) => r.uid === 'erin')).toMatchObject({ return_pct: '0.4000' });   // 2,000 × 2 = 4,000 locked in

    await run(ev('US', 'close', MON).at);
    const monday = await standingsOf(MON);
    expect(monday).toEqual(await oracleFromDb(MON));
    expect(ranks(monday)).toEqual(oneToN(5));

    // Tuesday's open writes Tuesday and leaves Monday as it was (the rank change reads it).
    await run(ev('TASE', 'open', TUE).at);
    expect(await standingsOf(MON)).toEqual(monday);
    expect(await standingsOf(TUE)).toEqual(await oracleFromDb(TUE));
    expect(await standingDays()).toEqual([MON, TUE]);
    expect(await weeklyWeeks()).toEqual([]);
  });

  it('a new player is ranked from the event their first buy fills, measured from ₪1,000,000', async () => {
    await world(israel(MON, '09:00'));
    await player('alice');
    await player('newbie');
    await holding('alice', 'TEVA', '100', '10000.00', { price: '100.0000', value: '10000.00', at: ev('TASE', 'close', LAST_FRI).at });
    await price('TEVA', MON, '100.0000', '110.0000');
    await price('TEVA', TUE, '121.0000', '121.0000');
    await sendBuy('newbie', 'TEVA', '100000.00', ev('TASE', 'close', MON));   // sent Monday, fills at the close

    await run(ev('TASE', 'open', MON).at);
    expect(uids(await standingsOf(MON))).toEqual(['alice']);
    await run(ev('TASE', 'close', MON).at);
    expect(uids(await standingsOf(MON))).toEqual(['alice', 'newbie']);
    expect((await standingsOf(MON)).find((r) => r.uid === 'newbie')).toMatchObject({ return_pct: '0.0000', dd: '0.0000' });
    // Tuesday's open at 121: 909.09090909 units × 121 = 110,000.00 → +1% on the ₪1,000,000 the week started from.
    await run(ev('TASE', 'open', TUE).at);
    expect((await standingsOf(TUE)).find((r) => r.uid === 'newbie')).toMatchObject({ return_pct: '1.0000' });
    expect(await standingsOf(TUE)).toEqual(await oracleFromDb(TUE));
  });

  // The rule is week_start = this week. The order step starts the week of every player with an order due at the
  // event (runner.ts, runOrderBatch), a rejected one too, so a cash-only player whose buy was refused is ranked at
  // 0 / 0 for the rest of the week. Recorded here as the current behavior of the default (D-034).
  it('a cash-only player whose only order this week was rejected is ranked at 0 / 0 (the order step started their week)', async () => {
    await world(israel(MON, '09:00'));
    await player('alice');
    await player('refused');
    await holding('alice', 'TEVA', '100', '10000.00', { price: '100.0000', value: '10000.00', at: ev('TASE', 'close', LAST_FRI).at });
    await price('TEVA', MON, '100.0000', '110.0000');
    await sendBuy('refused', 'LUMI', '5000.00', ev('TASE', 'open', MON));   // no LUMI price: rejected NO_PRICE
    await run(ev('TASE', 'open', MON).at);
    const { rows } = await db.query(`SELECT status, reject_code FROM orders WHERE uid = 'refused'`);
    expect(rows).toEqual([{ status: 'rejected', reject_code: 'NO_PRICE' }]);
    expect(await standingsOf(MON)).toEqual(await oracleFromDb(MON));
    expect((await standingsOf(MON)).find((r) => r.uid === 'refused')).toMatchObject({ return_pct: '0.0000', dd: '0.0000' });
  });

  it('writes the week\'s final board at its last event; the next week\'s first event drops the old days and keeps it', async () => {
    await world(israel(THU, '09:00'));
    await player('alice');
    await player('bob');
    const old = ev('TASE', 'close', LAST_FRI).at;
    await holding('alice', 'TEVA', '1000', '100000.00', { price: '100.0000', value: '100000.00', at: old });
    await holding('bob', 'NVDA', '100', '55500.00', { price: '150.0000', fx: '3.7000', value: '55500.00', at: old });
    await lastWeekTotals(['alice', 'bob']);
    await price('TEVA', THU, '102.0000', '99.0000');
    await price('TEVA', FRI, '97.0000', '104.0000');
    await price('NVDA', THU, '151.0000', '149.0000');
    await price('NVDA', FRI, '160.0000', '140.0000');
    await price('TEVA', NEXT_MON, '105.0000', '105.0000');
    await fx(THU, '3.7000', '3.7000');
    await fx(FRI, '3.7000', '3.7000');

    await run(ev('US', 'close', THU).at);
    await run(ev('US', 'open', FRI).at);   // the Friday TASE close and US open are not the week's last
    expect(await weeklyWeeks()).toEqual([]);
    expect(await standingDays()).toEqual([THU, FRI]);

    await run(ev('US', 'close', FRI).at);
    const friday = await standingsOf(FRI);
    expect(friday).toEqual(await oracleFromDb(FRI));
    expect(await weeklyOf(MON)).toEqual(friday);
    expect(ranks(friday)).toEqual([1, 2]);
    expect(await standingDays()).toEqual([THU, FRI]);   // kept over the weekend (D-032)

    await run(ev('TASE', 'open', NEXT_MON).at);
    expect(await standingDays()).toEqual([NEXT_MON]);
    expect(await weeklyOf(MON)).toEqual(friday);
    expect(await weeklyWeeks()).toEqual([MON]);
    // The new week: alice re-marked from her value before the open, bob (US only) at 0 / 0.
    expect(await standingsOf(NEXT_MON)).toEqual(await oracleFromDb(NEXT_MON));
    expect((await standingsOf(NEXT_MON)).find((r) => r.uid === 'bob')).toMatchObject({ return_pct: '0.0000', dd: '0.0000' });
  });

  it('a week whose last event never wrote its final board gets it from its last scored day, before its days are dropped', async () => {
    await world(israel(THU, '09:00'));
    await player('alice');
    await holding('alice', 'TEVA', '1000', '100000.00', { price: '100.0000', value: '100000.00', at: ev('TASE', 'close', LAST_FRI).at });
    await price('TEVA', THU, '102.0000', '99.0000');
    await run(ev('US', 'close', THU).at);   // Thursday's last event: Friday still has events, so not the week's last
    const thursday = await standingsOf(THU);
    expect(thursday).toHaveLength(1);
    expect(await weeklyWeeks()).toEqual([]);

    // Friday is then closed on both markets (the calendar changed after Thursday ran): Friday has no events.
    await db.query(`INSERT INTO market_closures VALUES ('TASE', $1, 'חג', 'Holiday'), ('US', $1, 'חג', 'Holiday')`, [FRI]);
    await run(ev('TASE', 'open', NEXT_MON).at);
    expect(await weeklyOf(MON)).toEqual(thursday);
    expect(await standingDays()).toEqual([NEXT_MON]);
  });

  it('the world\'s end ends the week: its last event writes the final board', async () => {
    await world(israel(WED, '09:00'), { endsAt: ev('TASE', 'close', WED).at });
    await player('alice');
    await holding('alice', 'TEVA', '1000', '100000.00', { price: '100.0000', value: '100000.00', at: ev('TASE', 'close', LAST_FRI).at });
    await price('TEVA', WED, '102.0000', '99.0000');
    await run(ev('US', 'open', WED).at);
    expect(await weeklyWeeks()).toEqual([]);
    await run(ev('US', 'close', WED).at);   // stops at ends_at: the TASE close is the world's last event
    expect(await weeklyOf(MON)).toEqual(await standingsOf(WED));
    expect(await weeklyOf(MON)).toEqual([expect.objectContaining({ uid: 'alice', return_pct: '-0.1000', rank: 1 })]);
  });

  it('a user deleted between events leaves a gap that the next event\'s scoring closes', async () => {
    await world(israel(MON, '09:00'));
    const old = ev('TASE', 'close', LAST_FRI).at;
    for (const [uid, units] of [['a', '100'], ['b', '200'], ['c', '300']] as const) {
      await player(uid);
      await holding(uid, 'TEVA', units, format(parse(units, 0) * 10000n, SCALE.ILS), { price: '100.0000', value: format(parse(units, 0) * 10000n, SCALE.ILS), at: old });
    }
    await price('TEVA', MON, '110.0000', '120.0000');
    await run(ev('TASE', 'open', MON).at);
    expect((await standingsOf(MON)).map((r) => [r.uid, r.rank])).toEqual([['c', 1], ['b', 2], ['a', 3]]);
    await db.query(`DELETE FROM users WHERE uid = 'c'`);
    expect(ranks(await standingsOf(MON))).toEqual([2, 3]);
    await run(ev('TASE', 'close', MON).at);
    expect((await standingsOf(MON)).map((r) => [r.uid, r.rank])).toEqual([['b', 1], ['a', 2]]);
  });
});

// ---------- crash safety and ANALYZE ----------

// The runner's client, with a hook on every statement (before it is sent).
async function withHookedClient<T>(
  hook: (sql: string, query: (...args: unknown[]) => Promise<unknown>) => Promise<unknown> | undefined,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withClient(async (c) => {
    const query = c.query.bind(c) as (...args: unknown[]) => Promise<unknown>;
    (c as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      return hook(sql, query) ?? query(...args);
    };
    try {
      return await fn(c);
    } finally {
      (c as unknown as { query: unknown }).query = query;
    }
  });
}

const isDone = (sql: string) => sql.trimStart().startsWith(`UPDATE market_events SET status = 'done'`);

describe('crash safety', () => {
  async function twoHolders() {
    await world(israel(MON, '09:00'));
    const old = ev('TASE', 'close', LAST_FRI).at;
    await player('alice');
    await player('bob');
    await player('dave');
    await holding('alice', 'TEVA', '1000', '100000.00', { price: '100.0000', value: '100000.00', at: old });
    await holding('bob', 'LUMI', '1000', '50000.00', { price: '50.0000', value: '50000.00', at: old });
    await price('TEVA', MON, '101.0000', '97.0000');
    await price('LUMI', MON, '50.0000', '51.0000');
    await sendBuy('dave', 'TEVA', '30000.00', ev('TASE', 'close', MON));
  }

  it('a crash in the finish transaction rolls the scoring back with it; the re-run of the \'orders_done\' event writes the same rows', async () => {
    await twoHolders();
    await run(ev('US', 'open', MON).at);   // the TASE open and the US open: the next event is the TASE close
    const afterOpen = await standingsOf(MON);
    expect(uids(afterOpen)).toEqual(['alice', 'bob']);

    let inside: BoardRow[] | null = null;
    await withHookedClient(
      (sql, query) => {
        if (inside !== null || !isDone(sql)) return undefined;
        // The scoring already ran in this transaction: read what it wrote, then "crash" before 'done' and COMMIT.
        return (async () => {
          inside = ((await query(`SELECT ${BOARD_COLUMNS} FROM standings WHERE day = $1 ORDER BY rank`, [MON])) as pg.QueryResult<BoardRow>).rows;
          throw new Error('the server went away');
        })();
      },
      (c) => expect(runUntil(c, ev('TASE', 'close', MON).at)).rejects.toThrow('the server went away'),
    );
    expect(uids(inside!)).toEqual(['alice', 'bob', 'dave']);
    // Rolled back: the event waits in 'orders_done', and the board still shows the open's ranking.
    const { rows } = await db.query(`SELECT status FROM market_events WHERE market = 'TASE' AND kind = 'close' AND day = $1`, [MON]);
    expect(rows[0].status).toBe('orders_done');
    expect(await standingsOf(MON)).toEqual(afterOpen);

    await run(ev('TASE', 'close', MON).at);
    expect(await standingsOf(MON)).toEqual(inside);
    expect(await standingsOf(MON)).toEqual(await oracleFromDb(MON));
    // And once done, nothing runs it again.
    expect(await run(ev('TASE', 'close', MON).at)).toMatchObject({ events: 0 });
    expect(await standingsOf(MON)).toEqual(inside);
  });

  it('runs ANALYZE after the commit of a new day, and with weekly_scores at the week\'s end; a failing ANALYZE is logged and the event stays done', async () => {
    await world(israel(FRI, '09:00'));
    await player('alice');
    await holding('alice', 'TEVA', '10', '1000.00', { price: '100.0000', value: '1000.00', at: ev('TASE', 'close', LAST_FRI).at });

    const seen: string[] = [];
    await withHookedClient((sql) => {
      if (/^(BEGIN|COMMIT|ANALYZE)/.test(sql) || isDone(sql)) seen.push(sql.trim().split('\n')[0].slice(0, 40));
      return undefined;
    }, (c) => runUntil(c, ev('TASE', 'open', FRI).at));
    const done = seen.findIndex((s) => isDone(s));
    expect(seen.slice(done)).toEqual([seen[done], 'COMMIT', 'ANALYZE standings']);

    seen.length = 0;
    await withHookedClient((sql) => {
      if (/^ANALYZE/.test(sql)) seen.push(sql);
      return undefined;
    }, (c) => runUntil(c, ev('US', 'close', FRI).at));
    // TASE close, US open: a rewrite of a day the planner already knows, so no ANALYZE (it would cancel a running
    // autovacuum of standings at every event). US close: the week's last event writes its final board.
    expect(seen).toEqual(['ANALYZE standings, weekly_scores']);

    // A failing ANALYZE: logged, not thrown, and the scoring it follows is committed.
    await db.query('DELETE FROM market_events');
    await db.query('DELETE FROM standings');
    await db.query('DELETE FROM weekly_scores');
    await db.query('UPDATE world_clock SET events_through = NULL, now_at = $1', [israel(FRI, '09:00')]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withHookedClient(
        (sql) => (/^ANALYZE/.test(sql) ? Promise.reject(new Error('permission denied')) : undefined),
        (c) => runUntil(c, ev('TASE', 'open', FRI).at),
      );
      expect(error).toHaveBeenCalledWith('scoring: ANALYZE of the board failed', 'permission denied');
    } finally {
      error.mockRestore();
    }
    const { rows } = await db.query(`SELECT status FROM market_events`);
    expect(rows).toEqual([{ status: 'done' }]);
    expect(uids(await standingsOf(FRI))).toEqual(['alice']);
  });
});

// ---------- other requests while the scoring transaction is open ----------

describe('requests during the scoring transaction', () => {
  // The standings and weekly_scores foreign keys hold FOR KEY SHARE on every ranked player's users row until the
  // finish transaction commits. A check-in (POST /me/seen) locks the same row: with FOR UPDATE it waited for the
  // whole scoring, holding a pool connection, at every open and close.
  it('a check-in does not wait for an open scoring transaction', async () => {
    await upsertUser(db, 'alice', 'alice@example.com');
    await db.query(`UPDATE portfolios SET week_start = $1, week_start_value = 1000000 WHERE uid = 'alice'`, [MON]);
    const lockPool = new pg.Pool({ connectionString: DATABASE_URL, options: '-c lock_timeout=1000' });
    const holder = await db.connect();
    try {
      await holder.query('BEGIN');
      expect((await scoreEvent(holder, { day: WED, at: israel(WED, '23:00'), weekEnds: true })).players).toBe(1);
      // FOR UPDATE would fail here with "canceling statement due to lock timeout".
      expect(await recordSeen(lockPool, 'alice')).toEqual({ newVisit: true });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await lockPool.end();
    }
  });
});

// ---------- end to end: the board players read ----------

describe('GET /me/leaderboard after real events', () => {
  async function call(method: string, path: string, uid: string, body?: unknown) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${await signToken(privateKey, uid)}` };
    return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function ok(method: string, path: string, uid: string, body?: unknown) {
    const res = await call(method, path, uid, body);
    const out = await res.json();
    expect(res.status, JSON.stringify(out)).toBeLessThan(300);
    return out;
  }
  const leaderboard = (uid: string) => ok('GET', '/me/leaderboard', uid);
  const advance = () => ok('POST', '/admin/clock/advance', 'root');

  it('shows the scored rows, my place, the player count, and the week as final after its last event', async () => {
    await world(israel(FRI, '12:00'));   // the TASE is open, New York not yet
    for (const uid of ['root', 'alice', 'bob', 'carol']) await ok('POST', '/me', uid);
    await db.query(`UPDATE users SET roles = '{admin,user}' WHERE uid = 'root'`);
    await price('TEVA', FRI, '100.0000', '102.0000');
    await price('NVDA', FRI, '150.0000', '160.0000');
    await fx(FRI, '3.7000', '3.7000');
    await ok('POST', '/me/orders', 'alice', { symbol: 'TEVA', side: 'buy', amountIls: '100000.00' });   // at the 13:50 close
    await ok('POST', '/me/orders', 'bob', { symbol: 'NVDA', side: 'buy', amountIls: '100000.00' });     // at the 16:30 open

    // 13:50, the TASE close: alice's buy fills, and she is the board.
    expect(await advance()).toMatchObject({ to: { date: FRI, time: '13:50' } });
    let b = await leaderboard('alice');
    expect(b.week).toEqual({ start: MON, day: FRI, final: false });
    expect(b.players).toBe(1);
    expect(b.me).toMatchObject({ rank: 1, players: 1, score: 100, returnRank: 100, stabilityRank: 100, returnPct: 0 });
    expect((await leaderboard('carol')).me).toBeNull();   // only cash, never traded: not ranked

    // 16:30, the US open: bob's buy fills. Then 23:00, the US close: the week's last event.
    expect(await advance()).toMatchObject({ to: { date: FRI, time: '16:30' } });
    expect((await leaderboard('bob')).players).toBe(2);
    expect(await advance()).toMatchObject({ to: { date: FRI, time: '23:00' } });

    // NVDA 150 → 160: bob +0.6667% (100,000 × 10/150 = 6,666.67 on 1,000,000); alice's TEVA was bought at the close
    // and marked at the same price: 0. Neither dropped (stability 100 each), so bob 100.00 and alice 0.15 × 100 = 15.00.
    const rows = await standingsOf(FRI);
    expect(rows).toEqual(await oracleFromDb(FRI));
    expect(rows.map((r) => [r.uid, r.return_pct, r.score, r.rank])).toEqual([['bob', '0.6667', '100.00', 1], ['alice', '0.0000', '15.00', 2]]);
    expect(await weeklyOf(MON)).toEqual(rows);
    b = await leaderboard('bob');
    expect(b.week).toEqual({ start: MON, day: FRI, final: true });
    expect(b.players).toBe(2);
    expect(b.rows.map((r: { rank: number; isMe: boolean; score: number; returnPct: number }) => [r.rank, r.isMe, r.score, r.returnPct]))
      .toEqual(rows.map((r) => [r.rank, r.uid === 'bob', Number(r.score), Number(r.return_pct)]));
    expect(b.me).toMatchObject({ rank: rows.find((r) => r.uid === 'bob')!.rank, players: 2, score: Number(rows.find((r) => r.uid === 'bob')!.score) });
    expect(b.podium).toHaveLength(2);

    // Over the weekend to Monday's open: the new week is scored, the closed one is a past week.
    expect(await advance()).toMatchObject({ to: { date: NEXT_MON, time: '10:00' } });
    b = await leaderboard('bob');
    expect(b.week).toEqual({ start: NEXT_MON, day: NEXT_MON, final: false });
    expect(b.players).toBe(2);
    expect(b.pastWeeks).toEqual([{ weekStart: MON, rank: 1, players: 2, score: 100 }]);
    expect(await standingDays()).toEqual([NEXT_MON]);
    // An admin advance runs the events before it moves the clock (D-030): the board is never behind it.
    expect(b.behind).toBe(false);
    expect(b.scoredAt).toBe(ev('TASE', 'open', NEXT_MON).at.toISOString());
  });

  // The clock follows real time and the ticker runs a passed event up to a minute later, so a screen that reloads
  // as the clock passes an open gets the board from before it. `behind` tells it to ask again.
  it('says the board is behind while an open the clock has passed is not scored, and not once it is', async () => {
    await world(israel(MON, '09:00'));
    for (const uid of ['alice', 'bob']) await ok('POST', '/me', uid);
    const old = ev('TASE', 'close', LAST_FRI).at;
    await holding('alice', 'TEVA', '1000', '100000.00', { price: '100.0000', value: '100000.00', at: old });
    await holding('bob', 'NVDA', '100', '55500.00', { price: '150.0000', fx: '3.7000', value: '55500.00', at: old });
    await price('TEVA', MON, '100.0000', '100.0000');
    await price('NVDA', MON, '150.0000', '150.0000');
    await price('TEVA', TUE, '90.0000', '90.0000');
    await fx(MON, '3.7000', '3.7000');
    const usClose = ev('US', 'close', MON).at;
    const tueOpen = ev('TASE', 'open', TUE).at;
    await run(usClose);

    // The clock runs, 30 s past Tuesday's TASE open, and the ticker hasn't run it yet.
    await db.query('UPDATE world_clock SET now_at = $1, real_at = now(), running = true', [new Date(tueOpen.getTime() + 30_000)]);
    let b = await leaderboard('alice');
    expect(b.week).toEqual({ start: MON, day: MON, final: false });
    expect(b.behind).toBe(true);
    expect(b.scoredAt).toBe(usClose.toISOString());

    // Another event at the same instant as the latest one started isn't done: still behind (a close and an open
    // can share an instant, and the runner lists events from 1 ms before events_through).
    await db.query('UPDATE world_clock SET events_through = $1', [tueOpen]);
    expect((await leaderboard('alice')).behind).toBe(true);

    // The runner catches up, as the ticker would: Tuesday is scored and the board has caught up.
    await run(new Date(tueOpen.getTime() + 30_000));
    b = await leaderboard('alice');
    expect(b.week).toEqual({ start: MON, day: TUE, final: false });
    expect(b.me).toMatchObject({ rank: 2 });   // TEVA 100 → 90: alice −1%, below bob's 0
    expect(b.behind).toBe(false);
    expect(b.scoredAt).toBe(tueOpen.toISOString());

    // Started but not finished counts too.
    await db.query(`UPDATE market_events SET status = 'orders_done' WHERE at = $1`, [tueOpen]);
    expect((await leaderboard('alice')).behind).toBe(true);
    await db.query(`UPDATE market_events SET status = 'done' WHERE at = $1`, [tueOpen]);

    // A stopped clock with every event done is not behind.
    await db.query('UPDATE world_clock SET running = false');
    expect((await leaderboard('alice')).behind).toBe(false);
  });

  // "Load more" glues the next page under the rows loaded. If the day was re-scored in between, the two pages come
  // from two rankings. Two neighbours who swap places change neither the player count, the podium nor my row, so
  // only scoredAt tells the pages apart.
  it('a page read after a same-day re-score has another scoredAt, so sameBoard refuses to glue it on', async () => {
    await world(israel(MON, '09:00'));
    const old = ev('TASE', 'close', LAST_FRI).at;
    const tase = Array.from({ length: 19 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`);
    for (const uid of tase) {
      await ok('POST', '/me', uid);
      await holding(uid, 'TEVA', '1000', '100000.00', { price: '100.0000', value: '100000.00', at: old });
    }
    // Two US holders, ₪200,000 each at $50 and 4 ₪/$: their return in % = 0.4 × (price − 50).
    for (const [uid, symbol] of [['u1', 'NVDA'], ['u2', 'AAPL']] as const) {
      await ok('POST', '/me', uid);
      await holding(uid, symbol, '1000', '200000.00', { price: '50.0000', fx: '4.0000', value: '200000.00', at: old });
    }
    await price('TEVA', MON, '101.0000', '105.0000');   // every TASE holder up, no drop: above both US holders
    await price('NVDA', MON, '47.5000', '42.5000');     // u1: −1% at the open, −3% at the close
    await price('AAPL', MON, '45.0000', '47.5000');     // u2: −2% at the open, −1% at the close
    await fx(MON, '4.0000', '4.0000');

    await run(ev('TASE', 'close', MON).at);
    expect((await standingsOf(MON)).slice(19).map((r) => [r.uid, r.rank])).toEqual([['u1', 20], ['u2', 21]]);
    const page1: LeaderboardView = await ok('GET', '/me/leaderboard?view=top&from=1', 't01');

    await run(ev('US', 'close', MON).at);   // the same day, re-scored: the two swap places 20 and 21
    expect((await standingsOf(MON)).slice(19).map((r) => [r.uid, r.rank])).toEqual([['u2', 20], ['u1', 21]]);
    const page2: LeaderboardView = await ok('GET', '/me/leaderboard?view=top&from=21', 't01');

    expect(page2.week).toEqual(page1.week);
    expect(page2.players).toBe(page1.players);
    expect(page2.podium).toEqual(page1.podium);
    expect(page2.me).toEqual(page1.me);
    expect(page1.scoredAt).toBe(ev('TASE', 'close', MON).at.toISOString());
    expect(page2.scoredAt).toBe(ev('US', 'close', MON).at.toISOString());
    expect(sameBoard(page1, page2)).toBe(false);
  });
});
