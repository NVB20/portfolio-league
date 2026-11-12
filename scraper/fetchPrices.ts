// Fetches 3 years of daily open/close prices from Yahoo Finance
// for every security in securities.ts, and saves them into Postgres.
// Run it with: docker compose run --rm scraper
// Safe to run again: existing days are updated, never duplicated.
//
// Two optional settings (the `prices` service in docker-compose.yml sets both):
//   PRICES_UNTIL=2026-11-05  the last day to fetch, so the 3 years end there instead of yesterday. The market
//                            calendar (api/src/world/closures.ts) was checked against one exact window, and
//                            `npm run seed:world` refuses prices with a holiday the calendar doesn't know.
//   ONLY_IF_EMPTY=1          do nothing when prices are already saved, so `docker compose up` calls Yahoo once.

import pg from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { SECURITIES } from './securities.ts';
import type { Security } from './securities.ts';

const YEARS = 3;
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const ATTEMPTS = 3; // per symbol: Yahoo sometimes answers 429 or 5xx for a moment

const UNTIL = process.env.PRICES_UNTIL?.trim() || null;
if (UNTIL !== null && !/^\d{4}-\d{2}-\d{2}$/.test(UNTIL)) {
  throw new Error(`PRICES_UNTIL must be a day like 2026-11-05 (got "${UNTIL}")`);
}
const ONLY_IF_EMPTY = process.env.ONLY_IF_EMPTY === '1';

type DailyPrice = { day: string; open: number; close: number };

// The parts of Yahoo's chart response that we use.
type YahooChart = {
  chart: {
    result: Array<{
      meta: { currency: string; exchangeTimezoneName: string };
      timestamp?: number[];
      indicators: { quote: Array<{ open: (number | null)[]; close: (number | null)[] }> };
    }> | null;
    error: { description: string } | null;
  };
};

async function fetchFromYahoo(symbol: string): Promise<{ currency: string; prices: DailyPrice[] }> {
  // With PRICES_UNTIL: up to midnight UTC after that day (every market's bar for that day starts before it).
  const to = UNTIL ? new Date(Date.parse(`${UNTIL}T00:00:00Z`) + 24 * 3600 * 1000) : new Date();
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - YEARS);
  // Yahoo wants Unix time in seconds; JavaScript dates are in milliseconds.
  const period1 = Math.floor(from.getTime() / 1000);
  const period2 = Math.floor(to.getTime() / 1000);

  // encodeURIComponent: "ILS=X" contains "=", which must be escaped inside a URL path.
  const url = `${YAHOO_CHART_URL}${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
  // Yahoo rejects requests that have no browser-like User-Agent.
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = (await res.json()) as YahooChart;
  const result = json.chart.result?.[0];
  if (!result) throw new Error(json.chart.error?.description ?? 'no data');

  const { currency, exchangeTimezoneName } = result.meta;
  const timestamps = result.timestamp ?? [];
  const quote = result.indicators.quote[0];

  // Each timestamp is the moment the market opened. We turn it into the calendar day
  // in the EXCHANGE's time zone, so a Tel Aviv day stays a Tel Aviv day.
  // The "en-CA" locale formats dates as YYYY-MM-DD, which Postgres reads as a DATE.
  const toDay = new Intl.DateTimeFormat('en-CA', { timeZone: exchangeTimezoneName });

  // Today's bar isn't finished: its "close" is just the latest live price. Keep only past days.
  // "YYYY-MM-DD" strings sort like dates, so plain < works.
  const today = toDay.format(new Date());

  // A Map keyed by day: if Yahoo sends the same day twice, the last one wins.
  const byDay = new Map<string, DailyPrice>();
  timestamps.forEach((t, i) => {
    const open = quote.open[i];
    const close = quote.close[i];
    // Yahoo sends null for days with no trading data. Skip them.
    if (open == null || close == null || open <= 0 || close <= 0) return;
    const day = toDay.format(new Date(t * 1000));
    if (day >= today) return;
    if (UNTIL && day > UNTIL) return;
    byDay.set(day, { day, open, close });
  });

  return { currency, prices: [...byDay.values()] };
}

async function saveToDb(db: pg.Client, sec: Security, currency: string, prices: DailyPrice[]) {
  // A transaction: either the security AND all its prices are saved, or nothing is.
  await db.query('BEGIN');
  try {
    // "Upsert": insert, or update the row if this symbol already exists.
    await db.query(
      `INSERT INTO securities (symbol, name, market, currency)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (symbol) DO UPDATE
         SET name = EXCLUDED.name, market = EXCLUDED.market, currency = EXCLUDED.currency`,
      [sec.symbol, sec.name, sec.market, currency],
    );

    // All ~750 days in ONE query: unnest() turns three arrays into rows
    // (day[0], open[0], close[0]), (day[1], open[1], close[1]), ...
    // $1 etc. are parameters: pg sends values separately, so they can't inject SQL.
    await db.query(
      `INSERT INTO daily_prices (symbol, day, open, close)
       SELECT $1::text, * FROM unnest($2::date[], $3::numeric[], $4::numeric[])
       ON CONFLICT (symbol, day) DO UPDATE
         SET open = EXCLUDED.open, close = EXCLUDED.close, fetched_at = now()`,
      [sec.symbol, prices.map((p) => p.day), prices.map((p) => p.open), prices.map((p) => p.close)],
    );

    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

// A failed fetch is tried again after 2 s, then 4 s, before the symbol counts as failed.
async function fetchWithRetries(symbol: string): ReturnType<typeof fetchFromYahoo> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchFromYahoo(symbol);
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;
      console.warn(`… ${symbol}: ${(err as Error).message}, trying again`);
      await sleep(2000 * attempt);
    }
  }
}

async function main() {
  // pg reads PGHOST, PGUSER, PGPASSWORD and PGDATABASE from the environment (set in docker-compose.yml).
  const db = new pg.Client();
  await db.connect();

  if (ONLY_IF_EMPTY) {
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM daily_prices');
    if (rows[0].n > 0) {
      console.log(`Prices already saved (${rows[0].n} rows): not calling Yahoo. Unset ONLY_IF_EMPTY to fetch again.`);
      await db.end();
      return;
    }
  }
  console.log(`Fetching ${YEARS} years of prices${UNTIL ? ` up to ${UNTIL}` : ''} for ${SECURITIES.length} symbols from Yahoo...`);

  const failed: string[] = [];
  for (const sec of SECURITIES) {
    try {
      const { currency, prices } = await fetchWithRetries(sec.symbol);
      await saveToDb(db, sec, currency, prices);
      console.log(`✔ ${sec.symbol.padEnd(9)} ${String(prices.length).padStart(4)} days  (${currency})`);
    } catch (err) {
      // One bad symbol shouldn't stop the other 40.
      failed.push(sec.symbol);
      console.error(`✘ ${sec.symbol}: ${(err as Error).message}`);
    }
    // Wait a little between requests so Yahoo doesn't block us for flooding it.
    await sleep(500);
  }

  await db.end();
  console.log(`\nDone. ${SECURITIES.length - failed.length}/${SECURITIES.length} saved.`);
  if (failed.length > 0) {
    console.log(`Failed: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

main();
