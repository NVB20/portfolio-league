// GET /me/journal: the trade journal (D-035). Every order the player sent, newest first, with what happened to it
// (waiting, filled at what price, or rejected and why), and the period's results: wins, losses, success rate and
// realized gain. Read-only, like the leaderboard: orders change only when the runner runs them (D-021), so there is
// no catch-up here (D-025 is about portfolio values).
//
// Called "trade journal" in code: `journals` is the money ledger's table (D-019).
//
// Money is read, never worked out again (D-031): each row shows the fill the runner stored, and the period's
// realized gain adds up the gain stored on each filled sell, exactly, in NUMERIC. For the whole game that sum is
// portfolios.realized_pnl.

import type { Pool } from 'pg';
import type {
  RejectionCode,
  TradeJournalFilter,
  TradeJournalPeriod,
  TradeJournalRow,
  TradeJournalStats,
  TradeJournalView,
} from './contract.js';
import { liveClockView, loadNow, worldTime } from './dashboard.js';

export const JOURNAL_LIMIT = { default: 20, max: 100 };
const FILTERS: readonly TradeJournalFilter[] = ['all', 'pending', 'executed', 'rejected'];
const PERIODS: readonly TradeJournalPeriod[] = ['week', 'all'];
const MAX_BIGINT = 9_223_372_036_854_775_807n;   // orders.id is a BIGINT

export type JournalQuery = { filter: TradeJournalFilter; period: TradeJournalPeriod; before: string | null; limit: number };

// The query string, checked before it reaches SQL. Missing values take the defaults; anything else wrong is a 400.
export function parseJournalQuery(q: {
  filter?: string;
  period?: string;
  before?: string;
  limit?: string;
}): { ok: true; query: JournalQuery } | { ok: false; error: string } {
  const filter = (q.filter ?? 'all') as TradeJournalFilter;
  if (!FILTERS.includes(filter)) return { ok: false, error: 'filter must be "all", "pending", "executed" or "rejected"' };
  const period = (q.period ?? 'all') as TradeJournalPeriod;
  if (!PERIODS.includes(period)) return { ok: false, error: 'period must be "week" or "all"' };
  const before = q.before ?? null;
  if (before !== null && (!/^[1-9]\d{0,18}$/.test(before) || BigInt(before) > MAX_BIGINT)) {
    return { ok: false, error: 'before must be an order id: a string of digits' };
  }
  const limitText = q.limit ?? String(JOURNAL_LIMIT.default);
  const limit = /^[1-9]\d{0,2}$/.test(limitText) ? Number(limitText) : NaN;
  if (!(limit <= JOURNAL_LIMIT.max)) return { ok: false, error: `limit must be a whole number from 1 to ${JOURNAL_LIMIT.max}` };
  return { ok: true, query: { filter, period, before, limit } };
}

type StatsRow = {
  all_count: number;
  pending: number;
  executed: number;
  rejected: number;
  due: number;
  wins: number;
  losses: number;
  even: number;
  realized: string;
  avg_win: string | null;
  avg_loss: string | null;
};

type OrderRow = {
  id: string;
  symbol: string;
  name_he: string;
  market: TradeJournalRow['market'];
  currency: TradeJournalRow['currency'];
  side: TradeJournalRow['side'];
  status: TradeJournalRow['status'];
  amount_ils: number | null;
  units: number | null;
  price_type: TradeJournalRow['priceType'];
  placed_at: Date;
  executes_at: Date;
  fill_price: number | null;
  fx_rate: number | null;
  filled_units: number | null;
  filled_ils: number | null;
  realized_pnl_ils: number | null;
  reject_code: RejectionCode | null;
  reject_reason: string | null;
  origin: TradeJournalRow['origin'];
  stop_price: number | null;   // a buy's stop, or the stop a stop's sell came from (D-037)
};

// Returns null when the user has no portfolio row yet (POST /me was never called).
export async function getTradeJournal(db: Pool, uid: string, q: JournalQuery): Promise<TradeJournalView | null> {
  // Sequential on purpose, like the dashboard: one pool connection per request at a time.
  const now = await loadNow(db);
  const portfolio = await db.query<{ reserved_cash: string }>('SELECT reserved_cash::text AS reserved_cash FROM portfolios WHERE uid = $1', [uid]);
  if (portfolio.rows.length === 0) return null;

  // "This week" = orders that ran, or will run, from Monday 00:00 of the world week. A pending order always runs
  // after now, so it is always in the week. No world yet = no week, so both periods show everything.
  const since = q.period === 'week' && now ? now.weekStart : null;

  // One pass over the player's orders (orders_uid_idx): the counts for the filter labels and the period's results.
  const { rows: [s] } = await db.query<StatsRow>(
    `WITH mine AS (SELECT * FROM orders WHERE uid = $1 AND ($2::timestamptz IS NULL OR executes_at >= $2))
     SELECT count(*)::int AS all_count,
            count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status = 'executed')::int AS executed,
            count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            count(*) FILTER (WHERE status = 'pending' AND executes_at <= $3)::int AS due,
            count(*) FILTER (WHERE status = 'executed' AND side = 'sell' AND realized_pnl_ils > 0)::int AS wins,
            count(*) FILTER (WHERE status = 'executed' AND side = 'sell' AND realized_pnl_ils < 0)::int AS losses,
            count(*) FILTER (WHERE status = 'executed' AND side = 'sell' AND realized_pnl_ils = 0)::int AS even,
            COALESCE(sum(realized_pnl_ils) FILTER (WHERE status = 'executed' AND side = 'sell'), 0)::text AS realized,
            round(avg(realized_pnl_ils) FILTER (WHERE status = 'executed' AND side = 'sell' AND realized_pnl_ils > 0), 2)::text AS avg_win,
            round(avg(realized_pnl_ils) FILTER (WHERE status = 'executed' AND side = 'sell' AND realized_pnl_ils < 0), 2)::text AS avg_loss
     FROM mine`,
    [uid, since, now?.at ?? null],
  );

  // One page, newest sent first. Per player, order ids follow the order orders were sent.
  const { rows } = await db.query<OrderRow>(
    `SELECT o.id::text AS id, o.symbol, s.name_he, s.market, s.currency, o.side, o.status,
            o.amount_ils::float8 AS amount_ils, o.units::float8 AS units, o.price_type, o.placed_at, o.executes_at,
            o.fill_price::float8 AS fill_price, o.fx_rate::float8 AS fx_rate, o.filled_units::float8 AS filled_units,
            o.filled_ils::float8 AS filled_ils, o.realized_pnl_ils::float8 AS realized_pnl_ils,
            o.reject_code, o.reject_reason, o.origin,
            COALESCE(o.stop_price, so.stop_price)::float8 AS stop_price
     FROM orders o JOIN securities s ON s.symbol = o.symbol
     LEFT JOIN stop_orders so ON so.id = o.stop_id
     WHERE o.uid = $1
       AND ($2::text IS NULL OR o.status = $2)
       AND ($3::timestamptz IS NULL OR o.executes_at >= $3)
       AND ($4::bigint IS NULL OR o.id < $4)
     ORDER BY o.id DESC
     LIMIT $5`,
    [uid, q.filter === 'all' ? null : q.filter, since, q.before, q.limit + 1],
  );

  return {
    clock: now ? liveClockView(now) : null,
    filter: q.filter,
    period: q.period,
    stats: stats(s),
    counts: { all: s.all_count, pending: s.pending, executed: s.executed, rejected: s.rejected },
    reservedCash: Number(portfolio.rows[0].reserved_cash),
    rows: rows.slice(0, q.limit).map(journalRow),
    hasMore: rows.length > q.limit,
    due: s.due > 0,
  };
}

function stats(s: StatsRow): TradeJournalStats {
  const decided = s.wins + s.losses;
  return {
    wins: s.wins,
    losses: s.losses,
    even: s.even,
    // In integers, so 2 of 3 is 66.7 and not 66.66666666666667 rounded somewhere else.
    winRatePct: decided === 0 ? null : Math.round((s.wins * 1000) / decided) / 10,
    realizedPnlIls: Number(s.realized),
    avgWinIls: s.avg_win === null ? null : Number(s.avg_win),
    avgLossIls: s.avg_loss === null ? null : Number(s.avg_loss),
  };
}

function journalRow(r: OrderRow): TradeJournalRow {
  return {
    id: r.id,
    symbol: r.symbol,
    nameHe: r.name_he,
    market: r.market,
    currency: r.currency,
    side: r.side,
    status: r.status,
    amountIls: r.amount_ils,
    units: r.units,
    priceType: r.price_type,
    placedAt: worldTime(r.placed_at),
    executesAt: worldTime(r.executes_at),
    // The fill columns are all set exactly when the order is executed (orders_fill_check).
    fill:
      r.status === 'executed'
        ? { price: r.fill_price!, fxRate: r.fx_rate, units: r.filled_units!, ils: r.filled_ils!, realizedPnlIls: r.realized_pnl_ils }
        : null,
    reject: r.status === 'rejected' ? { code: r.reject_code, reason: r.reject_reason! } : null,
    origin: r.origin,
    stopPrice: r.stop_price,
  };
}
