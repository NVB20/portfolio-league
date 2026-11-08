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

// One market's trading session on the world clock's day, in Israel-time minutes since midnight.
export type MarketSession = {
  isOpen: boolean;                                       // open right now (world time)
  session: { openMin: number; closeMin: number } | null; // null = closed all day (weekend)
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

export type Dashboard = {
  clock: ClockView | null;         // null = the world hasn't started
  portfolio: PortfolioView;
  holdings: HoldingView[];
  pendingOrders: { total: number; next: OrderView[] };   // next = the 2 that run first (DD-07)
  usdIls: UsdIlsView | null;
  standing: StandingView | null;   // null = no score computed for you this week
  leaderboard: { players: number; top: LeaderRow[] };
};
