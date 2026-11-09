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

export type Point = { at: string; value: number };

export type PortfolioView = {
  totalValue: number;              // cash + holdings, in ₪
  cash: number;
  weekReturnPct: number | null;    // from this week's snapshots; null before the first snapshot
  maxDrawdownPct: number | null;   // largest peak-to-low drop this week, as a positive %
  vsMedianPct: number | null;      // your week return minus the median player's
  series: Point[];                 // your value this week
  medianSeries: Point[];           // the median player's value at the same moments
};

export type HoldingView = {
  symbol: string;
  nameHe: string;
  exchange: 'TASE' | 'NASDAQ' | 'NYSE';
  currency: 'ILS' | 'USD';
  units: number;
  valueIls: number | null;         // null = no price for it yet
  dayChangePct: number | null;
  weightPct: number | null;        // share of the whole portfolio
  nearCap: boolean;                // close to the 20% limit (rule 4)
};

export type OrderView = {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  amountIls: number;
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
};

export type LeaderRow = { rank: number; name: string; returnPct: number; score: number; isMe: boolean };

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

// When an order sent now would run (rule 3).
export type ExecutionView = { priceType: 'open' | 'close'; at: WorldTime };

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
  holding: { units: number; valueIls: number | null; weightPct: number | null } | null;
  isOpen: boolean;                   // its market is open right now (world time)
  execution: ExecutionView | null;   // null = the world hasn't started
  hasChart: boolean;                 // a Yahoo symbol exists, so GET /me/chart/:symbol works
};

export type TradeView = {
  clock: ClockView | null;
  cash: number;
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
  clock: ClockView | null;         // null = the world hasn't started
  portfolio: PortfolioView;
  holdings: HoldingView[];
  pendingOrders: { total: number; next: OrderView[] };   // next = the 2 that run first (DD-07)
  usdIls: UsdIlsView | null;
  standing: StandingView | null;   // null = no score computed for you this week
  leaderboard: { players: number; top: LeaderRow[] };
};
