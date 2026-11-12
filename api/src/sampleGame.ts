// A SAMPLE GAME for development (D-038): the plan behind `npm run seed:sample-game`. Pure functions: no database,
// no framework. The script (api/scripts/seed-sample-game.ts) plays this plan through the real order sending and
// the real runner, so every fill, rejection, stop loss, ledger line and board place is the engine's own work.
//
// THIS IS SAMPLE DATA. The 40 players are made up, and so are their visits, page time and confirm popups (D-036),
// which the script writes straight into the daily tables. Nothing in the API imports this file.
//
// Two clocks, as in the real game: the trades happen in WORLD time (the first GAME_DAYS days of the world), and
// sign-ups, visits, page time and `orders.created_at` in REAL time. World day k is shown on real day k of the last
// GAME_DAYS days, ending today, at the same Israel clock time, so the admin pages see a launch month.

import type { UsagePage } from './contract.js';
import { format, parse, SCALE } from './game/fixed.js';
import type { Market } from './game/marketHours.js';
import { addDays, ISRAEL, zonedParts, zonedToInstant } from './game/time.js';
import { mulberry32, SAMPLE_UIDS, seedOf } from './sampleBoard.js';
import { WORLD_SECURITIES } from './world/securities.js';

// World days played, and real days they are shown on (the monitoring page's daily chart is 30 days).
export const GAME_DAYS = 30;

// ---------- small helpers ----------

type Rng = () => number;

const between = (rng: Rng, a: number, b: number) => a + rng() * (b - a);
const int = (rng: Rng, a: number, b: number) => a + Math.floor(rng() * (b - a + 1));   // a..b, both included

function shuffle<T>(rng: Rng, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const repeat = <T>(value: T, n: number): T[] => Array.from({ length: n }, () => value);

// ---------- the players ----------

export type Style = 'active' | 'balanced' | 'cautious' | 'aggressive';

export type Persona = {
  uid: string;
  style: Style;
  joinDay: number;          // the world day (and real day) they sign up and send their first orders
  orders: number;           // orders they mean to send over the month
  habit: number;            // chance of opening the app on a later day
  churnDay: number | null;  // from this day on they rarely come back
  stopShare: number;        // share of their buys that carry a stop loss (D-037)
  hesitancy: number;        // chance of backing out of the confirm popup before each order they send
  usShare: number;          // share of their orders in New York stocks
  favorites: string[];      // the stocks they mostly trade
};

// 8 + 16 + 9 + 7 = 40.
const STYLES: readonly Style[] = [
  ...repeat<Style>('active', 8), ...repeat<Style>('balanced', 16), ...repeat<Style>('cautious', 9), ...repeat<Style>('aggressive', 7),
];

// A launch: 22 players in the first three days, then a trickle until day 23.
const JOIN_DAYS: readonly number[] = [
  ...repeat(0, 10), ...repeat(1, 7), ...repeat(2, 5),
  3, 3, 4, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 17, 19, 21, 23,
];

const CHURNERS = 10;         // players who stop coming back a few days after they join
const CHURN_ORDERS = 0.7;    // and send fewer orders

type Range = readonly [number, number];
const ORDERS: Record<Style, Range> = { active: [42, 50], balanced: [29, 37], cautious: [18, 26], aggressive: [28, 36] };
const HABIT: Record<Style, Range> = { active: [0.8, 0.95], balanced: [0.55, 0.8], cautious: [0.35, 0.6], aggressive: [0.65, 0.88] };
// Some players never use a stop loss (D-037); the others put one on this share of their buys.
const NEVER_STOP: Record<Style, number> = { active: 0.5, balanced: 0.3, cautious: 0.1, aggressive: 0.85 };
const STOP_SHARE: Record<Style, Range> = { active: [0.1, 0.3], balanced: [0.2, 0.45], cautious: [0.5, 0.8], aggressive: [0.05, 0.15] };
const HESITANCY: Record<Style, Range> = { active: [0.08, 0.18], balanced: [0.15, 0.3], cautious: [0.3, 0.45], aggressive: [0.05, 0.15] };

const TASE_SYMBOLS = WORLD_SECURITIES.filter((s) => s.market === 'TASE').map((s) => s.symbol);
const US_SYMBOLS = WORLD_SECURITIES.filter((s) => s.market === 'US').map((s) => s.symbol);
export const MARKET_OF: ReadonlyMap<string, Market> = new Map(WORLD_SECURITIES.map((s) => [s.symbol, s.market]));

// The 40 players, one per sample uid (D-033's 'sample-01'..'sample-40'). Seeded: the same plan on every run.
export function planPersonas(): Persona[] {
  const rng = mulberry32(seedOf('sample-game'));
  const styles = shuffle(rng, STYLES);
  const joins = shuffle(rng, JOIN_DAYS);
  // Churners are picked among players who join early enough to be seen leaving.
  const early = shuffle(rng, SAMPLE_UIDS.map((_, i) => i).filter((i) => joins[i] <= 15));
  const churners = new Set(early.slice(0, CHURNERS));

  return SAMPLE_UIDS.map((uid, i): Persona => {
    const r = mulberry32(seedOf(`${uid}|persona`));
    const style = styles[i];
    const churn = churners.has(i);
    const orders = int(r, ...ORDERS[style]);
    return {
      uid,
      style,
      joinDay: joins[i],
      orders: churn ? Math.round(orders * CHURN_ORDERS) : orders,
      habit: between(r, ...HABIT[style]),
      churnDay: churn ? Math.min(GAME_DAYS, joins[i] + int(r, 4, 9)) : null,
      stopShare: r() < NEVER_STOP[style] ? 0 : between(r, ...STOP_SHARE[style]),
      hesitancy: between(r, ...HESITANCY[style]),
      usShare: between(r, 0.2, 0.8),
      favorites: [...shuffle(r, TASE_SYMBOLS).slice(0, int(r, 4, 6)), ...shuffle(r, US_SYMBOLS).slice(0, int(r, 4, 6))],
    };
  });
}

// ---------- when they come and when they send ----------

export type Send = { minute: number; market: Market };   // Israel clock minute of the day, 0..1439

// One day of one player. No sessions = didn't open the app that day.
export type PlanDay = {
  day: number;
  sends: Send[];          // in time order
  sessions: number[];     // visit start minutes, in time order; every send comes after the first
};

const WORLD_START_MINUTE = 9 * 60;   // the world clock starts at 09:00 (D-013)
const FIRST_SEND_DAY0 = WORLD_START_MINUTE + 5;
const SAME_SESSION_MIN = 25;         // sends this close together are one visit
const VISIT_GAP_MIN = 31;            // a new visit needs more than 30 minutes away (D-026)
const OFF_DAY = 0.55;                // a day with no trading (weekend, holiday): fewer visits
const CHURNED_HABIT = 0.08;
const FRESH_DAYS = 2;                // the first days after joining: a new player comes back more often
const FRESH = 1.15;
const FADE_PER_DAY = 0.012;          // then the habit fades a little every day, down to FADE_FLOOR of itself
const FADE_FLOOR = 0.7;
const MAX_CHANCE = 0.97;
const LAST_EVENING: Range = [23 * 60 + 5, 23 * 60 + 40];   // after the New York close (23:00)

// A send's minute: mostly while its market is open, sometimes outside it (the order waits for the next open).
function sendMinute(rng: Rng, market: Market, day: number): number {
  const inHours = rng() < 0.85;
  const m = market === 'TASE'
    ? (inHours ? int(rng, 9 * 60 + 30, 17 * 60 + 20) : int(rng, 18 * 60, 23 * 60 + 30))
    : (inHours ? int(rng, 15 * 60 + 45, 22 * 60 + 50) : int(rng, 8 * 60, 15 * 60 + 30));
  return day === 0 ? Math.max(m, FIRST_SEND_DAY0) : m;
}

// The month of one player: which days they open the app, how many orders they send on each, and when.
// The join day always has a visit and 3 to 5 sends (a first portfolio); the rest of the orders go to later days
// they come back on, mostly trading days. A new player comes back more in their first days, then less and less,
// so the day-1 return is above the day-7 return (D-026), as in a real launch. `tradingDay(k)` says whether either
// market opens on world day k.
export function planPlayer(p: Persona, tradingDay: (day: number) => boolean, days = GAME_DAYS): PlanDay[] {
  const rng = mulberry32(seedOf(`${p.uid}|plan`));
  const chance = (k: number) => {
    if (p.churnDay !== null && k >= p.churnDay) return CHURNED_HABIT * (tradingDay(k) ? 1 : OFF_DAY);
    const since = k - p.joinDay;
    const age = since <= FRESH_DAYS ? FRESH : Math.max(FADE_FLOOR, 1 - FADE_PER_DAY * since);
    return Math.min(MAX_CHANCE, p.habit * age) * (tradingDay(k) ? 1 : OFF_DAY);
  };
  const active = Array.from({ length: days }, (_, k) => k === p.joinDay || (k > p.joinDay && rng() < chance(k)));

  const counts = repeat(0, days);
  const first = Math.min(p.orders, int(rng, 3, 5));
  counts[p.joinDay] = first;
  const later = active.flatMap((a, k) => (a && k > p.joinDay ? [k] : []));
  const weights = later.map((k) => (tradingDay(k) ? 1 : 0.15));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  for (let n = first; n < p.orders; n++) {
    if (later.length === 0) {
      counts[p.joinDay]++;
      continue;
    }
    let x = rng() * totalWeight;
    let i = 0;
    while (i < later.length - 1 && x >= weights[i]) x -= weights[i++];
    counts[later[i]]++;
  }

  return active.map((isActive, day): PlanDay => {
    if (!isActive) return { day, sends: [], sessions: [] };
    const sends = Array.from({ length: counts[day] }, (): Send => {
      const market: Market = rng() < p.usShare ? 'US' : 'TASE';
      return { minute: sendMinute(rng, market, day), market };
    });
    // The month's last evening: the day's last send comes after both markets closed, so it is still waiting for
    // the next open when the game is handed over (pending orders on the dashboard, the journal, the admin pages).
    if (day === days - 1 && sends.length > 0) sends[sends.length - 1].minute = int(rng, LAST_EVENING[0], LAST_EVENING[1]);
    sends.sort((a, b) => a.minute - b.minute);

    // A visit starts a few minutes before the first send of each burst; a few visits are only to look around.
    const starts: number[] = [];
    let last = -Infinity;
    for (const s of sends) {
      if (s.minute - last > SAME_SESSION_MIN) starts.push(Math.max(0, s.minute - int(rng, 2, 12)));
      last = s.minute;
    }
    const extra = sends.length === 0 ? 1 + (rng() < 0.4 ? 1 : 0) : rng() < 0.35 ? 1 : 0;
    for (let i = 0; i < extra; i++) starts.push(int(rng, day === 0 ? WORLD_START_MINUTE : 7 * 60 + 30, 23 * 60 + 30));
    starts.sort((a, b) => a - b);
    // Two visits closer than the gap are one: keep the earlier, so every send still comes after a visit start.
    const sessions = starts.filter((m, i) => i === 0 || m - starts[i - 1] >= VISIT_GAP_MIN);
    return { day, sends, sessions };
  });
}

// When the player signs up: a minute or so before their first visit on the join day.
export function signupMinute(p: Persona, plan: readonly PlanDay[]): number {
  const rng = mulberry32(seedOf(`${p.uid}|signup`));
  return Math.max(0, plan[p.joinDay].sessions[0] - int(rng, 1, 3));
}

// ---------- what they did on the app that day (D-036) ----------

export type DayUsage = {
  pages: Record<UsagePage, { views: number; ms: number }>;
  confirms: { opened: number; backed: number };
};

// A day's page views and time, and the confirm popup, from the visits and the orders that were really sent.
// Every send opened the popup; before each one the player may have backed out once (hesitancy), and on a day
// without a send they sometimes opened it and backed out. All whole numbers; nothing when there was no visit.
export function usageFor(p: Persona, day: number, sessions: number, sent: number): DayUsage {
  const zero = { views: 0, ms: 0 };
  if (sessions === 0) {
    return { pages: { dashboard: zero, trade: zero, journal: zero, leaderboard: zero }, confirms: { opened: 0, backed: 0 } };
  }
  const rng = mulberry32(seedOf(`${p.uid}|${day}|usage`));
  let backed = 0;
  for (let i = 0; i < sent; i++) if (rng() < p.hesitancy) backed++;
  if (sent === 0 && rng() < 0.15) backed = 1;

  const page = (views: number, minMs: number, maxMs: number) => {
    let ms = 0;
    for (let i = 0; i < views; i++) ms += Math.round(between(rng, minMs, maxMs));
    return { views, ms };
  };
  return {
    pages: {
      dashboard: page(sessions + int(rng, 0, sessions), 25_000, 150_000),
      trade: page(sent + backed + int(rng, 0, 2), 35_000, 180_000),
      journal: page((sent > 0 ? int(rng, 0, 2) : 0) + (rng() < 0.3 ? 1 : 0), 15_000, 80_000),
      leaderboard: page(int(rng, 0, p.style === 'aggressive' ? 3 : 2) + (rng() < 0.25 ? 1 : 0), 20_000, 110_000),
    },
    confirms: { opened: sent + backed, backed },
  };
}

// ---------- what they send ----------

export type HeldStock = {
  symbol: string;
  market: Market;
  units: string;        // positions.units, 8 decimals
  freeUnits: string;    // units − reserved_units (not locked by a pending sell)
  value: number;        // ₪, at the last mark
  cost: number;         // ₪ paid for the units held
};

// What the player sees on their screen when they decide: ₪ as plain numbers (a decision, not money math; the
// server checks and stores everything exactly).
export type PlayerView = {
  availableCash: number;
  equity: number;
  holdings: HeldStock[];
  pendingBuys: ReadonlyMap<string, number>;   // ₪ of pending buys per symbol (they count toward the 20%)
};

export type Decision =
  | { side: 'buy'; symbol: string; amountIls: string; stopPrice: string | null }
  | { side: 'sell'; symbol: string; units: string };

const LIMIT = 0.2;            // the 20% rule (D-020)
const MIN_ORDER = 100;        // ₪ (D-014)
const MIN_PARTIAL_SELL = 150; // ₪: a smaller part is sold whole, well clear of the ₪100 rule
const BUY_SHARE: Record<Exclude<Style, 'aggressive'>, Range> = { active: [0.03, 0.09], balanced: [0.05, 0.12], cautious: [0.02, 0.06] };
const SELL_BASE: Record<Style, number> = { active: 0.42, balanced: 0.32, cautious: 0.25, aggressive: 0.3 };

// One order for a stock of `market`, or null when nothing fits. `price(symbol)` is the latest close the trade
// screen shows (null = none yet). `first` = a send on the join day: always a buy, to build a first portfolio.
// Aggressive players often buy right up to the 20% limit; a price move before the fill then rejects some of
// those buys at the open or close (OVER_LIMIT), as it would for a real player.
export function decide(
  p: Persona,
  rng: Rng,
  view: PlayerView,
  market: Market,
  price: (symbol: string) => number | null,
  first: boolean,
): Decision | null {
  const sellable = view.holdings.filter((h) => h.market === market && parse(h.freeUnits, SCALE.UNITS) > 0n);
  if (!first && sellable.length > 0 && rng() < sellChance(p, view)) return sell(p, rng, sellable);
  const buy = buyOrder(p, rng, view, market, price);
  if (buy) return buy;
  return !first && sellable.length > 0 ? sell(p, rng, sellable) : null;   // no room to buy: sell instead
}

function sellChance(p: Persona, view: PlayerView): number {
  const cashShare = view.equity > 0 ? view.availableCash / view.equity : 1;
  if (cashShare < 0.04) return 0.95;
  return Math.min(0.85, Math.max(0.08, SELL_BASE[p.style] + (0.45 - cashShare) * 0.9));
}

function buyOrder(p: Persona, rng: Rng, view: PlayerView, market: Market, price: (symbol: string) => number | null): Decision | null {
  const own = p.favorites.filter((s) => MARKET_OF.get(s) === market);
  const others = (market === 'TASE' ? TASE_SYMBOLS : US_SYMBOLS).filter((s) => !own.includes(s));
  const candidates = [...(rng() < 0.2 ? [others[Math.floor(rng() * others.length)]] : []), ...shuffle(rng, own)];
  for (const symbol of candidates) {
    const close = price(symbol);
    if (close === null) continue;
    const held = view.holdings.find((h) => h.symbol === symbol)?.value ?? 0;
    const room = Math.min(view.availableCash, LIMIT * view.equity - held - (view.pendingBuys.get(symbol) ?? 0)) - 1;
    if (room < MIN_ORDER) continue;
    const amount = buyAmount(p, rng, view.equity, room);
    if (amount < MIN_ORDER) continue;
    return { side: 'buy', symbol, amountIls: String(amount), stopPrice: rng() < p.stopShare ? stopBelow(rng, close) : null };
  }
  return null;
}

// Whole shekels. Most players type a round sum; the aggressive "max" uses nearly all the room the ticket shows.
function buyAmount(p: Persona, rng: Rng, equity: number, room: number): number {
  if (p.style === 'aggressive' && rng() < 0.45) return Math.floor(room * between(rng, 0.985, 0.999));
  const share = p.style === 'aggressive' ? between(rng, 0.1, 0.19) : between(rng, ...BUY_SHARE[p.style]);
  const amount = Math.min(equity * share, room);
  const step = amount >= 10_000 ? 500 : 100;
  return Math.floor(amount / step) * step;
}

// 3% to 9% under the latest close, 2 decimals (the ticket's precision), always strictly below it.
function stopBelow(rng: Rng, close: number): string | null {
  const stop = Math.floor(close * (1 - between(rng, 0.03, 0.09)) * 100) / 100;
  return stop > 0 && stop < close ? stop.toFixed(2) : null;
}

// Half the time the position furthest from its cost (taking a gain or cutting a loss), else any. All of it, or
// a quarter to three quarters of the free units.
function sell(p: Persona, rng: Rng, sellable: readonly HeldStock[]): Decision {
  const h = rng() < 0.5
    ? sellable.reduce((a, b) => (Math.abs(b.value - b.cost) > Math.abs(a.value - a.cost) ? b : a))
    : sellable[Math.floor(rng() * sellable.length)];
  const free = parse(h.freeUnits, SCALE.UNITS);
  const all = rng() < (p.style === 'active' ? 0.35 : 0.5);
  if (!all) {
    const part = (free * BigInt(Math.round(between(rng, 0.25, 0.75) * 10_000))) / 10_000n;
    const units = parse(h.units, SCALE.UNITS);
    const partValue = units > 0n ? (h.value * Number(part)) / Number(units) : 0;
    if (part > 0n && partValue >= MIN_PARTIAL_SELL) return { side: 'sell', symbol: h.symbol, units: format(part, SCALE.UNITS) };
  }
  return { side: 'sell', symbol: h.symbol, units: format(free, SCALE.UNITS) };
}

// ---------- the two clocks ----------

// The game day of an Israel date: 0 = the world's first day.
export function dayIndex(firstDate: string, date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${firstDate}T00:00:00Z`)) / 86_400_000);
}

// World time of a minute (and second) of game day k, on the Israel clock.
export function worldInstant(startDate: string, day: number, minute: number, second = 0): Date {
  return new Date(zonedToInstant(addDays(startDate, day), minute, ISRAEL).getTime() + second * 1000);
}

// Nothing real is written closer to now than this, so a backdated order never counts toward the 5-a-minute limit.
export const NOW_MARGIN_MIN = 5;

// The real instant game day k is shown at: real date firstRealDate + k, same Israel clock time. Today (the last
// day) is squeezed into the part of the day that is already over, so nothing lands in the future; a day after
// today (never planned) lands today too. It never leaves its date: run just after midnight, today's activity all
// sits at 00:00 rather than slipping into yesterday (its usage rows are dated today).
export function realInstant(firstRealDate: string, day: number, minute: number, second: number, realNow: Date): Date {
  const now = zonedParts(realNow, ISRAEL);
  let date = addDays(firstRealDate, day);
  let m = minute;
  if (date >= now.date) {
    date = now.date;
    m = Math.floor((minute * Math.max(0, now.minutes - NOW_MARGIN_MIN)) / 1440);
  }
  const dayStart = zonedToInstant(date, 0, ISRAEL).getTime();
  const t = zonedToInstant(date, m, ISRAEL).getTime() + second * 1000;   // not dayStart + m: a DST switch day
  return new Date(Math.max(dayStart, Math.min(t, realNow.getTime() - NOW_MARGIN_MIN * 60_000)));
}

// The real instant a world instant is shown at.
export function realOfWorld(startDate: string, firstRealDate: string, worldAt: Date, realNow: Date): Date {
  const w = zonedParts(worldAt, ISRAEL);
  return realInstant(firstRealDate, dayIndex(startDate, w.date), w.minutes, worldAt.getUTCSeconds(), realNow);
}

// ---------- the script's options ----------

export type GameArgs = { clear: boolean; force: boolean };

// `--clear` removes the sample players and everything they did. `--force` also wipes real players' orders (the
// game starts the world over) and writes into a database with more than 1,000 players.
export function parseGameArgs(argv: readonly string[]): GameArgs | { error: string } {
  const args: GameArgs = { clear: false, force: false };
  for (const a of argv) {
    if (a === '--clear') args.clear = true;
    else if (a === '--force') args.force = true;
    else return { error: `Unknown option: ${a}` };
  }
  if (args.clear && args.force) return { error: '--force only applies when playing the game, not with --clear.' };
  return args;
}
