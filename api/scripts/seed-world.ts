// Copies the game world from the local price database (D-002) into the game database (D-003, D-011):
//   - the 40 securities (names, market, exchange, Yahoo symbol)
//   - their daily open/close, TASE agorot turned into shekels
//   - the daily USD/ILS rate
//   - the market calendar: every weekday a market is closed (D-016), checked against the prices
//   - the world clock, ONLY if it was never set (the start time is D-013), and where it must stop (D-017)
//
// Safe to run again: every row is an upsert, and an existing clock is never moved.
//
//   cd api && npm run seed:world
//
// Reads PRICES_DATABASE_URL (default: the local Docker price DB) and DATABASE_URL (the game DB) from api/.env.
// To seed production: run it locally with DATABASE_URL pointing at the production database.

import pg from 'pg';
import { USD_ILS_YAHOO, WORLD_SECURITIES } from '../src/world/securities.js';
import { WORLD_CLOSURES } from '../src/world/closures.js';
import { type Calendar, makeCalendar, type Market, MARKETS, nextOpen, sessionOn } from '../src/game/marketHours.js';
import { addDays, ISRAEL, weekdayOf, zonedToInstant } from '../src/game/time.js';

import { HISTORY_DAYS, worldStartAt } from '../src/game/worldStart.js';

const PRICES_URL = process.env.PRICES_DATABASE_URL ?? 'postgres://hof:hof_dev@localhost:5432/prices';
const GAME_URL = process.env.DATABASE_URL;
if (!GAME_URL) throw new Error('Missing environment variable DATABASE_URL');

const prices = new pg.Client({ connectionString: PRICES_URL });
const game = new pg.Client({ connectionString: GAME_URL });

async function main() {
  await prices.connect();
  await game.connect();

  // Every security must exist in the price DB with the currency we expect, or we stop before writing anything.
  const yahoo = WORLD_SECURITIES.map((s) => s.yahoo);
  const known = await prices.query<{ symbol: string; currency: string }>(
    'SELECT symbol, currency FROM securities WHERE symbol = ANY($1)',
    [[...yahoo, USD_ILS_YAHOO]],
  );
  const currencyOf = new Map(known.rows.map((r) => [r.symbol, r.currency]));
  for (const s of WORLD_SECURITIES) {
    const expected = s.market === 'TASE' ? 'ILA' : 'USD';
    if (currencyOf.get(s.yahoo) !== expected) {
      throw new Error(`${s.yahoo}: expected currency ${expected} in the price DB, found ${currencyOf.get(s.yahoo) ?? 'nothing'}`);
    }
  }
  if (!currencyOf.has(USD_ILS_YAHOO)) throw new Error(`${USD_ILS_YAHOO} is missing from the price DB`);

  await game.query('BEGIN');
  try {
    for (const s of WORLD_SECURITIES) {
      await game.query(
        `INSERT INTO securities (symbol, name_he, name_en, market, exchange, currency, yahoo_symbol)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (symbol) DO UPDATE SET
           name_he = EXCLUDED.name_he, name_en = EXCLUDED.name_en, market = EXCLUDED.market,
           exchange = EXCLUDED.exchange, currency = EXCLUDED.currency, yahoo_symbol = EXCLUDED.yahoo_symbol`,
        [s.symbol, s.nameHe, s.nameEn, s.market, s.exchange, s.market === 'TASE' ? 'ILS' : 'USD', s.yahoo],
      );

      // Agorot -> shekels for TASE (Yahoo's 'ILA'). Done in NUMERIC, so 13100.0000 agorot is exactly 131.0000 ₪.
      const divisor = s.market === 'TASE' ? 100 : 1;
      const { rows } = await prices.query<{ day: string; open: string; close: string }>(
        `SELECT day::text AS day, (open / $2)::text AS open, (close / $2)::text AS close
         FROM daily_prices WHERE symbol = $1 ORDER BY day`,
        [s.yahoo, divisor],
      );
      await upsertDays(game, 'prices', s.symbol, rows);
      console.log(`${s.symbol.padEnd(6)} ${rows.length} days`);
    }

    const fx = await prices.query<{ day: string; open: string; close: string }>(
      'SELECT day::text AS day, open::text AS open, close::text AS close FROM daily_prices WHERE symbol = $1 ORDER BY day',
      [USD_ILS_YAHOO],
    );
    await upsertDays(game, 'usd_ils', null, fx.rows);
    console.log(`USD/ILS ${fx.rows.length} days`);

    // The calendar: the list in closures.ts is the source of truth, so replace the table with it.
    await game.query('DELETE FROM market_closures');
    await game.query(
      `INSERT INTO market_closures (market, day, reason_he, reason_en)
       SELECT * FROM unnest($1::text[], $2::date[], $3::text[], $4::text[])`,
      [
        WORLD_CLOSURES.map((c) => c.market),
        WORLD_CLOSURES.map((c) => c.day),
        WORLD_CLOSURES.map((c) => c.reason),
        WORLD_CLOSURES.map((c) => c.reasonEn),
      ],
    );
    const calendar = makeCalendar(WORLD_CLOSURES);
    const historyStart = await firstCommonDay(game);
    const lastDays = await checkCalendar(game, calendar, historyStart);
    console.log(`Calendar: ${WORLD_CLOSURES.length} closed weekdays, all match the prices`);

    // The world starts the first Monday at least HISTORY_DAYS after the history begins, 09:00 Israel time
    // (D-013), so players arrive with closes already behind them. All prices are still copied from day one.
    const worldStart = worldStartAt(historyStart);
    const clock = await game.query(
      'INSERT INTO world_clock (now_at) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING now_at',
      [worldStart],
    );
    console.log(
      clock.rowCount
        ? `World clock set to ${worldStart.toISOString()} (history from ${historyStart}, ${HISTORY_DAYS}+ days before)`
        : 'World clock already set, not moved',
    );

    // The clock stops one minute before the first open that has no prices, so every event it can reach has a price.
    const endsAt = new Date(
      Math.min(...MARKETS.map((m) => nextOpen(m, lastClose(m, lastDays[m], calendar), calendar).at.getTime())) - 60_000,
    );
    await game.query('UPDATE world_clock SET ends_at = $1', [endsAt]);
    console.log(`World clock ends at ${endsAt.toISOString()}`);

    await game.query('COMMIT');
  } catch (err) {
    await game.query('ROLLBACK');
    throw err;
  }
}

// The first day on which every series has data: both markets and USD/ILS. The history starts here.
async function firstCommonDay(db: pg.Client): Promise<string> {
  const { rows } = await db.query<{ first: string | null }>(
    `SELECT GREATEST(
       (SELECT min(p.day) FROM prices p JOIN securities s USING (symbol) WHERE s.market = 'TASE'),
       (SELECT min(p.day) FROM prices p JOIN securities s USING (symbol) WHERE s.market = 'US'),
       (SELECT min(day) FROM usd_ils)
     )::text AS first`,
  );
  const first = rows[0]?.first;
  if (!first) throw new Error('No prices loaded: cannot work out when the history starts');
  return first;
}

// A weekday must be in the calendar exactly when it has no prices, from the first day of the history (the
// days before the world starts are history players see, so they must match too) to the last day with
// prices. Any mismatch stops the seed (and rolls it back) with the list of bad days.
// Returns each market's last day with prices.
async function checkCalendar(db: pg.Client, calendar: Calendar, historyStart: string): Promise<Record<Market, string>> {
  const { rows } = await db.query<{ market: Market; days: string[] }>(
    `SELECT s.market, array_agg(DISTINCT p.day::text) AS days
     FROM prices p JOIN securities s USING (symbol) GROUP BY s.market`,
  );
  const lastDays = {} as Record<Market, string>;
  const problems: string[] = [];
  for (const market of MARKETS) {
    const traded = new Set(rows.find((r) => r.market === market)?.days ?? []);
    if (traded.size === 0) throw new Error(`No ${market} prices loaded`);
    const last = [...traded].sort().at(-1)!;
    lastDays[market] = last;
    for (let day = historyStart; day <= last; day = addDays(day, 1)) {
      const weekday = weekdayOf(day);
      if (weekday === 0 || weekday === 6) continue;
      const closed = calendar.closedReason(market, day) !== null;
      if (closed && traded.has(day)) problems.push(`${market} ${day}: in the calendar but has prices`);
      if (!closed && !traded.has(day)) problems.push(`${market} ${day}: no prices but not in the calendar`);
    }
  }
  if (problems.length > 0) throw new Error(`The calendar doesn't match the prices:\n  ${problems.join('\n  ')}`);
  return lastDays;
}

function lastClose(market: Market, day: string, calendar: Calendar): Date {
  return zonedToInstant(day, sessionOn(market, day, calendar)!.closeMin, ISRAEL);
}

// One multi-row INSERT per security (about 750 rows), instead of 750 round trips.
async function upsertDays(
  db: pg.Client,
  table: 'prices' | 'usd_ils',
  symbol: string | null,
  rows: { day: string; open: string; close: string }[],
) {
  if (rows.length === 0) return;
  const days = rows.map((r) => r.day);
  const opens = rows.map((r) => r.open);
  const closes = rows.map((r) => r.close);
  if (table === 'prices') {
    await db.query(
      `INSERT INTO prices (symbol, day, open, close)
       SELECT $1, d, o, c FROM unnest($2::date[], $3::numeric[], $4::numeric[]) AS t(d, o, c)
       ON CONFLICT (symbol, day) DO UPDATE SET open = EXCLUDED.open, close = EXCLUDED.close`,
      [symbol, days, opens, closes],
    );
  } else {
    await db.query(
      `INSERT INTO usd_ils (day, open, close)
       SELECT d, o, c FROM unnest($1::date[], $2::numeric[], $3::numeric[]) AS t(d, o, c)
       ON CONFLICT (day) DO UPDATE SET open = EXCLUDED.open, close = EXCLUDED.close`,
      [days, opens, closes],
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prices.end().catch(() => {});
    await game.end().catch(() => {});
  });
