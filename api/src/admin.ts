// The admin side: GET /admin/overview and GET /admin/players. Read-only, admins only.
// Admins are users whose `roles` include 'admin', granted with SQL only (D-001). Nothing here writes.
// Every query is sequential, like the dashboard: one request holds at most one pool connection.

import type { Pool } from 'pg';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './auth.js';
import type {
  AdminAction,
  AdminActionView,
  AdminActivity,
  AdminOverview,
  AdminPlayer,
  AdminPlayers,
  AdminRunView,
} from './contract.js';
import { clockView, loadNow, worldTime, type Now } from './dashboard.js';
import { addDays, ISRAEL, zonedParts, zonedToInstant } from './game/time.js';
import { loadBoard } from './leaderboard.js';
import { ONLINE_MINUTES } from './presence.js';

export const PLAYERS_LIMIT = 5;   // the admin page shows the top few; the full table is the leaderboard
const REJECT_REASONS_SHOWN = 3;

// After requireAuth: 403 unless the caller's row says admin. Read from Postgres on every request,
// so removing the role with SQL takes effect at once (the token itself carries no roles).
export function requireAdmin(db: Pool): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { rows } = await db.query<{ is_admin: boolean }>(
      `SELECT 'admin' = ANY(roles) AS is_admin FROM users WHERE uid = $1`,
      [c.get('user').uid],
    );
    if (!rows[0]?.is_admin) return c.json({ error: 'admins only' }, 403);
    await next();
  };
}

// ---------- GET /admin/overview ----------

export async function getAdminOverview(db: Pool): Promise<AdminOverview> {
  const now = await loadNow(db);
  return {
    clock: now ? await loadClock(db, now) : null,
    players: await loadPlayerCounts(db),
    presence: await loadPresence(db),
    orders: await loadOrders(db, now),
    world: await loadWorld(db),
    lastRun: await loadLastRun(db),
    eventsBehind: now ? await loadEventsBehind(db, now) : 0,
    recentActions: await loadRecentActions(db),
  };
}

// ---------- the engine's runs (market_events, D-021) ----------

type RunRow = {
  market: AdminRunView['market'];
  kind: AdminRunView['kind'];
  at: Date;
  status: AdminRunView['status'];
  orders_executed: number;
  orders_rejected: number;
  players_updated: number;
  duration_ms: number | null;
  ledger_balanced: boolean | null;
  finished_at: Date | null;
};

// The latest event the runner started. Events not started yet are only due, not run.
async function loadLastRun(db: Pool): Promise<AdminRunView | null> {
  const { rows } = await db.query<RunRow>(
    `SELECT market, kind, at, status, orders_executed, orders_rejected, players_updated,
            duration_ms, ledger_balanced, finished_at
     FROM market_events WHERE started_at IS NOT NULL
     ORDER BY at DESC LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    market: r.market,
    kind: r.kind,
    at: worldTime(r.at),
    status: r.status,
    ordersExecuted: r.orders_executed,
    ordersRejected: r.orders_rejected,
    playersUpdated: r.players_updated,
    durationMs: r.duration_ms,
    ledgerBalanced: r.ledger_balanced,
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

// Opens and closes whose world time has passed but that aren't done: the engine is behind (or stuck).
async function loadEventsBehind(db: Pool, now: Now): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM market_events WHERE status <> 'done' AND at <= $1`,
    [now.at],
  );
  return rows[0].n;
}

// ---------- the admin action log (admin_actions) ----------

const ACTIONS_SHOWN = 5;

async function loadRecentActions(db: Pool): Promise<AdminActionView[]> {
  const { rows } = await db.query<{
    at: Date;
    admin: string;
    action: AdminAction;
    world_from: Date | null;
    world_to: Date | null;
    detail: Record<string, unknown>;
  }>(
    `SELECT a.at, COALESCE(u.display_name, u.email) AS admin, a.action, a.world_from, a.world_to, a.detail
     FROM admin_actions a JOIN users u ON u.uid = a.uid
     ORDER BY a.at DESC, a.id DESC LIMIT $1`,
    [ACTIONS_SHOWN],
  );
  return rows.map((r) => ({
    at: r.at.toISOString(),
    admin: r.admin,
    action: r.action,
    worldFrom: r.world_from?.toISOString() ?? null,
    worldTo: r.world_to?.toISOString() ?? null,
    detail: r.detail,
  }));
}

// ---------- GET /admin/activity?days= ----------

export const ACTIVITY_DAYS = { min: 7, max: 90, default: 30 };

// Active players, visits and sign-ups per real Israel day, plus next-day and 7-day return (D-026).
// "Active on a day" = started a visit that day (app_opens). Day 1 / day 7 = the calendar day 1 or 7 after
// sign-up; only days that are fully over count, so a player who signed up yesterday isn't counted as
// "didn't come back" while today is still going.
export async function getAdminActivity(db: Pool, days: number): Promise<AdminActivity> {
  const today = zonedParts(new Date(), ISRAEL).date;
  const first = addDays(today, -(days - 1));
  const from = zonedToInstant(first, 0, ISRAEL);

  const series = await db.query<{ day: string; active: number; visits: number; signups: number }>(
    `WITH d AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day),
          v AS (SELECT (at AT TIME ZONE '${ISRAEL}')::date AS day, count(DISTINCT uid)::int AS active, count(*)::int AS visits
                FROM app_opens WHERE at >= $3 GROUP BY 1),
          s AS (SELECT (created_at AT TIME ZONE '${ISRAEL}')::date AS day, count(*)::int AS signups
                FROM users WHERE created_at >= $3 GROUP BY 1)
     SELECT d.day::text AS day, COALESCE(v.active, 0) AS active, COALESCE(v.visits, 0) AS visits,
            COALESCE(s.signups, 0) AS signups
     FROM d LEFT JOIN v ON v.day = d.day LEFT JOIN s ON s.day = d.day
     ORDER BY d.day`,
    [first, today, from],
  );

  // Cohort = signed up in the window. A player counts for day N once day N after their sign-up is over.
  const ret = await db.query<{ d1_cohort: number; d1_returned: number; d7_cohort: number; d7_returned: number }>(
    `WITH c AS (SELECT uid, (created_at AT TIME ZONE '${ISRAEL}')::date AS d0 FROM users WHERE created_at >= $1),
          o AS (SELECT DISTINCT uid, (at AT TIME ZONE '${ISRAEL}')::date AS d FROM app_opens WHERE at >= $1)
     SELECT count(*) FILTER (WHERE c.d0 + 1 < $2::date)::int AS d1_cohort,
            count(*) FILTER (WHERE c.d0 + 1 < $2::date
                             AND EXISTS (SELECT 1 FROM o WHERE o.uid = c.uid AND o.d = c.d0 + 1))::int AS d1_returned,
            count(*) FILTER (WHERE c.d0 + 7 < $2::date)::int AS d7_cohort,
            count(*) FILTER (WHERE c.d0 + 7 < $2::date
                             AND EXISTS (SELECT 1 FROM o WHERE o.uid = c.uid AND o.d = c.d0 + 7))::int AS d7_returned
     FROM c`,
    [from, today],
  );
  const r = ret.rows[0];
  const rate = (cohort: number, returned: number) => ({
    cohort,
    returned,
    pct: cohort > 0 ? Math.round((returned / cohort) * 1000) / 10 : null,
  });

  return {
    days: series.rows.map((d) => ({ date: d.day, activePlayers: d.active, visits: d.visits, signups: d.signups })),
    retention: { d1: rate(r.d1_cohort, r.d1_returned), d7: rate(r.d7_cohort, r.d7_returned) },
  };
}

// The world clock plus the ticker's heartbeat: last_tick_at is real time, written every minute (D-030).
async function loadClock(db: Pool, now: Now): Promise<NonNullable<AdminOverview['clock']>> {
  const { rows } = await db.query<{ last_tick_at: Date | null }>('SELECT last_tick_at FROM world_clock');
  return {
    ...clockView(now.at, now.calendar),
    running: now.running,
    endsAt: now.endsAt ? worldTime(now.endsAt) : null,
    lastTickAt: rows[0]?.last_tick_at?.toISOString() ?? null,
  };
}

// Midnight of today's REAL date in Israel. Sign-ups and visits happen in real time, not world time.
function realTodayStart(): Date {
  return zonedToInstant(zonedParts(new Date(), ISRAEL).date, 0, ISRAEL);
}

async function loadPlayerCounts(db: Pool): Promise<AdminOverview['players']> {
  const todayStart = realTodayStart();
  const { rows } = await db.query<{ total: number; joined_today: number; with_holdings: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE created_at >= $1)::int AS joined_today,
            (SELECT count(DISTINCT uid)::int FROM holdings) AS with_holdings
     FROM users`,
    [todayStart],
  );
  const r = rows[0];
  return { total: r.total, joinedToday: r.joined_today, withHoldings: r.with_holdings };
}

// Who has the app open, and today's visits (D-026). Both queries read only recent rows through their index.
async function loadPresence(db: Pool): Promise<AdminOverview['presence']> {
  const todayStart = realTodayStart();
  const seen = await db.query<{ online_now: number; seen_today: number }>(
    `SELECT count(*) FILTER (WHERE last_seen_at > now() - make_interval(mins => $2))::int AS online_now,
            count(*)::int AS seen_today
     FROM users WHERE last_seen_at >= $1`,
    [todayStart, ONLINE_MINUTES],
  );
  const visits = await db.query<{ visitors: number; visits: number; returning: number; two: number; three_to_five: number; six_plus: number }>(
    `WITH v AS (SELECT uid, count(*) AS n FROM app_opens WHERE at >= $1 GROUP BY uid)
     SELECT count(*)::int AS visitors,
            COALESCE(sum(n), 0)::int AS visits,
            count(*) FILTER (WHERE n >= 2)::int AS returning,
            count(*) FILTER (WHERE n = 2)::int AS two,
            count(*) FILTER (WHERE n BETWEEN 3 AND 5)::int AS three_to_five,
            count(*) FILTER (WHERE n >= 6)::int AS six_plus
     FROM v`,
    [todayStart],
  );
  const s = seen.rows[0];
  const v = visits.rows[0];
  return {
    onlineNow: s.online_now,
    seenToday: s.seen_today,
    visitsToday: v.visits,
    returningToday: v.returning,
    visitBuckets: { two: v.two, threeToFive: v.three_to_five, sixPlus: v.six_plus },
    avgVisits: v.visitors > 0 ? Math.round((v.visits / v.visitors) * 10) / 10 : null,
  };
}

async function loadOrders(db: Pool, now: Now | null): Promise<AdminOverview['orders']> {
  const pending = await db.query<{ market: 'TASE' | 'US'; n: number }>(
    `SELECT s.market, count(*)::int AS n
     FROM orders o JOIN securities s ON s.symbol = o.symbol
     WHERE o.status = 'pending'
     GROUP BY s.market`,
  );
  const count = (m: 'TASE' | 'US') => pending.rows.find((r) => r.market === m)?.n ?? 0;

  // Rejections this world week. No clock = nothing can have run yet.
  let rejected: { reason: string; n: number }[] = [];
  if (now) {
    const res = await db.query<{ reason: string; n: number }>(
      `SELECT COALESCE(reject_reason, 'ללא סיבה') AS reason, count(*)::int AS n
       FROM orders
       WHERE status = 'rejected' AND executes_at >= $1 AND executes_at <= $2
       GROUP BY 1 ORDER BY n DESC, reason`,
      [now.weekStart, now.at],
    );
    rejected = res.rows;
  }

  return {
    pending: { tase: count('TASE'), us: count('US') },
    rejectedThisWeek: rejected.reduce((sum, r) => sum + r.n, 0),
    rejectReasons: rejected.slice(0, REJECT_REASONS_SHOWN).map((r) => ({ reason: r.reason, count: r.n })),
  };
}

async function loadWorld(db: Pool): Promise<AdminOverview['world']> {
  // Dates as text: pg would turn a DATE into a JS Date at local midnight and shift the day.
  const { rows } = await db.query<{ securities: number; tase: string | null; us: string | null; fx: string | null }>(
    `SELECT (SELECT count(*)::int FROM securities) AS securities,
            (SELECT max(p.day)::text FROM prices p JOIN securities s ON s.symbol = p.symbol WHERE s.market = 'TASE') AS tase,
            (SELECT max(p.day)::text FROM prices p JOIN securities s ON s.symbol = p.symbol WHERE s.market = 'US') AS us,
            (SELECT max(day)::text FROM usd_ils) AS fx`,
  );
  const r = rows[0];
  return { securities: r.securities, pricesUntil: { tase: r.tase, us: r.us }, usdIlsUntil: r.fx };
}

// ---------- GET /admin/players?q= ----------

type PlayerRow = {
  uid: string;
  display_name: string | null;
  email: string;
  is_admin: boolean;
  created_at: Date;
  total_value: number;
  rank: number | null;
  score: number | null;
  return_pct: number | null;
  max_drawdown_pct: number | null;
  return_rank: number | null;
  stability_rank: number | null;
  pending: number;
  last_seen_at: Date | null;
  visits_today: number;
};

// The first PLAYERS_LIMIT players by rank on the board the players see, then by value. `q` filters by name or
// email. The board is loadBoard's (D-032): the latest scored day up to today, so on Monday before the first open
// it is last week's final board, not blank.
// The rank and what makes it (score, return, drawdown and the two percentile ranks) come from one standings
// row, so they always agree. The rank follows the weekly score, not the value: the value is since the game
// began, so #1 can hold less than #2.
// The value is the stored equity the runner keeps current after every event (D-019, D-024): nothing is
// added up here (D-031), so it always matches the player's dashboard.
// Fine for an admin page; at a million players this would read the engine's stored values instead.
export async function getAdminPlayers(db: Pool, q: string | null): Promise<AdminPlayers> {
  const now = await loadNow(db);
  const shown = now ? await loadBoard(db, now) : null;
  // ILIKE treats % and _ as wildcards; escape them (and the escape character) so they match themselves.
  const pattern = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
  const { rows } = await db.query<PlayerRow>(
    `WITH board AS (
       SELECT uid, rank, score::float8 AS score, return_pct::float8 AS return_pct,
              max_drawdown_pct::float8 AS max_drawdown_pct, return_rank::float8 AS return_rank,
              stability_rank::float8 AS stability_rank
       FROM standings
       WHERE day = $1::date
     ), pend AS (
       SELECT uid, count(*)::int AS n FROM orders WHERE status = 'pending' GROUP BY uid
     ), vis AS (
       SELECT uid, count(*)::int AS n FROM app_opens WHERE at >= $4 GROUP BY uid
     )
     SELECT u.uid, u.display_name, u.email, 'admin' = ANY(u.roles) AS is_admin, u.created_at,
            p.equity::float8 AS total_value,
            board.rank, board.score, board.return_pct, board.max_drawdown_pct, board.return_rank, board.stability_rank,
            COALESCE(pend.n, 0) AS pending,
            u.last_seen_at, COALESCE(vis.n, 0) AS visits_today
     FROM users u
     JOIN portfolios p ON p.uid = u.uid
     LEFT JOIN board ON board.uid = u.uid
     LEFT JOIN pend ON pend.uid = u.uid
     LEFT JOIN vis ON vis.uid = u.uid
     WHERE $2::text IS NULL OR u.display_name ILIKE $2 OR u.email ILIKE $2
     ORDER BY board.rank NULLS LAST, p.equity DESC, u.uid
     LIMIT $3`,
    [shown?.day ?? null, pattern, PLAYERS_LIMIT, realTodayStart()],
  );

  return {
    limit: PLAYERS_LIMIT,
    players: rows.map(
      (r): AdminPlayer => ({
        uid: r.uid,
        name: r.display_name,
        email: r.email,
        isAdmin: r.is_admin,
        joinedAt: r.created_at.toISOString(),
        totalValue: r.total_value,
        rank: r.rank,
        score: r.score,
        returnPct: r.return_pct,
        maxDrawdownPct: r.max_drawdown_pct,
        returnRank: r.return_rank,
        stabilityRank: r.stability_rank,
        pendingOrders: r.pending,
        lastSeenAt: r.last_seen_at?.toISOString() ?? null,
        visitsToday: r.visits_today,
      }),
    ),
  };
}
