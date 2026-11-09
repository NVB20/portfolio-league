// GET /me/dashboard: everything the player's main screen shows, read from Postgres in one request.
// Every date filter uses the WORLD clock, never the real clock, so the dashboard shows the game's "now".
// Empty tables give empty fields (null / []), never invented numbers.
//
// Prices until Phase 2 decides intraday pricing: a holding is valued at the latest daily close that has
// already happened in world time (D-009). Today's close only counts after that market has closed.

import type { Pool } from 'pg';
import type {
  ClockView,
  Dashboard,
  HoldingView,
  LeaderRow,
  OrderView,
  Point,
  PortfolioView,
  StandingView,
  UsdIlsView,
  WorldTime,
} from './contract.js';
import { isMarketOpen, lastClosedDay, sessionOn } from './game/marketHours.js';
import { isNearCap, maxDrawdownPct, returnPct, weightPct } from './game/performance.js';
import { addDays, hhmm, ISRAEL, isoWeek, mondayOf, weekdayOf, zonedParts, zonedToInstant } from './game/time.js';

const LEADERBOARD_TOP = 5;
const PENDING_SHOWN = 2;   // DD-07
const ANONYMOUS_NAME = 'שחקן';

// The world clock's "now", the window of the current competition week, and the last date whose
// closing price is already known for each market (prices after it are still the future).
export type Now = {
  at: Date;
  today: string;
  monday: string;
  weekStart: Date;
  closed: { tase: string; us: string; fx: string };
};

// Returns null when the user has no portfolio row yet (POST /me was never called).
export async function getDashboard(db: Pool, uid: string): Promise<Dashboard | null> {
  // Sequential on purpose: one request holds at most one pool connection at a time,
  // so a burst of players can't starve the pool (max 10 connections).
  const now = await loadNow(db);
  const owned = await loadPortfolio(db, uid, now);
  if (!owned) return null;

  const series = now ? await loadWeekSeries(db, uid, now) : { you: [], median: [] };
  const competition = now ? await loadCompetition(db, uid, now) : { standing: null, leaderboard: { players: 0, top: [] } };

  const youValues = series.you.map((p) => p.value);
  const youReturn = returnPct(youValues);
  const medianReturn = returnPct(series.median.map((p) => p.value));

  const portfolio: PortfolioView = {
    totalValue: owned.totalValue,
    cash: owned.cash,
    weekReturnPct: youReturn,
    maxDrawdownPct: youValues.length >= 2 ? maxDrawdownPct(youValues) : null,
    vsMedianPct: youReturn !== null && medianReturn !== null ? youReturn - medianReturn : null,
    series: series.you,
    medianSeries: series.median,
  };

  return {
    clock: now ? clockView(now.at) : null,
    portfolio,
    holdings: owned.holdings,
    pendingOrders: await loadPendingOrders(db, uid),
    usdIls: await loadUsdIls(db, now),
    standing: competition.standing,
    leaderboard: competition.leaderboard,
  };
}

// ---------- clock ----------

export async function loadNow(db: Pool): Promise<Now | null> {
  const { rows } = await db.query<{ now_at: Date }>('SELECT now_at FROM world_clock');
  if (rows.length === 0) return null;
  const at = rows[0].now_at;
  const today = zonedParts(at, ISRAEL).date;
  const monday = mondayOf(today);
  return {
    at,
    today,
    monday,
    weekStart: zonedToInstant(monday, 0, ISRAEL),
    // The rate's daily close is only final once the day is over, so it is always yesterday's.
    closed: { tase: lastClosedDay('TASE', at), us: lastClosedDay('US', at), fx: addDays(today, -1) },
  };
}

export function worldTime(at: Date): WorldTime {
  const z = zonedParts(at, ISRAEL);
  return { at: at.toISOString(), date: z.date, weekday: z.weekday, time: hhmm(z.minutes) };
}

export function clockView(at: Date): ClockView {
  const t = worldTime(at);
  return {
    ...t,
    week: isoWeek(t.date),
    weekStartAt: zonedToInstant(mondayOf(t.date), 0, ISRAEL).toISOString(),
    markets: {
      tase: { isOpen: isMarketOpen('TASE', at), session: sessionOn('TASE', t.date) },
      us: { isOpen: isMarketOpen('US', at), session: sessionOn('US', t.date) },
    },
  };
}

// ---------- portfolio + holdings ----------

type HoldingRow = {
  cash: number;
  symbol: string | null;            // null = the LEFT JOIN found no holdings
  units: number | null;
  name_he: string;
  exchange: HoldingView['exchange'];
  currency: HoldingView['currency'];
  value_ils: number | null;         // null = no price (or no USD rate) yet
  day_change_pct: number | null;
};

export async function loadPortfolio(db: Pool, uid: string, now: Now | null) {
  // One row per holding (or one row with NULL holding columns when there are none).
  // Values are computed in NUMERIC and only turned into float8 for the JSON.
  const { rows } = await db.query<HoldingRow>(
    `WITH fx AS (
       SELECT close FROM usd_ils WHERE ($4::date IS NULL OR day <= $4::date) ORDER BY day DESC LIMIT 1
     )
     SELECT p.cash::float8 AS cash,
            h.symbol, h.units::float8 AS units, s.name_he, s.exchange, s.currency,
            (h.units * px.close * CASE WHEN s.currency = 'USD' THEN (SELECT close FROM fx) ELSE 1 END)::float8 AS value_ils,
            ((px.close / px.prev_close - 1) * 100)::float8 AS day_change_pct
     FROM portfolios p
     LEFT JOIN holdings h ON h.uid = p.uid
     LEFT JOIN securities s ON s.symbol = h.symbol
     LEFT JOIN LATERAL (
       SELECT max(t.close) FILTER (WHERE t.rn = 1) AS close,
              max(t.close) FILTER (WHERE t.rn = 2) AS prev_close
       FROM (SELECT close, row_number() OVER (ORDER BY day DESC) AS rn
             FROM prices
             WHERE symbol = h.symbol
               AND ($2::date IS NULL OR day <= CASE WHEN s.market = 'TASE' THEN $2::date ELSE $3::date END)
             ORDER BY day DESC LIMIT 2) t
     ) px ON TRUE
     WHERE p.uid = $1
     ORDER BY value_ils DESC NULLS LAST, h.symbol`,
    [uid, now?.closed.tase ?? null, now?.closed.us ?? null, now?.closed.fx ?? null],
  );
  if (rows.length === 0) return null;

  const cash = rows[0].cash;
  const held = rows.filter((r) => r.symbol !== null);
  const totalValue = cash + held.reduce((sum, r) => sum + (r.value_ils ?? 0), 0);

  const holdings: HoldingView[] = held.map((r) => {
    const weight = r.value_ils === null ? null : weightPct(r.value_ils, totalValue);
    return {
      symbol: r.symbol!,
      nameHe: r.name_he,
      exchange: r.exchange,
      currency: r.currency,
      units: r.units!,
      valueIls: r.value_ils,
      dayChangePct: r.day_change_pct,
      weightPct: weight,
      nearCap: isNearCap(weight),
    };
  });

  return { cash, totalValue, holdings };
}

// ---------- chart: you vs. the median player this week ----------

async function loadWeekSeries(db: Pool, uid: string, now: Now) {
  const window = [now.weekStart, now.at];
  const you = await db.query<{ at: Date; value: number }>(
    `SELECT at, value_ils::float8 AS value FROM portfolio_snapshots
     WHERE uid = $1 AND at >= $2 AND at <= $3 ORDER BY at`,
    [uid, ...window],
  );
  // The median of all players at each snapshot moment. Fine for now; at scale the scorer can store it.
  const median = await db.query<{ at: Date; value: number }>(
    `SELECT at, percentile_cont(0.5) WITHIN GROUP (ORDER BY value_ils)::float8 AS value
     FROM portfolio_snapshots WHERE at >= $1 AND at <= $2 GROUP BY at ORDER BY at`,
    window,
  );
  const toPoints = (rows: { at: Date; value: number }[]): Point[] =>
    rows.map((r) => ({ at: r.at.toISOString(), value: r.value }));
  return { you: toPoints(you.rows), median: toPoints(median.rows) };
}

// ---------- pending orders ----------

async function loadPendingOrders(db: Pool, uid: string): Promise<Dashboard['pendingOrders']> {
  // count(*) OVER () is computed before LIMIT, so `total` counts all pending orders, not just the 2 shown.
  const { rows } = await db.query<{
    id: string;
    symbol: string;
    side: OrderView['side'];
    amount_ils: number;
    price_type: OrderView['priceType'];
    executes_at: Date;
    market: OrderView['market'];
    total: number;
  }>(
    `SELECT o.id::text AS id, o.symbol, o.side, o.amount_ils::float8 AS amount_ils, o.price_type,
            o.executes_at, s.market, count(*) OVER ()::int AS total
     FROM orders o JOIN securities s ON s.symbol = o.symbol
     WHERE o.uid = $1 AND o.status = 'pending'
     ORDER BY o.executes_at, o.id
     LIMIT $2`,
    [uid, PENDING_SHOWN],
  );
  return {
    total: rows[0]?.total ?? 0,
    next: rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      amountIls: r.amount_ils,
      priceType: r.price_type,
      market: r.market,
      executesAt: worldTime(r.executes_at),
    })),
  };
}

// ---------- USD/ILS ----------

export async function loadUsdIls(db: Pool, now: Now | null): Promise<UsdIlsView | null> {
  // Dates come back as text: pg would turn a DATE into a JS Date at local midnight and shift the day.
  // A week of closes plus the close before Monday (the base for "change this week").
  const { rows } = await db.query<{ day: string; close: number }>(
    `SELECT day::text AS day, close::float8 AS close FROM usd_ils
     WHERE ($1::date IS NULL OR day <= $1::date)
       AND ($2::date IS NULL OR day >= $2::date - 7)
     ORDER BY day`,
    [now?.closed.fx ?? null, now?.monday ?? null],
  );
  if (rows.length === 0) return null;

  const latest = rows[rows.length - 1];
  if (!now) return { rate: latest.close, weekChangePct: null, series: [] };

  const week = rows.filter((r) => r.day >= now.monday);
  const base = rows.filter((r) => r.day < now.monday).pop();
  return {
    rate: latest.close,
    // Monday before the first close of the week: nothing has changed yet, so no number (not "0%").
    weekChangePct: base && week.length > 0 ? returnPct([base.close, latest.close]) : null,
    series: week.map((r) => ({ at: r.day, value: r.close })),
  };
}

// ---------- competition: your standing + the top of the table ----------

async function loadCompetition(
  db: Pool,
  uid: string,
  now: Now,
): Promise<{ standing: StandingView | null; leaderboard: Dashboard['leaderboard'] }> {
  const empty = { standing: null, leaderboard: { players: 0, top: [] } };

  // The latest scored day of this week = the current table.
  const latest = await db.query<{ day: string | null; players: number }>(
    `WITH d AS (SELECT max(day) AS day FROM standings WHERE day BETWEEN $1 AND $2)
     SELECT d.day::text AS day, (SELECT count(*)::int FROM standings s WHERE s.day = d.day) AS players FROM d`,
    [now.monday, now.today],
  );
  const day = latest.rows[0]?.day;
  if (!day) return empty;
  const players = latest.rows[0].players;

  const top = await db.query<{ rank: number; name: string; return_pct: number; score: number; is_me: boolean }>(
    `SELECT st.rank, COALESCE(u.display_name, $3) AS name, st.return_pct::float8 AS return_pct,
            st.score::float8 AS score, st.uid = $2 AS is_me
     FROM standings st JOIN users u ON u.uid = st.uid
     WHERE st.day = $1 ORDER BY st.rank LIMIT $4`,
    [day, uid, ANONYMOUS_NAME, LEADERBOARD_TOP],
  );
  const leaderboard = {
    players,
    top: top.rows.map(
      (r): LeaderRow => ({ rank: r.rank, name: r.name, returnPct: r.return_pct, score: r.score, isMe: r.is_me }),
    ),
  };

  // My rows this week (Mon..latest day): the last one is my standing, the one before gives the rank change.
  const mine = await db.query<{
    day: string;
    score: number;
    rank: number;
    return_rank: number;
    stability_rank: number;
  }>(
    `SELECT day::text AS day, score::float8 AS score, rank, return_rank::float8 AS return_rank,
            stability_rank::float8 AS stability_rank
     FROM standings WHERE uid = $1 AND day BETWEEN $2 AND $3 ORDER BY day`,
    [uid, now.monday, day],
  );
  const current = mine.rows[mine.rows.length - 1];
  if (!current || current.day !== day) return { standing: null, leaderboard };   // not scored today (e.g. joined late)

  const previous = mine.rows[mine.rows.length - 2];
  return {
    leaderboard,
    standing: {
      rank: current.rank,
      players,
      score: current.score,
      returnRank: current.return_rank,
      stabilityRank: current.stability_rank,
      rankChange: previous ? previous.rank - current.rank : null,
      days: mine.rows.map((r) => ({ date: r.day, weekday: weekdayOf(r.day), score: r.score })),
    },
  };
}
