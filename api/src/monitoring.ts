// The admin monitoring page (D-036): GET /admin/monitoring and GET /admin/db. Read-only, admins only.
// Usage comes from the daily totals that POST /me/seen writes (usage.ts); "sent" orders come from the orders table,
// never from the app. Real time and real Israel dates, like presence (D-026): the world clock plays no part.
// Every query is sequential, like the rest of the admin code: one request holds at most one pool connection.

import type { Pool } from 'pg';
import type {
  AdminDbHealth,
  AdminMonitoring,
  MonitoringPageRow,
  MonitoringRange,
  MonitoringTotals,
  UsageBucket,
  UsagePage,
} from './contract.js';
import { addDays, ISRAEL, mondayOf } from './game/time.js';
import { USAGE_PAGES } from './usage.js';

const DAILY_BUCKETS = 30;
const WEEKLY_BUCKETS = 12;
const RANGES: readonly MonitoringRange[] = ['today', 'd7', 'd30'];

// ---------- GET /admin/monitoring ----------

// Sums come back as float8 on purpose: pg returns BIGINT and NUMERIC as strings, and a float8 holds every whole
// number up to 2^53 exactly, far beyond any count or millisecond total here.
type PageTotalsRow = {
  page: UsagePage | null;   // null on the row for all pages together
  views_today: number; ms_today: number; players_today: number;
  views_d7: number; ms_d7: number; players_d7: number;
  views_d30: number; ms_d30: number; players_d30: number;
};

type TimeRow = { day: string; page: UsagePage; ms: number };
type PlayersRow = { start: string; players: number };

// One run at a time: a request that arrives while a run is going (the retry button, a reload, a second admin)
// gets that run's answer instead of starting another. A run reads up to 12 weeks of usage rows and holds a pool
// connection while it does, so several at once would take connections from check-ins and order sends.
export function oneAtATime<T>(run: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | null = null;
  return () =>
    (current ??= run().finally(() => {
      current = null;
    }));
}

// Distinct players are counted with the ids compared byte by byte (COLLATE "C"). The database's language
// collation (en_US) compares every pair of Firebase ids by Unicode rules, which made these counts several times
// slower at thousands of players. Only equality matters here, never the order, so the result is the same.
export async function getAdminMonitoring(db: Pool): Promise<AdminMonitoring> {
  // "Today" is Postgres's, the same expression the writes use (recordUsage), so a report written a moment ago
  // always lands inside today's range, even if the API's clock or time zone disagrees.
  // Dates as text: pg would turn a DATE into a JS Date at local midnight and shift the day.
  const head = await db.query<{ today: string; since: string | null }>(
    `SELECT (now() AT TIME ZONE '${ISRAEL}')::date::text AS today,
            LEAST((SELECT min(day) FROM usage_pages_daily), (SELECT min(day) FROM usage_confirms_daily))::text AS since`,
  );
  const { today, since } = head.rows[0];
  // Each range's first day; every range ends today. $1, $2, $3 in the queries below.
  const first = { today, d7: addDays(today, -6), d30: addDays(today, -(DAILY_BUCKETS - 1)) };
  const params = [first.today, first.d7, first.d30];

  // Orders sent in each range, by their status now. The 30-day range reads orders_created_idx; the shorter ranges
  // are FILTERs over the same rows, so the 3 ranges cost one pass. A range starts at midnight Israel time.
  const orders = await db.query<{ status: 'pending' | 'executed' | 'rejected'; today: number; d7: number; d30: number }>(
    `SELECT status,
            count(*) FILTER (WHERE created_at >= $1::date::timestamp AT TIME ZONE '${ISRAEL}')::int AS today,
            count(*) FILTER (WHERE created_at >= $2::date::timestamp AT TIME ZONE '${ISRAEL}')::int AS d7,
            count(*)::int AS d30
     FROM orders
     WHERE created_at >= $3::date::timestamp AT TIME ZONE '${ISRAEL}'
     GROUP BY status`,
    params,
  );

  // The confirm popup: opened and backed out, per range. One row per player per day, so this is a small range scan.
  const confirms = await db.query<{
    opened_today: number; backed_today: number;
    opened_d7: number; backed_d7: number;
    opened_d30: number; backed_d30: number;
  }>(
    `SELECT COALESCE(sum(opened) FILTER (WHERE day >= $1::date), 0)::float8 AS opened_today,
            COALESCE(sum(backed) FILTER (WHERE day >= $1::date), 0)::float8 AS backed_today,
            COALESCE(sum(opened) FILTER (WHERE day >= $2::date), 0)::float8 AS opened_d7,
            COALESCE(sum(backed) FILTER (WHERE day >= $2::date), 0)::float8 AS backed_d7,
            COALESCE(sum(opened), 0)::float8 AS opened_d30,
            COALESCE(sum(backed), 0)::float8 AS backed_d30
     FROM usage_confirms_daily
     WHERE day BETWEEN $3::date AND $1::date`,
    params,
  );

  // Time, views and players per page, per range, plus one row for all pages together (the grouping set `()`):
  // a player who used two pages is one player there, which no sum of the page rows can tell.
  // First one row per page per player (pu), with the player's sums per range and the last day they used the page:
  // they were on that page in a range when that day is in it, since every range ends today. The distinct counts
  // then sort those rows (pages × players in 30 days), not every daily row behind them.
  // Only the known pages: a page dropped from USAGE_PAGES later keeps its old rows out of the answer.
  const pages = await db.query<PageTotalsRow>(
    `WITH pu AS (
       SELECT page, uid COLLATE "C" AS uid,
              sum(views) FILTER (WHERE day >= $1::date) AS views_today,
              sum(ms) FILTER (WHERE day >= $1::date) AS ms_today,
              sum(views) FILTER (WHERE day >= $2::date) AS views_d7,
              sum(ms) FILTER (WHERE day >= $2::date) AS ms_d7,
              sum(views) AS views_d30,
              sum(ms) AS ms_d30,
              max(day) AS last_day
       FROM usage_pages_daily
       WHERE day BETWEEN $3::date AND $1::date AND page = ANY($4::text[])
       GROUP BY 1, 2
     )
     SELECT CASE WHEN GROUPING(page) = 0 THEN page END AS page,
            COALESCE(sum(views_today), 0)::float8 AS views_today,
            COALESCE(sum(ms_today), 0)::float8 AS ms_today,
            count(DISTINCT uid) FILTER (WHERE last_day >= $1::date)::int AS players_today,
            COALESCE(sum(views_d7), 0)::float8 AS views_d7,
            COALESCE(sum(ms_d7), 0)::float8 AS ms_d7,
            count(DISTINCT uid) FILTER (WHERE last_day >= $2::date)::int AS players_d7,
            COALESCE(sum(views_d30), 0)::float8 AS views_d30,
            COALESCE(sum(ms_d30), 0)::float8 AS ms_d30,
            count(DISTINCT uid)::int AS players_d30
     FROM pu
     GROUP BY GROUPING SETS ((page), ())`,
    [...params, USAGE_PAGES],
  );

  // The chart's bars: time per page and players per day (30 days) and per week (12 weeks, Monday first, like the
  // game's week). The time is one pass over the 12 weeks, per day and page, which follows the primary key's order;
  // the days are added up into the 30 daily and 12 weekly bars below. Days and weeks with no usage have no rows
  // and stay at zero.
  const firstMonday = addDays(mondayOf(today), -7 * (WEEKLY_BUCKETS - 1));
  const time = await db.query<TimeRow>(
    `SELECT day::text AS day, page, sum(ms)::float8 AS ms
     FROM usage_pages_daily
     WHERE day BETWEEN $1::date AND $2::date AND page = ANY($3::text[])
     GROUP BY day, page`,
    [firstMonday, today, USAGE_PAGES],
  );
  // Players per bar, distinct: a player on two pages, or on several days of one week, is one player in that bar.
  // These can't be added up from the days, so each unit has its own count.
  const dayPlayers = await db.query<PlayersRow>(
    `SELECT day::text AS start, count(DISTINCT uid COLLATE "C")::int AS players
     FROM usage_pages_daily
     WHERE day BETWEEN $1::date AND $2::date AND page = ANY($3::text[])
     GROUP BY day`,
    [first.d30, today, USAGE_PAGES],
  );
  const weekPlayers = await db.query<PlayersRow>(
    `SELECT week::text AS start, count(*)::int AS players
     FROM (SELECT date_trunc('week', day::timestamp)::date AS week, uid COLLATE "C" AS uid
           FROM usage_pages_daily
           WHERE day BETWEEN $1::date AND $2::date AND page = ANY($3::text[])
           GROUP BY 1, 2) AS w
     GROUP BY week`,
    [firstMonday, today, USAGE_PAGES],
  );

  const c = confirms.rows[0];
  const totals = {} as Record<MonitoringRange, MonitoringTotals>;
  for (const range of RANGES) {
    const count = (status: 'pending' | 'executed' | 'rejected') =>
      orders.rows.find((r) => r.status === status)?.[range] ?? 0;
    const executed = count('executed');
    const rejected = count('rejected');
    const pending = count('pending');
    const all = pages.rows.find((r) => r.page === null);
    totals[range] = {
      orders: { sent: executed + rejected + pending, executed, rejected, pending },
      confirms: { opened: c[`opened_${range}` as const], backed: c[`backed_${range}` as const] },
      pages: pageRows(pages.rows, range),
      ms: all?.[`ms_${range}` as const] ?? 0,
      players: all?.[`players_${range}` as const] ?? 0,
    };
  }

  return {
    today,
    since,
    totals,
    daily: fillBuckets(time.rows, dayPlayers.rows, first.d30, DAILY_BUCKETS, 'day'),
    weekly: fillBuckets(time.rows, weekPlayers.rows, firstMonday, WEEKLY_BUCKETS, 'week'),
  };
}

// One range's page rows: most time first, then most views, then by name so equal rows keep a fixed order.
// A page nobody used in the range (no player) is left out.
function pageRows(rows: PageTotalsRow[], range: MonitoringRange): MonitoringPageRow[] {
  return rows
    .flatMap((r): MonitoringPageRow[] =>
      r.page !== null && r[`players_${range}` as const] > 0
        ? [{ page: r.page, views: r[`views_${range}` as const], ms: r[`ms_${range}` as const], players: r[`players_${range}` as const] }]
        : [],
    )
    .sort((a, b) => b.ms - a.ms || b.views - a.views || a.page.localeCompare(b.page));
}

const zeroMs = (): Record<UsagePage, number> =>
  Object.fromEntries(USAGE_PAGES.map((p) => [p, 0])) as Record<UsagePage, number>;

// `count` buckets from `start`, a day or a week (from a Monday) each, oldest first. Each day's time goes to the
// bucket it falls in; a day before the first bucket (the daily bars read only 30 of the 12 weeks) is skipped.
// A bucket with no rows stays at zero, so the chart always has its 30 days or 12 weeks and an empty day shows
// as an empty bar, not a missing one.
function fillBuckets(time: TimeRow[], players: PlayersRow[], start: string, count: number, unit: 'day' | 'week'): UsageBucket[] {
  const step = unit === 'day' ? 1 : 7;
  const buckets = Array.from({ length: count }, (_, i): UsageBucket => ({
    start: addDays(start, i * step),
    players: 0,
    ms: zeroMs(),
  }));
  const byStart = new Map(buckets.map((b) => [b.start, b]));
  for (const r of time) {
    const b = byStart.get(unit === 'day' ? r.day : mondayOf(r.day));
    if (b) b.ms[r.page] += r.ms;
  }
  for (const r of players) {
    const b = byStart.get(r.start);
    if (b) b.players = r.players;
  }
  return buckets;
}

// ---------- GET /admin/db ----------

const LARGEST_TABLES = 5;

// The database's health, read live from Postgres's own views. Read-only: nothing here changes anything, and no
// query text is ever read (pg_stat_activity's `query` column is never selected), so nothing a player typed or a
// statement's parameters can reach the admin page.
//
// On a managed host the API's role may not see every statistic. Postgres doesn't refuse those reads; it hides the
// details instead (another role's connections show no state), so the counts here are what this role can see.
// If a host refuses one outright, that part falls back to zeros or null and the rest of the card still works.
export async function getDbHealth(db: Pool): Promise<AdminDbHealth> {
  // The round trip as the API sees it: waiting for a free pool connection included.
  const t0 = performance.now();
  await db.query('SELECT 1');
  const latencyMs = Math.round((performance.now() - t0) * 10) / 10;

  // Every function here is open to any role by default.
  const server = await db.query<{ version: string; started_at: Date; size_bytes: number; max_connections: number }>(
    `SELECT current_setting('server_version') AS version,
            pg_postmaster_start_time() AS started_at,
            pg_database_size(current_database())::float8 AS size_bytes,
            current_setting('max_connections')::int AS max_connections`,
  );
  const s = server.rows[0];

  // Client connections to the whole server (not the background workers). "Longest query" leaves out this
  // request's own connection, which is running this very query.
  // A role without pg_read_all_stats sees another role's connection with no backend_type and no state, only its
  // user and database. Such a row still counts in `total` (it holds one of max_connections), never in a state.
  const activity = await optional(
    'pg_stat_activity',
    async () =>
      (
        await db.query<{ active: number; idle: number; idle_in_transaction: number; total: number; longest_sec: number | null }>(
          `SELECT count(*) FILTER (WHERE state = 'active')::int AS active,
                  count(*) FILTER (WHERE state = 'idle')::int AS idle,
                  count(*) FILTER (WHERE state IN ('idle in transaction', 'idle in transaction (aborted)'))::int AS idle_in_transaction,
                  count(*)::int AS total,
                  max(extract(epoch FROM clock_timestamp() - query_start))
                    FILTER (WHERE state = 'active' AND pid <> pg_backend_pid())::float8 AS longest_sec
           FROM pg_stat_activity
           WHERE backend_type = 'client backend'
              OR (backend_type IS NULL AND usename IS NOT NULL AND datname IS NOT NULL)`,
        )
      ).rows[0],
    { active: 0, idle: 0, idle_in_transaction: 0, total: 0, longest_sec: null },
  );

  // Share of this database's block reads served from Postgres's memory since its statistics were last reset.
  const cache = await optional(
    'pg_stat_database',
    async () =>
      (
        await db.query<{ hit: number; read: number }>(
          `SELECT blks_hit::float8 AS hit, blks_read::float8 AS read
           FROM pg_stat_database WHERE datname = current_database()`,
        )
      ).rows[0] ?? { hit: 0, read: 0 },
    { hit: 0, read: 0 },
  );

  // The largest tables of the app's schema, indexes included. The row count is Postgres's estimate from the last
  // VACUUM or ANALYZE: counting the rows would read the whole table. -1 = never analyzed yet, passed on as it is,
  // so the card says "not counted yet" instead of 0 for a table that has rows (autovacuum leaves a table with
  // fewer than about 50 changed rows alone, so a small table can stay at -1 for good).
  const tables = await optional(
    'pg_class',
    async () =>
      (
        await db.query<{ name: string; bytes: number; rows: number }>(
          `SELECT c.relname AS name, pg_total_relation_size(c.oid)::float8 AS bytes, c.reltuples::float8 AS rows
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r'
           ORDER BY bytes DESC, name
           LIMIT $1`,
          [LARGEST_TABLES],
        )
      ).rows,
    [],
  );

  const blocks = cache.hit + cache.read;
  return {
    checkedAt: new Date().toISOString(),
    latencyMs,
    // Read last, after this request's queries gave their connections back.
    pool: { max: db.options.max, total: db.totalCount, idle: db.idleCount, waiting: db.waitingCount },
    server: {
      version: s.version.split(' ')[0],   // "17.2 (Debian 17.2-1.pgdg120+1)" → "17.2"
      startedAt: s.started_at.toISOString(),
      sizeBytes: s.size_bytes,
      connections: {
        active: activity.active,
        idle: activity.idle,
        idleInTransaction: activity.idle_in_transaction,
        total: activity.total,
        max: s.max_connections,
      },
      longestQuerySec: activity.longest_sec === null ? null : Math.round(activity.longest_sec * 10) / 10,
      cacheHitPct: blocks > 0 ? Math.round((cache.hit / blocks) * 1000) / 10 : null,
    },
    tables: tables.map((t) => ({ name: t.name, bytes: t.bytes, rows: t.rows < 0 ? -1 : Math.round(t.rows) })),
  };
}

// A statistic some hosts may refuse: log it and show the fallback, so one hidden view doesn't fail the whole card.
async function optional<T>(what: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    console.warn(`GET /admin/db: could not read ${what}`, err instanceof Error ? err.message : err);
    return fallback;
  }
}
