// GET /me/dashboard: everything the player's main screen shows, read from Postgres in one request.
// Every date filter uses the WORLD clock, never the real clock, so the dashboard shows the game's "now". The one
// exception is the daily streak, which counts real days (D-039, streak.ts).
// Empty tables give empty fields (null / []), never invented numbers.
//
// Money is read, never added up (D-031): cash, totals, each holding's value and the week's running totals are
// the columns the runner stores at every open and close (D-019, D-024). Before reading, the player is brought
// up to the latest event whose prices are in effect (D-025). Values stay exact (bigint) until the JSON.
// Only display percentages (a holding's day change, the dollar's week change) still come from the closes.

import type { Pool } from 'pg';
import type {
  ClockView,
  Dashboard,
  HoldingView,
  LiveClockView,
  MarketSession,
  OrderView,
  Point,
  PortfolioView,
  RejectionView,
  StopSaleView,
  StopView,
  StandingView,
  UsdIlsView,
  WorldTime,
} from './contract.js';
import { type Calendar, lastClosedDay, marketStatus, type MarketStatus } from './game/marketHours.js';
import { worldNow } from './game/clock.js';
import { format, parse, pct, SCALE } from './game/fixed.js';
import { weekReturnPct, type WeekState } from './game/week.js';
import { loadCalendar } from './calendar.js';
import { catchUpPlayer } from './runner.js';
import { isNearCap, returnPct } from './game/performance.js';
import { loadStreak } from './streak.js';
import { addDays, hhmm, ISRAEL, isoWeek, mondayOf, zonedParts, zonedToInstant } from './game/time.js';
// leaderboard.ts imports loadNow and ANONYMOUS_NAME back from here; both sides only call each other at run time.
import { boardWeek, type Db, inSnapshot, leaderRow, loadBoard, loadRows, loadStanding } from './leaderboard.js';

const LEADERBOARD_TOP = 5;
const PENDING_SHOWN = 2;      // DD-07
const REJECTIONS_SHOWN = 5;   // D-023: the toast lists at most this many
export const ANONYMOUS_NAME = 'שחקן';   // the board's name for a player with no display name (never the email)
const MAX_BIGINT = 9_223_372_036_854_775_807n;   // Postgres BIGINT, the type of orders.id

// The world clock's "now", the window of the current competition week, and the last date whose
// closing price is already known for each market (prices after it are still the future).
export type Now = {
  at: Date;                    // the effective world time (worldNow): what screens show and orders use
  nowAt: Date;                 // the stored anchor, world_clock.now_at: where the clock was last set
  calendar: Calendar;          // the market calendar (D-016): every screen and rule uses the same one
  running: boolean;            // the admin's start/stop (D-017)
  endsAt: Date | null;         // the clock never passes this (D-017)
  eventsThrough: Date | null;  // the latest event the runner has started (D-021); `at` is never before it
  today: string;
  monday: string;
  weekStart: Date;
  closed: { tase: string; us: string; fx: string };
};

// Returns null when the user has no portfolio row yet (POST /me was never called).
export async function getDashboard(db: Pool, uid: string): Promise<Dashboard | null> {
  // Sequential on purpose: one request holds at most one pool connection at a time,
  // so a burst of players can't starve the pool (max 10 connections).
  await catchUp(db, uid);
  const now = await loadNow(db);
  const owned = await loadPortfolio(db, uid, now);
  if (!owned) return null;

  const week = now ? await loadWeek(db, uid, now, owned) : NO_WEEK;
  const competition = now ? await loadCompetition(db, uid, now) : NO_COMPETITION;

  return {
    clock: now ? liveClockView(now) : null,
    portfolio: { ...owned.totals, ...week },
    holdings: owned.holdings,
    pendingOrders: await loadPendingOrders(db, uid),
    rejections: await loadRejections(db, uid),
    stopSales: await loadStopSales(db, uid),
    usdIls: await loadUsdIls(db, now),
    standing: competition.standing,
    leaderboard: competition.leaderboard,
    streak: await loadStreak(db, uid),   // real days, not world time (D-039)
  };
}

// D-025: brings the player up to the latest event whose prices are in effect, so an online player never sees a
// value the runner's batch hasn't reached yet. A failure must not take the screen down: it is logged, and the
// stored values are shown (the batch brings them up to date anyway).
export async function catchUp(db: Pool, uid: string): Promise<void> {
  try {
    await catchUpPlayer(db, uid);
  } catch (err) {
    console.error(`catch-up on read failed for ${uid}`, err);
  }
}

// The JSON edge: an exact value becomes a JS number, for display only (contract.ts).
function shown(v: bigint, scale: number): number {
  return Number(format(v, scale));
}

// ---------- clock ----------

// The world_clock columns behind "now", as SQL returns them. Order sending and the runner select the same
// columns under their own lock (FOR SHARE / FOR UPDATE) and pass the row to `effectiveNow`, so every "now"
// in the API comes from one formula. now() is the transaction's start, in real time.
export const CLOCK_COLUMNS = 'now_at, real_at, running, ends_at, events_through, now() AS real_now';

export type ClockSqlRow = {
  now_at: Date;
  real_at: Date;
  running: boolean;
  ends_at: Date | null;
  events_through: Date | null;
  real_now: Date;
};

export function effectiveNow(row: ClockSqlRow, calendar: Calendar): Date {
  return worldNow(
    { nowAt: row.now_at, realAt: row.real_at, running: row.running, endsAt: row.ends_at, eventsThrough: row.events_through },
    row.real_now,
    calendar,
  );
}

// While the clock runs (D-017), "now" is the stored world time plus the real time since it was stored,
// skipping days when neither market opens, and never past `ends_at`. It is never before the latest event
// the runner has started, so the screens agree with the order rules during an admin jump.
export async function loadNow(db: Pool): Promise<Now | null> {
  const { rows } = await db.query<ClockSqlRow>(`SELECT ${CLOCK_COLUMNS} FROM world_clock`);
  if (rows.length === 0) return null;
  const clock = rows[0];
  const calendar = await loadCalendar(db);
  const at = effectiveNow(clock, calendar);
  const today = zonedParts(at, ISRAEL).date;
  const monday = mondayOf(today);
  return {
    at,
    nowAt: clock.now_at,
    calendar,
    running: clock.running,
    endsAt: clock.ends_at,
    eventsThrough: clock.events_through,
    today,
    monday,
    weekStart: zonedToInstant(monday, 0, ISRAEL),
    // The rate's daily close is only final once the day is over, so it is always yesterday's.
    closed: { tase: lastClosedDay('TASE', at, calendar), us: lastClosedDay('US', at, calendar), fx: addDays(today, -1) },
  };
}

export function worldTime(at: Date): WorldTime {
  const z = zonedParts(at, ISRAEL);
  return { at: at.toISOString(), date: z.date, weekday: z.weekday, time: hhmm(z.minutes) };
}

export function clockView(at: Date, calendar: Calendar): ClockView {
  const t = worldTime(at);
  return {
    ...t,
    week: isoWeek(t.date),
    weekStartAt: zonedToInstant(mondayOf(t.date), 0, ISRAEL).toISOString(),
    markets: {
      tase: marketView(marketStatus('TASE', at, calendar)),
      us: marketView(marketStatus('US', at, calendar)),
    },
  };
}

// The clock as the dashboard and the trading screen show it: the world time plus what the admin controls.
export function liveClockView(now: Now): LiveClockView {
  return { ...clockView(now.at, now.calendar), running: now.running, endsAt: now.endsAt ? worldTime(now.endsAt) : null };
}

// One market's status for the screens (D-022): open or not, today's hours, why it's closed, when it opens next.
function marketView(s: MarketStatus): MarketSession {
  return {
    isOpen: s.state === 'open',
    session: s.session,
    state: s.state,
    reason: s.reason,
    nextOpen: s.nextOpenAt ? worldTime(s.nextOpenAt) : null,
  };
}

// ---------- portfolio + holdings ----------

// NUMERIC columns come back as text and are parsed exactly (fixed.ts). The holding columns are null on the
// one row the LEFT JOIN returns for a player with no open position.
type PortfolioRow = {
  cash: string;
  reserved_cash: string;
  available_cash: string;
  equity: string;
  realized_pnl: string;
  unrealized_pnl: string;
  week_start: string | null;
  week_start_value: string | null;
  peak_value: string | null;
  max_drawdown_pct: string;
  last_event_at: Date | null;
  symbol: string | null;
  name_he: string;
  exchange: HoldingView['exchange'];
  currency: HoldingView['currency'];
  units: string | null;
  reserved_units: string | null;
  value_ils: string | null;
  cost_basis_ils: string | null;
  unrealized_pnl_ils: string | null;
  day_change_pct: number | null;
  last_close: number | null;
};

export type OwnedPortfolio = {
  totals: Pick<PortfolioView, 'totalValue' | 'cash' | 'availableCash' | 'reservedCash' | 'realizedPnl' | 'unrealizedPnl'>;
  equity: bigint;            // ILS, exact: the week numbers are worked out from it
  week: WeekState;           // the stored weekly running totals (D-024)
  holdings: HoldingView[];   // open positions, biggest first
};

// The player's stored balances (D-019) and open positions. Nothing is added up: the total is the stored equity
// even if it disagreed with the holdings, and a holding's value is its last mark (at cost until the first one;
// the runner marks a position when it fills, so that is only a fallback).
export async function loadPortfolio(db: Pool, uid: string, now: Now | null): Promise<OwnedPortfolio | null> {
  // One row per open position (or one row with NULL position columns when there are none). The day change is a
  // display % from the latest known closes, as before the runner (the value itself is the mark).
  const { rows } = await db.query<PortfolioRow>(
    `SELECT p.cash::text AS cash, p.reserved_cash::text AS reserved_cash, p.available_cash::text AS available_cash,
            p.equity::text AS equity, p.realized_pnl::text AS realized_pnl, p.unrealized_pnl::text AS unrealized_pnl,
            p.week_start::text AS week_start, p.week_start_value::text AS week_start_value,
            p.peak_value::text AS peak_value, p.max_drawdown_pct::text AS max_drawdown_pct, p.last_event_at,
            x.symbol, s.name_he, s.exchange, s.currency,
            x.units::text AS units, x.reserved_units::text AS reserved_units,
            COALESCE(x.market_value_ils, x.cost_basis_ils)::text AS value_ils,
            x.cost_basis_ils::text AS cost_basis_ils,
            COALESCE(x.unrealized_pnl_ils, 0)::text AS unrealized_pnl_ils,
            ((px.close / px.prev_close - 1) * 100)::float8 AS day_change_pct, px.close::float8 AS last_close
     FROM portfolios p
     LEFT JOIN positions x ON x.uid = p.uid AND x.status = 'open'
     LEFT JOIN securities s ON s.symbol = x.symbol
     LEFT JOIN LATERAL (
       SELECT max(t.close) FILTER (WHERE t.rn = 1) AS close,
              max(t.close) FILTER (WHERE t.rn = 2) AS prev_close
       FROM (SELECT close, row_number() OVER (ORDER BY day DESC) AS rn
             FROM prices
             WHERE symbol = x.symbol
               AND ($2::date IS NULL OR day <= CASE WHEN s.market = 'TASE' THEN $2::date ELSE $3::date END)
             ORDER BY day DESC LIMIT 2) t
     ) px ON TRUE
     WHERE p.uid = $1
     ORDER BY COALESCE(x.market_value_ils, x.cost_basis_ils) DESC NULLS LAST, x.symbol`,
    [uid, now?.closed.tase ?? null, now?.closed.us ?? null],
  );
  if (rows.length === 0) return null;

  const p = rows[0];
  const equity = parse(p.equity, SCALE.ILS);
  const stops = rows.some((r) => r.symbol !== null) ? await loadStops(db, uid) : new Map<string, StopView[]>();
  const holdings: HoldingView[] = rows
    .filter((r) => r.symbol !== null)
    .map((r) => {
      const value = parse(r.value_ils!, SCALE.ILS);
      const units = parse(r.units!, SCALE.UNITS);
      // Exact share of the stored equity, to 4 decimals. A display number, but never rounded twice.
      const weight = equity > 0n ? shown(pct(value, equity), SCALE.PCT) : null;
      return {
        symbol: r.symbol!,
        nameHe: r.name_he,
        exchange: r.exchange,
        currency: r.currency,
        units: shown(units, SCALE.UNITS),
        freeUnits: shown(units - parse(r.reserved_units!, SCALE.UNITS), SCALE.UNITS),
        valueIls: shown(value, SCALE.ILS),
        costBasisIls: shown(parse(r.cost_basis_ils!, SCALE.ILS), SCALE.ILS),
        unrealizedPnlIls: shown(parse(r.unrealized_pnl_ils!, SCALE.ILS), SCALE.ILS),
        dayChangePct: r.day_change_pct,
        weightPct: weight,
        nearCap: isNearCap(weight),
        stops: stops.get(r.symbol!) ?? [],
        lastClose: r.last_close,
      };
    });

  return {
    totals: {
      totalValue: shown(equity, SCALE.ILS),
      cash: shown(parse(p.cash, SCALE.ILS), SCALE.ILS),
      availableCash: shown(parse(p.available_cash, SCALE.ILS), SCALE.ILS),
      reservedCash: shown(parse(p.reserved_cash, SCALE.ILS), SCALE.ILS),
      realizedPnl: shown(parse(p.realized_pnl, SCALE.ILS), SCALE.ILS),
      unrealizedPnl: shown(parse(p.unrealized_pnl, SCALE.ILS), SCALE.ILS),
    },
    equity,
    week: {
      weekStart: p.week_start,
      weekStartValue: p.week_start_value === null ? null : parse(p.week_start_value, SCALE.ILS),
      peakValue: p.peak_value === null ? null : parse(p.peak_value, SCALE.ILS),
      maxDrawdownPct: parse(p.max_drawdown_pct, SCALE.PCT),
      lastEventAt: p.last_event_at,
    },
    holdings,
  };
}

// The active stop losses of the player's open positions, per stock, highest first (D-037). From the player's open
// positions (positions_uid_idx) to their stops (stop_orders_position_idx): never a scan of every active stop. The
// price each was sent with is its buy's (orders' primary key), so a moved one can say where it was (D-041).
async function loadStops(db: Pool, uid: string): Promise<Map<string, StopView[]>> {
  const { rows } = await db.query<{ symbol: string; id: string; price: number; original: number; units: number }>(
    `SELECT so.symbol, so.id::text AS id, so.stop_price::float8 AS price, o.stop_price::float8 AS original,
            so.units::float8 AS units
     FROM positions x
     JOIN stop_orders so ON so.position_id = x.id AND so.status = 'active'
     JOIN orders o ON o.id = so.buy_order_id
     WHERE x.uid = $1 AND x.status = 'open'
     ORDER BY so.symbol, so.stop_price DESC, so.id`,
    [uid],
  );
  const out = new Map<string, StopView[]>();
  for (const r of rows) {
    out.set(r.symbol, [...(out.get(r.symbol) ?? []), { id: r.id, price: r.price, originalPrice: r.original, units: r.units }]);
  }
  return out;
}

// ---------- the week: you vs. the median player (D-024) ----------

type WeekView = Pick<PortfolioView, 'weekReturnPct' | 'maxDrawdownPct' | 'vsMedianPct' | 'series' | 'medianSeries'>;

const NO_WEEK: WeekView = { weekReturnPct: null, maxDrawdownPct: null, vsMedianPct: null, series: [], medianSeries: [] };

// The week's numbers come from the running totals, never from the chart points: the totals see every open and
// close, the chart only one point per day. A row whose week_start isn't this week wasn't touched this week, so
// its value hasn't changed: 0% return, 0% drawdown, and a flat line from Monday (D-024).
async function loadWeek(db: Pool, uid: string, now: Now, owned: OwnedPortfolio): Promise<WeekView> {
  const thisWeek = owned.week.weekStart === now.monday;   // now.monday is weekOf(now.at), the runner's week key
  const snapshots = await db.query<{ at: Date; value: number }>(
    `SELECT at, value_ils::float8 AS value FROM portfolio_snapshots
     WHERE uid = $1 AND at >= $2 AND at <= $3 ORDER BY at`,
    [uid, now.weekStart, now.at],
  );
  // The median player line: one row per finished open or close (D-024). At the same instant a close runs
  // before an open, so the open is the later one.
  const events = await db.query<{ at: Date; value: number | null; return_pct: string | null }>(
    `SELECT at, median_value::float8 AS value, median_return_pct::text AS return_pct FROM market_events
     WHERE status = 'done' AND at >= $1 AND at <= $2
     ORDER BY at, kind = 'open', id`,
    [now.weekStart, now.at],
  );

  const ret = weekReturnPct(owned.week, owned.equity, now.monday);
  const latest = events.rows[events.rows.length - 1];
  const medianReturn = latest?.return_pct == null ? null : parse(latest.return_pct, SCALE.PCT);
  const start = thisWeek && owned.week.weekStartValue !== null ? owned.week.weekStartValue : owned.equity;

  return {
    weekReturnPct: shown(ret, SCALE.PCT),
    maxDrawdownPct: thisWeek ? shown(owned.week.maxDrawdownPct, SCALE.PCT) : 0,
    vsMedianPct: medianReturn === null ? null : shown(ret - medianReturn, SCALE.PCT),
    series: onePerInstant([
      { at: now.weekStart.toISOString(), value: shown(start, SCALE.ILS) },
      ...snapshots.rows.map((r) => ({ at: r.at.toISOString(), value: r.value })),
      { at: now.at.toISOString(), value: shown(owned.equity, SCALE.ILS) },
    ]),
    medianSeries: onePerInstant(
      events.rows.filter((r) => r.value !== null).map((r) => ({ at: r.at.toISOString(), value: r.value! })),
    ),
  };
}

// Points in time order, one per instant, the later one winning: "now" can fall on a daily row (the clock right
// after a day's last event), and a close and an open can share a minute.
function onePerInstant(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (out.length > 0 && out[out.length - 1].at === p.at) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

// ---------- pending orders ----------

async function loadPendingOrders(db: Pool, uid: string): Promise<Dashboard['pendingOrders']> {
  // count(*) OVER () is computed before LIMIT, so `total` counts all pending orders, not just the 2 shown.
  const { rows } = await db.query<{
    id: string;
    symbol: string;
    side: OrderView['side'];
    amount_ils: number | null;
    units: number | null;
    price_type: OrderView['priceType'];
    executes_at: Date;
    market: OrderView['market'];
    stop_price: number | null;
    total: number;
  }>(
    `SELECT o.id::text AS id, o.symbol, o.side, o.amount_ils::float8 AS amount_ils, o.units::float8 AS units, o.price_type,
            o.executes_at, s.market, o.stop_price::float8 AS stop_price, count(*) OVER ()::int AS total
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
      units: r.units,
      priceType: r.price_type,
      market: r.market,
      executesAt: worldTime(r.executes_at),
      stopPrice: r.stop_price,
    })),
  };
}

// ---------- rejection toasts (D-023) ----------

// The rejected orders the player hasn't seen yet, newest rejection first (the event's world time, then the
// order id), at most 5. Uses orders_unseen_rejections_idx: a row leaves it once seen.
async function loadRejections(db: Pool, uid: string): Promise<RejectionView[]> {
  const { rows } = await db.query<{
    id: string;
    symbol: string;
    side: RejectionView['side'];
    amount_ils: number | null;
    units: number | null;
    reject_code: RejectionView['code'];
    reject_reason: string;
    at: Date;
  }>(
    `SELECT o.id::text AS id, o.symbol, o.side, o.amount_ils::float8 AS amount_ils, o.units::float8 AS units,
            o.reject_code, o.reject_reason, e.at
     FROM orders o JOIN market_events e ON e.id = o.event_id
     WHERE o.uid = $1 AND o.status = 'rejected' AND o.notified_at IS NULL
     ORDER BY e.at DESC, o.id DESC
     LIMIT $2`,
    [uid, REJECTIONS_SHOWN],
  );
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    amountIls: r.amount_ils,
    units: r.units,
    code: r.reject_code,
    reason: r.reject_reason,
    at: worldTime(r.at),
  }));
}

// ---------- stop-sale toasts (D-037) ----------

// The sales a stop loss made that the player hasn't seen yet, newest first, at most 5. Uses
// orders_unseen_stop_sales_idx: a row leaves it once seen.
async function loadStopSales(db: Pool, uid: string): Promise<StopSaleView[]> {
  const { rows } = await db.query<{
    id: string; symbol: string; currency: StopSaleView['currency']; stop_price: number; fill_price: number;
    units: number; ils: number; realized: number; at: Date;
  }>(
    `SELECT o.id::text AS id, o.symbol, s.currency, so.stop_price::float8 AS stop_price, o.fill_price::float8 AS fill_price,
            o.filled_units::float8 AS units, o.filled_ils::float8 AS ils, o.realized_pnl_ils::float8 AS realized, e.at
     FROM orders o
     JOIN stop_orders so ON so.id = o.stop_id
     JOIN securities s ON s.symbol = o.symbol
     JOIN market_events e ON e.id = o.event_id
     WHERE o.uid = $1 AND o.origin = 'stop' AND o.status = 'executed' AND o.notified_at IS NULL
     ORDER BY e.at DESC, o.id DESC
     LIMIT $2`,
    [uid, REJECTIONS_SHOWN],
  );
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    currency: r.currency,
    stopPrice: r.stop_price,
    fillPrice: r.fill_price,
    units: r.units,
    ils: r.ils,
    realizedPnlIls: r.realized,
    at: worldTime(r.at),
  }));
}

// The body of POST /me/rejections/seen: { ids }, the rejections the app showed, 1 to 5 order ids as the API sends
// them (strings of digits that fit a BIGINT). Exactly those, not "everything up to an id": order ids follow the
// order orders were SENT, while rejections come at the events, so a rejection of a lower id can arrive between
// the dashboard read and this call, and "up to" would mark a toast nobody saw (D-023). Anything else → null,
// answered with 400.
export function parseSeenIds(body: unknown): string[] | null {
  const ids = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).ids : undefined;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > REJECTIONS_SHOWN) return null;
  for (const v of ids) {
    if (typeof v !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(v) || BigInt(v) > MAX_BIGINT) return null;
  }
  return ids as string[];
}

// Marks these of the player's rejected orders and stop sales (D-037) as seen (real time). Only their own rows, only
// rejected ones or executed stop sales not seen yet; an id that is someone else's, pending, a plain fill or already
// seen marks nothing, so a retry is harmless.
// Returns how many were marked, or null when the player has no portfolio (POST /me never called). One
// statement; the primary key finds the rows.
export async function markRejectionsSeen(db: Pool, uid: string, ids: string[]): Promise<number | null> {
  const { rows } = await db.query<{ known: boolean; marked: number }>(
    `WITH seen AS (
       UPDATE orders SET notified_at = now()
       WHERE uid = $1 AND id = ANY($2::bigint[]) AND notified_at IS NULL
         AND (status = 'rejected' OR (origin = 'stop' AND status = 'executed'))
       RETURNING 1
     )
     SELECT EXISTS (SELECT 1 FROM portfolios WHERE uid = $1) AS known, (SELECT count(*)::int FROM seen) AS marked`,
    [uid, ids],
  );
  return rows[0].known ? rows[0].marked : null;
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

type Competition = { standing: StandingView | null; leaderboard: Dashboard['leaderboard'] };

const NO_COMPETITION: Competition = { standing: null, leaderboard: { players: 0, week: null, top: [] } };

// The same board as GET /me/leaderboard (D-032, leaderboard.ts): the latest scored day up to today, so on the
// weekend and on Monday before the first open it is the week that just closed. Index lookups only, in one snapshot
// (inSnapshot), so the top 5 and my standing always come from the same ranking, even while the scoring rewrites it.
function loadCompetition(db: Pool, uid: string, now: Now): Promise<Competition> {
  return inSnapshot(db, (c) => readCompetition(c, uid, now));
}

async function readCompetition(db: Db, uid: string, now: Now): Promise<Competition> {
  const board = await loadBoard(db, now);
  if (!board) return NO_COMPETITION;

  const top = await loadRows(db, board, uid, 1, LEADERBOARD_TOP);
  // null = I'm not on this board (not ranked this week, e.g. joined late).
  const me = await loadStanding(db, board, uid);
  return {
    leaderboard: { players: board.players, week: boardWeek(board), top: top.map(leaderRow) },
    standing: me && {
      rank: me.rank,
      players: me.players,
      score: me.score,
      returnRank: me.returnRank,
      stabilityRank: me.stabilityRank,
      rankChange: me.rankChange,   // vs. the previous scored day of the week; null on its first
      days: me.days,               // Mon..the board's day
      maxDrawdownPct: me.maxDrawdownPct,   // the board's week (on Monday before the open, last week's), not the portfolio's
    },
  };
}
