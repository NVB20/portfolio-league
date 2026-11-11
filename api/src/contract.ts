// The JSON shape of GET /me/dashboard. Shared by the API and the app:
// the app imports these TYPES ONLY (import type ... from '../../api/src/contract'), so nothing from the API is bundled.
// Keep this file free of imports, so it type-checks under both tsconfigs.
//
// Numbers are plain JS numbers for display. The money math itself happens in Postgres (NUMERIC).
// `null` always means "no data yet" (empty world), never zero.

// A moment in world time, already split into Israel-time parts so the app doesn't need time-zone code.
export type WorldTime = {
  at: string;        // ISO instant, e.g. '2026-11-11T10:40:00.000Z'
  date: string;      // Israel calendar date, 'YYYY-MM-DD'
  weekday: number;   // 0 = Sunday ... 6 = Saturday (Israel time)
  time: string;      // Israel wall clock, 'HH:MM'
};

// One market's status on the world clock's day (D-022). Hours are Israel-time minutes since midnight.
export type MarketSession = {
  isOpen: boolean;                                       // open right now (world time)
  session: { openMin: number; closeMin: number } | null; // null = closed all day (weekend or holiday)
  state: 'open' | 'pre_open' | 'after_close' | 'weekend' | 'holiday';
  reason: string | null;                                 // why it's closed today, in Hebrew ('פסח'); null otherwise
  nextOpen: WorldTime | null;                            // when it opens next; null while open
};

export type ClockView = WorldTime & {
  week: number;                                // ISO week number, shown as "שבוע 46"
  weekStartAt: string;                         // ISO instant of Monday 00:00 Israel time (the chart's left edge)
  markets: { tase: MarketSession; us: MarketSession };
};

// The clock as every player sees it on the dashboard: the world time plus what the admin controls (D-017).
export type LiveClockView = ClockView & {
  running: boolean;            // false = the admin stopped it: world time stands still
  endsAt: WorldTime | null;    // the clock stops here by itself (the last day with prices); null = no end set
};

export type Point = { at: string; value: number };

// Every ₪ figure here is a value the runner stored (D-019, D-024); the API never adds money up on read (D-031).
export type PortfolioView = {
  totalValue: number;              // equity: all cash + holdings at their last marks, in ₪
  cash: number;                    // all cash, the reserved part included
  availableCash: number;           // cash − reservedCash: what a new buy can spend
  reservedCash: number;            // locked by pending buys
  realizedPnl: number;             // gains from sales so far, + = gain
  unrealizedPnl: number;           // holdings at their marks − what they cost
  weekReturnPct: number | null;    // from the week's running totals; 0 = untouched this week; null = no world yet
  maxDrawdownPct: number | null;   // largest peak-to-low drop this week, as a positive %; 0 = untouched this week
  vsMedianPct: number | null;      // your week return minus the median player's after the latest finished event
                                   // this week; null = no finished event this week yet
  series: Point[];                 // your value this week: Monday 00:00, one point per trading day, now
  medianSeries: Point[];           // the median player's value after each finished open or close this week
};

export type HoldingView = {
  symbol: string;
  nameHe: string;
  exchange: 'TASE' | 'NASDAQ' | 'NYSE';
  currency: 'ILS' | 'USD';
  units: number;
  freeUnits: number;               // units not locked by pending sells: what a new sell can use
  valueIls: number;                // at the last mark (the latest open or close); at cost until the first one
  costBasisIls: number;            // ₪ paid for the units held (average cost, D-019)
  unrealizedPnlIls: number;        // valueIls − costBasisIls
  dayChangePct: number | null;     // the latest known close vs. the one before (display only)
  weightPct: number | null;        // share of the whole portfolio (totalValue)
  nearCap: boolean;                // close to the 20% limit (rule 4)
};

// An order the runner rejected that the player hasn't seen yet (D-023). The app shows it as a toast, then
// calls POST /me/rejections/seen.
export type RejectionCode = 'NO_PRICE' | 'INSUFFICIENT_CASH' | 'OVER_LIMIT' | 'INSUFFICIENT_UNITS';

export type RejectionView = {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  amountIls: number | null;        // buys
  units: number | null;            // sells
  code: RejectionCode | null;      // for the English text; the runner always sets it
  reason: string;                  // Hebrew, shown to the player
  at: WorldTime;                   // the open or close that rejected it
};

export type OrderView = {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  amountIls: number | null;        // buys: the ₪ to spend (D-018)
  units: number | null;            // sells: the units to sell (D-018)
  priceType: 'open' | 'close';     // open = sent while closed, close = sent while open (rule 3)
  market: 'TASE' | 'US';
  executesAt: WorldTime;
};

export type UsdIlsView = {
  rate: number;                    // latest close, ₪ per $1
  weekChangePct: number | null;
  series: Point[];                 // this week's closes
};

export type StandingView = {
  rank: number;
  players: number;
  score: number;
  returnRank: number;
  stabilityRank: number;
  rankChange: number | null;       // + = moved up since the previous day; null on the first day
  days: { date: string; weekday: number; score: number }[];   // this week, Mon..today
  maxDrawdownPct: number;          // the board row's week drawdown: the board's week, not always the portfolio's
};

// One row of the board. `rank` is the place: unique on a board, 1..players (no shared places, D-032).
export type LeaderRow = { rank: number; name: string; returnPct: number; score: number; isMe: boolean };

// Which board is shown (D-032): the latest scored day up to today. `final` = its places won't change any more:
// its week is before the current world week (e.g. Monday before the week's first open), or the week's final
// weekly_scores rows exist (written at the week's last close, so the weekend shows final once they are written).
export type BoardWeek = {
  start: string;   // the week's Monday, 'YYYY-MM-DD'
  day: string;     // the scored day shown, 'YYYY-MM-DD'
  final: boolean;
};

// ---------- GET /me/trade: the trading screen ----------

// The player's chart settings (users.chart_settings). Saved with PATCH /me/chart-settings.
export type ChartSettings = {
  type: 'candles' | 'bars' | 'line' | 'area';
  tf: 'D' | 'W';                      // daily or weekly bars
  range: 22 | 66 | 126;               // trading days shown: 1M, 3M, 6M
  bg: 'app' | 'black' | 'paper';
  colors: 'mint' | 'classic' | 'blue';
  volume: boolean;
  sma20: boolean;
  sma50: boolean;
  grid: boolean;
  watermark: boolean;
  lastLine: boolean;
};

// When an order sent now would run (rule 3). gameOver: true = that moment is after the end of the price history
// (world_clock.ends_at), so POST /me/orders refuses the order with GAME_OVER (D-028): show that, not the time.
export type ExecutionView = { priceType: 'open' | 'close'; at: WorldTime; gameOver: boolean };

export type SecurityView = {
  symbol: string;
  nameHe: string;
  nameEn: string | null;
  market: 'TASE' | 'US';
  exchange: 'TASE' | 'NASDAQ' | 'NYSE';
  currency: 'ILS' | 'USD';
  price: number | null;              // latest close already known in world time, in its own currency
  priceDay: string | null;           // the trading day of that close
  dayChangePct: number | null;       // that close vs. the one before
  closes: { day: string; close: number }[];   // the last 11 known closes, oldest first (the 10-day chart)
  holding: { units: number; freeUnits: number; valueIls: number; weightPct: number | null } | null;   // as in HoldingView
  isOpen: boolean;                   // its market is open right now (world time)
  execution: ExecutionView | null;   // null = the world hasn't started
  hasChart: boolean;                 // a Yahoo symbol exists, so GET /me/chart/:symbol works
};

export type TradeView = {
  clock: LiveClockView | null;       // as on the dashboard: with running and endsAt (where the history ends)
  cash: number;
  availableCash: number;             // cash − cash locked by pending buys
  totalValue: number;
  usdIls: UsdIlsView | null;
  securities: SecurityView[];
  pendingOrders: OrderView[];        // all of them, in the order they will run
  chartSettings: ChartSettings;
};

// ---------- GET /me/chart/:symbol: real OHLC from Yahoo, for the chart only ----------

export type ChartBar = { time: string; open: number; high: number; low: number; close: number; volume: number };

export type ChartView = {
  symbol: string;
  currency: 'ILS' | 'USD';
  tf: 'D' | 'W';
  lastDay: string | null;            // bars stop here: the last day already closed in world time
  bars: ChartBar[];                  // oldest first; TASE in shekels
};

export type Dashboard = {
  clock: LiveClockView | null;     // null = the world hasn't started
  portfolio: PortfolioView;
  holdings: HoldingView[];
  pendingOrders: { total: number; next: OrderView[] };   // next = the 2 that run first (DD-07)
  rejections: RejectionView[];     // unseen rejected orders, newest first, at most 5 (D-023)
  usdIls: UsdIlsView | null;
  standing: StandingView | null;   // null = you're not on the board shown (not ranked this week, or nothing scored yet)
  leaderboard: { players: number; week: BoardWeek | null; top: LeaderRow[] };   // top = places 1..5
};

// ---------- GET /me/leaderboard: the weekly table (D-032) ----------
// ?view=top&from=1 (the default): 20 rows from place `from`. ?view=around: my place ± 5 (the top 20 when I'm not
// on the board). Read-only: the runner's scoring step writes the places at every open and close (D-034,
// scoring.ts), the API only reads them.

export type LeaderboardRow = LeaderRow & {
  avatar: number;                  // 0..4: which of the five avatar fills (LD-06), from a hash on the server; never the player's id
  maxDrawdownPct: number;
  returnRank: number;
  stabilityRank: number;
  rankChange: number | null;       // + = places gained since the previous scored day of this week; null on its first day
  days: (number | null)[];         // the daily score, Mon..Fri (always 5 entries); null = no score that day
};

export type LeaderboardMe = StandingView & {
  returnPct: number;
  ahead: { rank: number; score: number } | null;   // the place just above mine; null when I'm first
};

export type PastWeekView = { weekStart: string; rank: number; players: number; score: number };

export type LeaderboardView = {
  clock: LiveClockView | null;     // the world clock, for the top bar and the reload at each open and close; null = no world
  week: BoardWeek | null;          // null = nothing has been scored yet
  players: number;                 // players on this board (0 when week is null)
  me: LeaderboardMe | null;        // null = I'm not on this board (not ranked this week)
  podium: LeaderboardRow[];        // places 1..3
  view: 'top' | 'around';          // what `rows` holds ('top' when 'around' was asked but I'm not on the board)
  rows: LeaderboardRow[];          // in place order
  from: number;                    // the place of rows[0]; 1 when rows is empty
  hasMore: boolean;                // there are places after the last row
  pastWeeks: PastWeekView[];       // my last 4 closed weeks before this board's week, newest first
  // The world instant (ISO) of the latest finished open or close; null = none yet. The scoring commits with the
  // event's 'done' (D-034), so this changes exactly when the board is rewritten: two pages with the same
  // scoredAt (and day) come from the same ranking.
  scoredAt: string | null;
  // The world clock has passed an open or close that isn't scored yet (not started, or still running): the board
  // is about to change, so ask again soon. False when no world exists.
  behind: boolean;
};

// POST /me/rejections/seen: the rejection toasts the app showed, by order id (1 to 5, the `rejections[].id`s).
// Marks exactly those of this player's rejected orders as seen. `marked` = how many were newly marked.
export type RejectionsSeenBody = { ids: string[] };
export type RejectionsSeenResult = { marked: number };

// ---------- POST /me/orders: sending an order (D-018, D-028) ----------

// The request. A buy is a ₪ amount, a sell a number of units (D-018). Sizes are exact: a decimal string, or a
// JSON number read as String(n). At most 2 decimals for ₪ and 8 for units; nothing is rounded.
export type SendOrderBody = {
  symbol: string;
  side: 'buy' | 'sell';
  amountIls?: string | number;     // buys only, at least ₪100
  units?: string | number;         // sells only
  clientOrderId?: string;          // ^[A-Za-z0-9_-]{1,64}$: the same id again returns the same order
};

export type SentOrderView = OrderView & {
  status: 'pending' | 'executed' | 'rejected';   // a new order is 'pending'; a replay shows what happened since
  placedAt: WorldTime;             // the effective world time it was sent
  clientOrderId: string | null;
};

// 201 = a new order; 200 = the same clientOrderId and order again (replay: true, nothing new was written).
export type SendOrderResult = { order: SentOrderView; replay: boolean };

export type SendOrderErrorCode =
  | 'BAD_REQUEST'                  // 400
  | 'UNKNOWN_SYMBOL' | 'NO_USER'   // 404
  | 'NO_WORLD' | 'GAME_OVER' | 'CLIENT_ID_CONFLICT'   // 409
  | 'BELOW_MIN' | 'INSUFFICIENT_CASH' | 'NO_POSITION' | 'INSUFFICIENT_UNITS' | 'OVER_LIMIT'   // 422
  | 'RATE_LIMITED';                // 429, with a Retry-After header in seconds

// `error` is English; `reason` is the Hebrew shown to the player, when there is one.
export type SendOrderError = { error: string; code: SendOrderErrorCode; reason?: string };

// ---------- POST /admin/clock/advance | start | stop: the admin's clock moves (D-017, D-030) ----------
// Admins only. Every move that changes the clock writes one admin_actions row in the same transaction (D-027).

// What the runner did on the way: the opens and closes it ran, and their orders and re-valued players.
export type ClockRunCounts = { events: number; ordersExecuted: number; ordersRejected: number; playersUpdated: number };

// POST /admin/clock/advance body (optional). from = the world time the admin page showed when the admin clicked
// (clock.at, ISO). If an open or close has run since (the click already went through and its answer was lost,
// or the ticker ran one meanwhile), the answer is 409 CLOCK_MOVED and nothing moves. Without it, any click jumps.
export type ClockAdvanceBody = { from?: string };

// 200: jumped to the next close of an open market, or to the next open when none is open (capped at endsAt).
export type ClockAdvanceResult = ClockRunCounts & {
  kind: 'to_close' | 'to_open';
  from: WorldTime;                 // the effective world time before the jump
  to: WorldTime;
  clock: LiveClockView;            // after the move; a running clock keeps running from `to`
};

// 200 either way. changed: false = it was already running; nothing was written.
export type ClockStartResult = { changed: boolean; clock: LiveClockView };

// 200 either way. changed: false = it was already stopped. Otherwise every event up to `at` ran first.
export type ClockStopResult =
  | { changed: false; clock: LiveClockView }
  | (ClockRunCounts & { changed: true; at: WorldTime; clock: LiveClockView });   // at = where it froze

export type ClockActionErrorCode =
  | 'NO_WORLD'                     // 409: no world_clock row yet
  | 'CLOCK_BUSY'                   // 409: the runner is running an event (the ticker, or another move); try again
  | 'CLOCK_AT_END'                 // 409: advance at world_clock.ends_at, the last moment with prices
  | 'CLOCK_MOVED';                 // 409: advance with `from`, and an open or close has run since that time

// `error` is English, `reason` the Hebrew the admin page shows.
export type ClockActionError = { error: string; code: ClockActionErrorCode; reason: string };

// ---------- GET /admin/overview and GET /admin/players: the admin side (admins only) ----------
// Only numbers the database already has. Metrics we don't track yet (the engine's runs, the admin
// action log) are not here, and the screen says so instead of guessing.
// Presence (D-026) is real time: "today" is the real Israel date, never the world clock's.

export type AdminOverview = {
  // null = the world hasn't started. lastTickAt = the ticker's last beat, real time (D-030); null = never ticked.
  clock: (LiveClockView & { lastTickAt: string | null }) | null;
  players: {
    total: number;
    joinedToday: number;           // signed up today, real Israel date
    withHoldings: number;          // own at least one security
  };
  presence: {
    onlineNow: number;             // the app checked in during the last 2 minutes
    seenToday: number;             // checked in at least once today; each player counts once
    visitsToday: number;           // visits started today (a visit = a check-in after 30+ minutes away)
    returningToday: number;        // players with 2 or more visits today
    visitBuckets: { two: number; threeToFive: number; sixPlus: number };
    avgVisits: number | null;      // visits per player who visited today; null = no visits yet
  };
  orders: {
    pending: { tase: number; us: number };
    rejectedThisWeek: number;      // executed this world week and rejected
    rejectReasons: { reason: string; count: number }[];   // the most common this week, up to 3
  };
  world: {
    securities: number;
    pricesUntil: { tase: string | null; us: string | null };   // the last day with prices in the database
    usdIlsUntil: string | null;
  };
  lastRun: AdminRunView | null;    // the latest open/close the engine started (market_events); null = none yet
  eventsBehind: number;            // opens/closes already due in world time that aren't done yet
  recentActions: AdminActionView[];   // the admin action log, newest first, up to 5
};

// One open or close the engine ran (D-021).
export type AdminRunView = {
  market: 'TASE' | 'US';
  kind: 'open' | 'close';
  at: WorldTime;                   // the event's world time
  status: 'pending' | 'orders_done' | 'done';
  ordersExecuted: number;
  ordersRejected: number;
  playersUpdated: number;          // players the runner's own pages updated; catch-ups on read (D-025) don't count
  durationMs: number | null;       // null = still running
  // The ledger check (D-019), run inside each order batch: false as soon as any batch found a mismatch,
  // final when the event is done. null = no batch checked yet.
  ledgerBalanced: boolean | null;
  finishedAt: string | null;       // real time, ISO
};

export type AdminAction = 'clock_to_close' | 'clock_to_open' | 'clock_start' | 'clock_stop';

export type AdminActionView = {
  at: string;                      // real time, ISO
  admin: string;                   // display name, else email
  action: AdminAction;
  worldFrom: string | null;        // world time before and after, ISO
  worldTo: string | null;
  detail: Record<string, unknown>; // e.g. { events, ordersExecuted }
};

// GET /admin/activity?days=: players per day and how many come back (D-026). Real Israel dates.
export type RetentionRate = {
  cohort: number;                  // players who signed up in the window, old enough to be measured
  returned: number;                // of them, visited on day 1 (or day 7) after signing up
  pct: number | null;              // null = nobody to measure yet
};

export type AdminActivity = {
  days: { date: string; activePlayers: number; visits: number; signups: number }[];   // oldest first, includes today
  retention: { d1: RetentionRate; d7: RetentionRate };
};

export type AdminPlayer = {
  uid: string;
  name: string | null;             // display name; null = signed up with email and no name
  email: string;
  isAdmin: boolean;
  joinedAt: string;                // real time, ISO
  totalValue: number;              // cash + holdings at the latest known closes, in ₪
  rank: number | null;             // on the latest scored day of this week; null = not scored
  pendingOrders: number;
  lastSeenAt: string | null;       // real time, ISO; null = never checked in
  visitsToday: number;
};

export type AdminPlayers = { players: AdminPlayer[]; limit: number };

// ---------- Usage monitoring (D-036): POST /me/seen's body, GET /admin/monitoring, GET /admin/db ----------
// Real time and real Israel dates, like presence (D-026): it measures people, not the game.

// The player pages the app tracks. Admin pages and the login page are never tracked.
export type UsagePage = 'dashboard' | 'trade' | 'journal' | 'leaderboard';

// Optional body of POST /me/seen: what happened since the app's last check-in. No body = a plain check-in.
// The server caps it (time at most 120 s per request in total, each count at most 50) and adds it to daily totals.
export type UsageReport = {
  pages?: Partial<Record<UsagePage, { views: number; ms: number }>>;
  confirms?: { opened: number; backed: number };   // the trade screen's confirm popup: opened, closed without sending
};

export type MonitoringRange = 'today' | 'd7' | 'd30';   // today, the last 7 days, the last 30 days (each includes today)

export type MonitoringPageRow = {
  page: UsagePage;
  views: number;
  ms: number;                      // time on the page, visible and not idle
  players: number;                 // distinct players who used it in the range
};

export type MonitoringTotals = {
  // Orders sent in the range (real created_at), by their status now. Comes from the orders table, not the app.
  orders: { sent: number; executed: number; rejected: number; pending: number };
  confirms: { opened: number; backed: number };
  pages: MonitoringPageRow[];      // most time first; a page nobody used in the range is left out
  ms: number;                      // all time in the app in the range
  players: number;                 // distinct players with any page usage in the range
};

// One bar of a usage chart. start = the day, or the Monday of the week (YYYY-MM-DD, Israel).
export type UsageBucket = { start: string; players: number; ms: Record<UsagePage, number> };

export type AdminMonitoring = {
  today: string;                   // the real Israel date the ranges end on (YYYY-MM-DD)
  since: string | null;            // the first day with any usage row; null = nothing measured yet
  totals: Record<MonitoringRange, MonitoringTotals>;
  daily: UsageBucket[];            // 30 days, oldest first, includes today, days with no usage filled with zeros
  weekly: UsageBucket[];           // 12 weeks starting Monday, oldest first, includes this week, zero-filled
};

// GET /admin/db: the database's health, read live. Nothing here changes anything.
export type AdminDbHealth = {
  checkedAt: string;               // real time, ISO
  latencyMs: number;               // round trip of SELECT 1 from the API
  pool: { max: number; total: number; idle: number; waiting: number };   // the API's own pg pool
  server: {
    version: string;               // e.g. "16.4"
    startedAt: string;             // real time, ISO
    sizeBytes: number;             // this database
    connections: { active: number; idle: number; idleInTransaction: number; total: number; max: number };   // client connections, whole server
    longestQuerySec: number | null;   // the longest-running active query other than this request's; null = none
    cacheHitPct: number | null;    // share of block reads served from memory, this database; null = no reads yet
  };
  // The 5 largest by total size. rows = Postgres's estimate; -1 = the table was never analyzed, so no estimate yet.
  tables: { name: string; bytes: number; rows: number }[];
};
