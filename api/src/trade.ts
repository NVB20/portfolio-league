// GET /me/trade: everything the trading screen shows, in one read-only request.
// The 40 securities with their latest known close, the player's cash and holdings, when an order sent
// now would run, the pending orders, and the player's chart settings.
//
// Prices follow D-009: the latest daily close that has already happened in world time.
// Nothing is written here. Sending an order (POST /me/orders) comes with the game engine.

import type { Pool } from 'pg';
import type { OrderView, SecurityView, TradeView } from './contract.js';
import { withDefaults } from './chartSettings.js';
import { clockView, loadNow, loadPortfolio, loadUsdIls, worldTime } from './dashboard.js';
import { executionFor, isMarketOpen } from './game/marketHours.js';

const CLOSES_SHOWN = 11;      // the 10-day chart: ten closes back + the latest
const PENDING_LIMIT = 50;

type SecurityRow = {
  symbol: string;
  name_he: string;
  name_en: string | null;
  market: SecurityView['market'];
  exchange: SecurityView['exchange'];
  currency: SecurityView['currency'];
  has_chart: boolean;
  days: string[] | null;
  closes: number[] | null;
};

// Returns null when the user has no portfolio row yet (POST /me was never called).
export async function getTrade(db: Pool, uid: string): Promise<TradeView | null> {
  const now = await loadNow(db);
  const owned = await loadPortfolio(db, uid, now);
  if (!owned) return null;

  const settings = await db.query<{ chart_settings: unknown }>('SELECT chart_settings FROM users WHERE uid = $1', [uid]);

  // The last 11 known closes of every security, each cut at its own market's last closed day.
  const { rows } = await db.query<SecurityRow>(
    `SELECT s.symbol, s.name_he, s.name_en, s.market, s.exchange, s.currency,
            s.yahoo_symbol IS NOT NULL AS has_chart, px.days, px.closes
     FROM securities s
     LEFT JOIN LATERAL (
       SELECT array_agg(t.day::text ORDER BY t.day) AS days, array_agg(t.close::float8 ORDER BY t.day) AS closes
       FROM (SELECT day, close FROM prices
             WHERE symbol = s.symbol
               AND ($1::date IS NULL OR day <= CASE WHEN s.market = 'TASE' THEN $1::date ELSE $2::date END)
             ORDER BY day DESC LIMIT $3) t
     ) px ON TRUE
     ORDER BY s.market, s.symbol`,   // TASE first, then US
    [now?.closed.tase ?? null, now?.closed.us ?? null, CLOSES_SHOWN],
  );

  const held = new Map(owned.holdings.map((h) => [h.symbol, h]));
  const securities: SecurityView[] = rows.map((r) => {
    const closes = (r.days ?? []).map((day, i) => ({ day, close: r.closes![i] }));
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    const h = held.get(r.symbol);
    const exec = now ? executionFor(r.market, now.at, now.calendar) : null;
    return {
      symbol: r.symbol,
      nameHe: r.name_he,
      nameEn: r.name_en,
      market: r.market,
      exchange: r.exchange,
      currency: r.currency,
      price: last?.close ?? null,
      priceDay: last?.day ?? null,
      dayChangePct: last && prev ? (last.close / prev.close - 1) * 100 : null,
      closes,
      holding: h ? { units: h.units, valueIls: h.valueIls, weightPct: h.weightPct } : null,
      isOpen: now ? isMarketOpen(r.market, now.at, now.calendar) : false,
      execution: exec ? { priceType: exec.priceType, at: worldTime(exec.at) } : null,
      hasChart: r.has_chart,
    };
  });

  return {
    clock: now ? clockView(now.at, now.calendar) : null,
    cash: owned.cash,
    totalValue: owned.totalValue,
    usdIls: await loadUsdIls(db, now),
    securities,
    pendingOrders: await loadAllPending(db, uid),
    chartSettings: withDefaults(settings.rows[0]?.chart_settings),
  };
}

async function loadAllPending(db: Pool, uid: string): Promise<OrderView[]> {
  const { rows } = await db.query<{
    id: string;
    symbol: string;
    side: OrderView['side'];
    amount_ils: number | null;
    units: number | null;
    price_type: OrderView['priceType'];
    executes_at: Date;
    market: OrderView['market'];
  }>(
    `SELECT o.id::text AS id, o.symbol, o.side, o.amount_ils::float8 AS amount_ils, o.units::float8 AS units, o.price_type, o.executes_at, s.market
     FROM orders o JOIN securities s ON s.symbol = o.symbol
     WHERE o.uid = $1 AND o.status = 'pending'
     ORDER BY o.executes_at, o.id
     LIMIT $2`,
    [uid, PENDING_LIMIT],
  );
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    amountIls: r.amount_ils,
    units: r.units,
    priceType: r.price_type,
    market: r.market,
    executesAt: worldTime(r.executes_at),
  }));
}

// Saves only the known, valid keys on top of what is already saved. Returns the full settings,
// or null when the user has no row yet.
export async function saveChartSettings(db: Pool, uid: string, valid: object) {
  const { rows } = await db.query<{ chart_settings: unknown }>(
    `UPDATE users SET chart_settings = chart_settings || $2::jsonb WHERE uid = $1 RETURNING chart_settings`,
    [uid, JSON.stringify(valid)],
  );
  return rows[0] ? withDefaults(rows[0].chart_settings) : null;
}
