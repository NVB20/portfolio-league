// GET /me/chart/:symbol: real daily OHLC + volume from Yahoo Finance, for the full chart only.
// The game trades on the stored open/close; Yahoo is never used for money (D-012).
//
// Load: Yahoo is called at most once per symbol per CACHE_MS, however many players open the chart,
// and two requests for the same symbol at the same moment share one call. 40 symbols = at most
// 40 Yahoo calls per 12 hours. Every request then cuts the bars at the world clock, so nobody sees the future.

import type { Pool } from 'pg';
import type { ChartView } from './contract.js';
import { barsUpTo, parseYahooDaily, toWeekly, type Bar } from './game/bars.js';
import { lastClosedDay } from './game/marketHours.js';
import { loadNow } from './dashboard.js';

const CACHE_MS = 12 * 60 * 60 * 1000;
const DAILY_SENT = 320;    // enough for 6 months shown + a 50-day average before them
const WEEKLY_SENT = 80;
const HISTORY_FROM = Date.UTC(2023, 0, 1) / 1000;   // our price history starts in Nov 2023

// Fetches all daily bars of one Yahoo symbol. Injected, so tests never touch the network.
export type FetchDaily = (yahooSymbol: string) => Promise<Bar[]>;

export const fetchYahooDaily: FetchDaily = async (yahooSymbol) => {
  const now = Math.floor(Date.now() / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}` +
    `?period1=${HISTORY_FROM}&period2=${now}&interval=1d`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // Yahoo rejects requests without a browser-like User-Agent (same as the scraper).
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    if (!res.ok) throw new Error(`Yahoo ${yahooSymbol}: HTTP ${res.status}`);
    return parseYahooDaily(await res.json());
  } finally {
    clearTimeout(timer);
  }
};

// A small in-memory cache in front of a FetchDaily. One per API process.
export function cachedDaily(fetchDaily: FetchDaily, cacheMs = CACHE_MS): FetchDaily {
  const cache = new Map<string, { at: number; bars: Promise<Bar[]> }>();
  return (symbol) => {
    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.at < cacheMs) return hit.bars;
    const bars = fetchDaily(symbol);
    cache.set(symbol, { at: Date.now(), bars });
    bars.catch(() => cache.delete(symbol));   // a failed call is not cached: the next request tries again
    return bars;
  };
}

// null = unknown symbol, or one without a chart.
export async function getChart(db: Pool, fetchDaily: FetchDaily, symbol: string, tf: 'D' | 'W'): Promise<ChartView | null> {
  const { rows } = await db.query<{ yahoo_symbol: string | null; market: 'TASE' | 'US'; currency: 'ILS' | 'USD' }>(
    'SELECT s.yahoo_symbol, s.market, s.currency FROM securities s WHERE s.symbol = $1',
    [symbol],
  );
  const sec = rows[0];
  if (!sec?.yahoo_symbol) return null;

  // Before the world starts there is no "now", so no day is known yet: no bars.
  const now = await loadNow(db);
  if (!now) return { symbol, currency: sec.currency, tf, lastDay: null, bars: [] };

  const lastDay = lastClosedDay(sec.market, now.at, now.calendar);
  const daily = barsUpTo(await fetchDaily(sec.yahoo_symbol), lastDay);
  const bars = tf === 'W' ? toWeekly(daily).slice(-WEEKLY_SENT) : daily.slice(-DAILY_SENT);
  return { symbol, currency: sec.currency, tf, lastDay, bars };
}
