// Chart bars from Yahoo Finance, as pure functions (no network, no database).
// The game trades only on the stored open/close; these bars are for the chart only (D-012).

import type { ChartBar } from '../contract.js';

export type Bar = ChartBar;

// The part of Yahoo's /v8/finance/chart JSON that we read.
type YahooChart = {
  chart?: {
    result?: {
      meta?: { currency?: string; exchangeTimezoneName?: string };
      timestamp?: number[];
      indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
    }[];
  };
};

// Daily bars from Yahoo's JSON, oldest first. Each timestamp becomes the exchange's own calendar date.
// TASE prices come in agorot ('ILA') and are turned into shekels. Days with a missing value are skipped.
export function parseYahooDaily(json: unknown): Bar[] {
  const result = (json as YahooChart)?.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0];
  if (!q) return [];
  const timeZone = result?.meta?.exchangeTimezoneName ?? 'UTC';
  const scale = result?.meta?.currency === 'ILA' ? 100 : 1;
  const dateOf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });

  const byDay = new Map<string, Bar>();
  ts.forEach((t, i) => {
    const open = q.open?.[i], high = q.high?.[i], low = q.low?.[i], close = q.close?.[i];
    if (open == null || high == null || low == null || close == null) return;
    if (!(open > 0 && high > 0 && low > 0 && close > 0)) return;
    const time = dateOf.format(new Date(t * 1000));   // en-CA formats as YYYY-MM-DD
    // The last one wins: Yahoo can repeat the current day as a live row.
    // Rounded to 4 decimals: Yahoo sends float noise like 189.83999633789062.
    const px = (v: number) => Math.round((v / scale) * 10_000) / 10_000;
    byDay.set(time, {
      time,
      open: px(open),
      high: px(high),
      low: px(low),
      close: px(close),
      volume: q.volume?.[i] ?? 0,
    });
  });
  return [...byDay.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

// Only the bars whose day has already closed in world time. Later bars are the future and must not leak.
export function barsUpTo(bars: Bar[], lastDay: string): Bar[] {
  return bars.filter((b) => b.time <= lastDay);
}

// Weekly bars, keyed by the Monday of each week: the first open, the highest high, the lowest low,
// the last close, the summed volume. Built from the already-cut daily bars, so a week in progress
// only contains the days that have happened.
export function toWeekly(daily: Bar[]): Bar[] {
  const out: Bar[] = [];
  let current: Bar | null = null;
  for (const d of daily) {
    const key = mondayKey(d.time);
    if (!current || current.time !== key) {
      current = { ...d, time: key };
      out.push(current);
    } else {
      current.high = Math.max(current.high, d.high);
      current.low = Math.min(current.low, d.low);
      current.close = d.close;
      current.volume += d.volume;
    }
  }
  return out;
}

function mondayKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
