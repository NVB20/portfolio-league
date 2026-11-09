// The market calendar (D-016) from `market_closures`, cached in memory.
// The table only changes when `npm run seed:world` runs, and every request needs it, so it's read at most
// once every few minutes per database pool instead of on every request.

import type { Pool } from 'pg';
import { type Calendar, makeCalendar, type Market } from './game/marketHours.js';

const TTL_MS = 5 * 60_000;
const cache = new WeakMap<Pool, { calendar: Calendar; loadedAt: number }>();

export async function loadCalendar(db: Pool): Promise<Calendar> {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit.calendar;
  const { rows } = await db.query<{ market: Market; day: string; reason_he: string }>(
    'SELECT market, day::text AS day, reason_he FROM market_closures',
  );
  const calendar = makeCalendar(rows.map((r) => ({ market: r.market, day: r.day, reason: r.reason_he })));
  cache.set(db, { calendar, loadedAt: Date.now() });
  return calendar;
}

// For tests that change `market_closures` between requests.
export function forgetCalendar(db: Pool): void {
  cache.delete(db);
}
