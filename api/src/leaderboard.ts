// GET /me/leaderboard, and the board the dashboard's standing and top 5 read (D-032).
//
// Read-only: the runner's scoring step (scoring.ts, D-034) writes `standings` (the live board, one row per ranked
// player per day) and `weekly_scores` (each closed week's final board). This file only reads them, and never runs
// the catch-up (D-025): nothing here depends on the player's own values being up to date. Each answer also says
// how far the scoring has got (loadProgress), so the screen can tell a board that is about to change.
//
// Which board: the latest scored day up to the world's today, with no lower bound. So on the weekend, and on
// Monday before the week's first open, it is still the week that just closed. Every read is an index lookup:
// the day and the player count by backward probes of (day, rank), places by (day, rank) ranges, a player's row and
// days by (uid, day), past weeks by (uid, week_start). Nothing counts or scans a whole day (a day can hold every
// player). The reads of one answer share one snapshot (inSnapshot), so a scoring run that commits in between
// can't make the answer contradict itself.
//
// Places are unique on a day, 1..players (no shared places, D-032), so `rank` is also the list order and the
// player count is max(rank). Rows never carry a uid or an email: names are display names, and the avatar is a
// hash of the uid.

import type { Pool, PoolClient } from 'pg';
import type {
  BoardWeek,
  LeaderboardMe,
  LeaderboardRow,
  LeaderboardView,
  LeaderRow,
  PastWeekView,
} from './contract.js';
import { ANONYMOUS_NAME, liveClockView, loadNow, type Now } from './dashboard.js';
import { eventsBetween } from './game/clock.js';
import { weekdayOf } from './game/time.js';

export const PAGE_SIZE = 20;     // rows per page of the table
const AROUND = 5;                // "around me": my place ± 5
const PODIUM = 3;
const PAST_WEEKS = 4;
const AVATARS = 5;               // LD-06: five avatar fills
const WEEKDAYS = 5;              // Mon..Fri

export type LeaderboardQuery = { view: 'top' | 'around'; from: number };

// The pool, or the one connection of a snapshot.
export type Db = Pool | PoolClient;

// Runs `fn` on one connection, in one read-only REPEATABLE READ transaction: every statement sees the same
// snapshot. Without it each statement takes its own, so a scoring run (D-034) that re-ranks or replaces a day
// between two of them gives an answer that contradicts itself: a place card whose row is missing from "around me",
// or a week whose rows were just deleted (an empty page that still offers "load more"). Still one pool connection
// per request.
export async function inSnapshot<T>(db: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((e: Error) => {
      broken = e;   // the connection is unusable: drop it instead of returning it to the pool
    });
    throw err;
  } finally {
    client.release(broken);
  }
}

// The board shown, plus what the reads below need: the player count and the previous scored day of the same week
// (for the rank change; null on the week's first scored day).
export type Board = BoardWeek & { players: number; prevDay: string | null };

// The board rule (D-032), in one statement:
//   - day: the latest standings day up to today ((day, rank), read backwards from today)
//   - start: that day's Monday
//   - players: max(rank) that day (one probe of (day, rank))
//   - prevDay: the latest day of the same week before it
//   - final: that week is before the current world week, or its final board (weekly_scores) is written. Asked as
//     max(rank) IS NOT NULL, not EXISTS: the planner guesses EXISTS finds a row early and scans the whole table,
//     which mid-week (no row for the live week yet) reads every past week. max(rank) is one probe of (week_start, rank).
// null = no scored day up to today.
export async function loadBoard(db: Db, now: Pick<Now, 'today' | 'monday'>): Promise<Board | null> {
  const { rows } = await db.query<{ day: string; start: string; players: number; prev_day: string | null; final: boolean }>(
    `WITH d AS (SELECT max(day) AS day FROM standings WHERE day <= $1::date),
          b AS (SELECT day, date_trunc('week', day::timestamp)::date AS start FROM d WHERE day IS NOT NULL)
     SELECT b.day::text AS day, b.start::text AS start,
            (SELECT max(s.rank) FROM standings s WHERE s.day = b.day) AS players,
            (SELECT max(s.day) FROM standings s WHERE s.day >= b.start AND s.day < b.day)::text AS prev_day,
            (b.start < $2::date
             OR (SELECT max(w.rank) FROM weekly_scores w WHERE w.week_start = b.start) IS NOT NULL) AS final
     FROM b`,
    [now.today, now.monday],
  );
  const r = rows[0];
  if (!r) return null;
  return { start: r.start, day: r.day, final: r.final, players: r.players, prevDay: r.prev_day };
}

export function boardWeek(b: Board): BoardWeek {
  return { start: b.start, day: b.day, final: b.final };
}

// One place on the board, as SQL returns it. `uid` stays on the server: it keys the days and the avatar only.
// Scores and ranks are display numbers (::float8, as on the dashboard).
export type BoardRow = {
  uid: string;
  rank: number;
  name: string;
  is_me: boolean;
  return_pct: number;
  max_drawdown_pct: number;
  return_rank: number;
  stability_rank: number;
  score: number;
  prev_rank: number | null;   // my place on the previous scored day of the week; null = not on it, or no such day
};

// Places lo..hi of the board's day, in place order: one range of the (day, rank) index. The rank on the
// previous scored day is one probe of (uid, day) per row.
export async function loadRows(db: Db, board: Board, uid: string, lo: number, hi: number): Promise<BoardRow[]> {
  const { rows } = await db.query<BoardRow>(
    `SELECT st.uid, st.rank, COALESCE(u.display_name, $6) AS name, st.uid = $5 AS is_me,
            st.return_pct::float8 AS return_pct, st.max_drawdown_pct::float8 AS max_drawdown_pct,
            st.return_rank::float8 AS return_rank, st.stability_rank::float8 AS stability_rank,
            st.score::float8 AS score, prev.rank AS prev_rank
     FROM standings st
     JOIN users u ON u.uid = st.uid
     LEFT JOIN standings prev ON prev.day = $4::date AND prev.uid = st.uid
     WHERE st.day = $1::date AND st.rank BETWEEN $2 AND $3
     ORDER BY st.rank`,
    [board.day, lo, hi, board.prevDay, uid, ANONYMOUS_NAME],
  );
  return rows;
}

// The dashboard's top rows (contract LeaderRow).
export function leaderRow(r: BoardRow): LeaderRow {
  return { rank: r.rank, name: r.name, returnPct: r.return_pct, score: r.score, isMe: r.is_me };
}

type DayScore = { day: string; score: number };

// These players' scored days this week, Monday up to the board's day: one query on the (uid, day) index.
async function loadDays(db: Db, board: Board, uids: string[]): Promise<Map<string, DayScore[]>> {
  const out = new Map<string, DayScore[]>();
  if (uids.length === 0) return out;
  const { rows } = await db.query<{ uid: string; day: string; score: number }>(
    `SELECT uid, day::text AS day, score::float8 AS score FROM standings
     WHERE uid = ANY($1::text[]) AND day BETWEEN $2::date AND $3::date
     ORDER BY uid, day`,
    [uids, board.start, board.day],
  );
  for (const r of rows) {
    const list = out.get(r.uid) ?? [];
    list.push({ day: r.day, score: r.score });
    out.set(r.uid, list);
  }
  return out;
}

function rankChange(prev: number | null, now: number): number | null {
  return prev === null ? null : prev - now;
}

// A table row: the daily scores laid out Mon..Fri (always 5 entries, null = no score that day).
function rowView(r: BoardRow, days: DayScore[]): LeaderboardRow {
  const week: (number | null)[] = Array.from({ length: WEEKDAYS }, () => null);
  for (const d of days) {
    const i = weekdayOf(d.day) - 1;   // Monday = 0
    if (i >= 0 && i < WEEKDAYS) week[i] = d.score;
  }
  return {
    ...leaderRow(r),
    avatar: avatarIndex(r.uid),
    maxDrawdownPct: r.max_drawdown_pct,
    returnRank: r.return_rank,
    stabilityRank: r.stability_rank,
    rankChange: rankChange(r.prev_rank, r.rank),
    days: week,
  };
}

// My row on the board's day and my place on the previous scored day (both (uid, day)), and the place just above
// mine ((day, rank − 1)). null = I'm not on this board.
type MeRow = {
  rank: number;
  score: number;
  return_rank: number;
  stability_rank: number;
  return_pct: number;
  max_drawdown_pct: number;
  prev_rank: number | null;
  ahead_rank: number | null;
  ahead_score: number | null;
};

async function loadMeRow(db: Db, board: Board, uid: string): Promise<MeRow | null> {
  const { rows } = await db.query<MeRow>(
    `SELECT st.rank, st.score::float8 AS score, st.return_rank::float8 AS return_rank,
            st.stability_rank::float8 AS stability_rank, st.return_pct::float8 AS return_pct,
            st.max_drawdown_pct::float8 AS max_drawdown_pct, prev.rank AS prev_rank,
            ahead.rank AS ahead_rank, ahead.score::float8 AS ahead_score
     FROM standings st
     LEFT JOIN standings prev ON prev.day = $3::date AND prev.uid = st.uid
     LEFT JOIN standings ahead ON ahead.day = st.day AND ahead.rank = st.rank - 1
     WHERE st.day = $1::date AND st.uid = $2`,
    [board.day, uid, board.prevDay],
  );
  return rows[0] ?? null;
}

function meView(board: Board, r: MeRow, days: DayScore[]): LeaderboardMe {
  return {
    rank: r.rank,
    players: board.players,
    score: r.score,
    returnRank: r.return_rank,
    stabilityRank: r.stability_rank,
    rankChange: rankChange(r.prev_rank, r.rank),
    days: days.map((d) => ({ date: d.day, weekday: weekdayOf(d.day), score: d.score })),
    returnPct: r.return_pct,
    maxDrawdownPct: r.max_drawdown_pct,
    ahead: r.ahead_rank === null || r.ahead_score === null ? null : { rank: r.ahead_rank, score: r.ahead_score },
  };
}

// My standing on the board (the dashboard's StandingView plus the leaderboard's extras). null = not on it.
export async function loadStanding(db: Db, board: Board, uid: string): Promise<LeaderboardMe | null> {
  const r = await loadMeRow(db, board, uid);
  if (!r) return null;
  const days = await loadDays(db, board, [uid]);
  return meView(board, r, days.get(uid) ?? []);
}

// My last closed weeks before `before` (the board's week; null = no board, so all of them), newest first. The
// (uid, week_start) index, read backwards; each week's player count is one probe of (week_start, rank).
async function loadPastWeeks(db: Db, uid: string, before: string | null): Promise<PastWeekView[]> {
  const { rows } = await db.query<{ week_start: string; rank: number; score: number; players: number }>(
    `SELECT w.week_start::text AS week_start, w.rank, w.score::float8 AS score,
            (SELECT max(x.rank) FROM weekly_scores x WHERE x.week_start = w.week_start) AS players
     FROM weekly_scores w
     WHERE w.uid = $1 AND w.week_start < COALESCE($2::date, 'infinity'::date)
     ORDER BY w.week_start DESC
     LIMIT $3`,
    [uid, before, PAST_WEEKS],
  );
  return rows.map((r) => ({ weekStart: r.week_start, rank: r.rank, players: r.players, score: r.score }));
}

// How far the scoring has got, read inside the answer's snapshot (D-034):
//   scoredAt  the latest finished open or close. The scoring commits in the same transaction as the event's
//             'done', so this is the exact version of the rows read with it.
//   behind    the clock has passed an open or close that isn't scored yet, so the board is about to change. The
//             clock follows real time, not the runner, and the ticker runs a passed event up to a minute later
//             (plus the event's own time), so a screen that reloads as the clock passes an open usually gets the
//             board from before it. True when an event at or before now started but isn't 'done' (the partial
//             index market_events_unfinished_idx), or when the runner's own listing (runUntil: the calendar's
//             events from 1 ms before events_through, or before the clock's anchor when nothing has run, up to
//             now) holds an event that isn't 'done'. That window is normally the last event started and nothing
//             else; it is compared by identity because a close and an open can share an instant.
// `now` was read before the snapshot, so a scoring that commits in between can only make `behind` true for one
// answer too many, never false while the board is older than the clock.
async function loadProgress(db: Db, now: Now | null): Promise<{ scoredAt: string | null; behind: boolean }> {
  const from = now ? new Date((now.eventsThrough ?? now.nowAt).getTime() - 1) : null;
  const { rows } = await db.query<{ scored_at: Date | null; unfinished: boolean; done: string[] }>(
    `SELECT (SELECT max(at) FROM market_events WHERE status = 'done') AS scored_at,
            EXISTS (SELECT 1 FROM market_events WHERE status <> 'done' AND at <= $2) AS unfinished,
            ARRAY(SELECT market || ' ' || kind || ' ' || day::text FROM market_events
                  WHERE status = 'done' AND at > $1 AND at <= $2) AS done`,
    [from, now?.at ?? null],
  );
  const scoredAt = rows[0].scored_at?.toISOString() ?? null;
  if (!now || !from) return { scoredAt, behind: false };
  const done = new Set(rows[0].done);
  const notDone = eventsBetween(from, now.at, now.calendar).some((e) => !done.has(`${e.market} ${e.kind} ${e.day}`));
  return { scoredAt, behind: rows[0].unfinished || notDone };
}

// Which of the five avatar fills a player gets (LD-06): FNV-1a (32-bit) of the uid's UTF-8 bytes, mod 5. Stable
// for a player across days and devices, and it never sends the uid itself.
const utf8 = new TextEncoder();

export function avatarIndex(uid: string): number {
  let h = 0x811c9dc5;
  for (const b of utf8.encode(uid)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % AVATARS;
}

// GET /me/leaderboard. null = the user has no row yet (POST /me was never called), answered with 404.
// view 'top': PAGE_SIZE places from `from`. view 'around': my place ± 5; when I'm not on the board, the top page
// from place 1 instead (and view says 'top'; `from` is ignored either way). The board's reads share one snapshot
// (inSnapshot); they run one after another on one pool connection, as the dashboard's.
export async function getLeaderboard(db: Pool, uid: string, q: LeaderboardQuery): Promise<LeaderboardView | null> {
  const user = await db.query('SELECT 1 FROM users WHERE uid = $1', [uid]);
  if (user.rowCount === 0) return null;

  const now = await loadNow(db);
  // The clock rides along, so the screen's top bar and its reload at each open and close need no second request.
  const clock = now ? liveClockView(now) : null;
  return inSnapshot(db, async (c): Promise<LeaderboardView> => {
    const progress = await loadProgress(c, now);
    const board = now ? await loadBoard(c, now) : null;
    if (!board) {
      return {
        clock, week: null, players: 0, me: null, podium: [], view: 'top', rows: [], from: 1, hasMore: false,
        pastWeeks: await loadPastWeeks(c, uid, null), ...progress,
      };
    }

    const meRow = await loadMeRow(c, board, uid);
    const around = q.view === 'around' && meRow !== null;
    const lo = around ? Math.max(1, meRow.rank - AROUND) : q.view === 'around' ? 1 : q.from;
    const hi = around ? meRow.rank + AROUND : lo + PAGE_SIZE - 1;
    const rows = await loadRows(c, board, uid, lo, hi);
    // A page that starts at place 1 already holds the podium (hi is at least 6). Taken by place, not as the first
    // 3 rows: with a gap in places 1..3 (a deleted player) the 3rd row would be place 4.
    const podium = lo === 1 ? rows.filter((r) => r.rank <= PODIUM) : await loadRows(c, board, uid, 1, PODIUM);

    const uids = [...new Set([...(meRow ? [uid] : []), ...podium.map((r) => r.uid), ...rows.map((r) => r.uid)])];
    const days = await loadDays(c, board, uids);
    const daysOf = (u: string) => days.get(u) ?? [];

    return {
      clock,
      week: boardWeek(board),
      players: board.players,
      me: meRow ? meView(board, meRow, daysOf(uid)) : null,
      podium: podium.map((r) => rowView(r, daysOf(r.uid))),
      view: around ? 'around' : 'top',
      rows: rows.map((r) => rowView(r, daysOf(r.uid))),
      from: rows[0]?.rank ?? 1,
      hasMore: hi < board.players,
      pastWeeks: await loadPastWeeks(c, uid, board.start),
      ...progress,
    };
  });
}
