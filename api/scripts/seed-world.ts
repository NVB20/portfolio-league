// Copies the game world from the local price database (D-002) into the game database (D-003, D-011):
//   - the 40 securities (names, market, exchange, Yahoo symbol)
//   - their daily open/close, TASE agorot turned into shekels
//   - the daily USD/ILS rate
//   - the world clock, ONLY if it was never set (the start time is D-013)
//
// Safe to run again: every row is an upsert, and an existing clock is never moved.
//
//   cd api && npm run seed:world
//
// Reads PRICES_DATABASE_URL (default: the local Docker price DB) and DATABASE_URL (the game DB) from api/.env.
// To seed Railway: run it locally with DATABASE_URL pointing at the Railway database.

import pg from 'pg';
import { USD_ILS_YAHOO, WORLD_SECURITIES } from '../src/world/securities.js';

// The first moment of the game: Monday 5 January 2026, 09:00 Israel time (07:00 UTC), one hour before
// TASE opens, in the first week when TASE trades Monday to Friday (D-013).
const WORLD_START = '2026-01-05T07:00:00Z';

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

    const clock = await game.query(
      'INSERT INTO world_clock (now_at) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING now_at',
      [WORLD_START],
    );
    console.log(clock.rowCount ? `World clock set to ${WORLD_START}` : 'World clock already set, not moved');

    await game.query('COMMIT');
  } catch (err) {
    await game.query('ROLLBACK');
    throw err;
  }
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
