// Plays a SAMPLE GAME for development (D-038): 40 made-up players trade through the world's first month, so every
// screen and admin page has something real to show. The plan (who, when, what) is api/src/sampleGame.ts.
//
// THE TRADES ARE PLAYED, NOT WRITTEN. Every order goes through the real sendOrder (the send rules, the reserve, the
// rate limit), and every open and close through the real runner: fills, rejections, stop losses, the ledger,
// snapshots, the median, the standings and the weekly boards are the engine's own output. Only the things the app
// reports with its check-in are written directly: sign-up times, visits, page time and views, the confirm popup.
//
//   cd api && npm run seed:sample-game              start the world over and play the sample month
//   cd api && npm run seed:sample-game -- --force   also when real players have orders (they are wiped), and in a
//                                                   database with more than 1,000 players
//   cd api && npm run seed:sample-game -- --clear   remove the sample players and everything they did
//
// What it does:
//   1. Starts the world over, in one transaction under the runner's lock: the 40 sample users go (with all they
//      did), every other player's orders, holdings, stop losses and ledger lines go (the 'start' cash journal stays,
//      so each has a fresh ₪1,000,000), and so do the boards, snapshots and market events. The clock goes back to
//      the world's start (D-013), stopped. Users, roles, visits, usage and the admin log of real players stay.
//   2. Plays GAME_DAYS world days: each player signs up on their join day; before each of their sends the clock is
//      moved to that minute (running every open and close before it), and the order is sent as the player. An order
//      the rules refuse (422) is decided again, at most twice. Each stored order's created_at is moved back to the
//      real day the world day is shown on, so the monitoring page counts it there.
//   3. Runs the month's last open and close, leaves the clock after the last send, running again if it was.
//   4. Writes the real-time side: sign-ups, visits (app_opens), last seen, page time and views, the confirm popup,
//      on the last GAME_DAYS real days ending today (world day k → real day k). A few players are left online.
//      Each player's daily streak (D-039) is counted from those visit days with the real rule (game/streak.ts).
//
// Safe to run again: it starts over every time and plays the same month (the real dates follow today).
// Safety: the same checks as the sample board (D-033): a database on localhost or 127.0.0.1 only, never
// portfolio_test, never with NODE_ENV=production, and (unless --force) never one with more than 1,000 players.
// It also refuses (unless --force) when real players have orders, because step 1 wipes them.

import pg from 'pg';
import { loadCalendar } from '../src/calendar.js';
import { sendOrder } from '../src/orders.js';
import { ledgerMismatches, lockClock, type RunSummary, runUntil, withRunnerLock } from '../src/runner.js';
import { upsertUser } from '../src/users.js';
import { eventsBetween, isTradingDay } from '../src/game/clock.js';
import { lastClosedDay, type Market } from '../src/game/marketHours.js';
import { countDay, NO_STREAK } from '../src/game/streak.js';
import { addDays, ISRAEL, zonedParts, zonedToInstant } from '../src/game/time.js';
import { worldStartAt } from '../src/game/worldStart.js';
import { checkPlayers, checkTarget, MAX_DEV_PLAYERS, mulberry32, SAMPLE_NAMES, SAMPLE_UIDS, sampleEmail, seedOf } from '../src/sampleBoard.js';
import {
  decide,
  GAME_DAYS,
  MARKET_OF,
  parseGameArgs,
  type Persona,
  type PlanDay,
  planPersonas,
  planPlayer,
  type PlayerView,
  realInstant,
  realOfWorld,
  signupMinute,
  usageFor,
  worldInstant,
} from '../src/sampleGame.js';
import { USAGE_PAGES } from '../src/usage.js';
import { clearSamples } from './sample-clear.js';

const USAGE = 'Usage: npm run seed:sample-game [-- --force | -- --clear]';
const BANNER = 'SAMPLE GAME for development (D-038). Made-up players, real engine.';
const SAMPLES = [...SAMPLE_UIDS];
const ONLINE_AT_END = 4;           // players left "online now" (seen in the last 2 minutes, D-026)
const LOCK_TRIES = 240;            // × 250 ms: how long to wait for the API's ticker to let go of the runner lock
const ATTEMPTS = 3;                // a refused send is decided again, at most twice (the last time in the other market)

async function main(): Promise<number> {
  const args = parseGameArgs(process.argv.slice(2));
  if ('error' in args) {
    console.error(`${args.error}\n${USAGE}`);
    return 1;
  }
  const check = checkTarget({ databaseUrl: process.env.DATABASE_URL, nodeEnv: process.env.NODE_ENV });
  if (!check.ok) {
    console.error(`Refusing to run: ${check.reason}`);
    return 1;
  }
  console.log(BANNER);
  console.log(`Database: ${check.target.database} on ${check.target.host}`);

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  pool.on('error', (err) => console.error('idle database connection failed', err.message));
  try {
    if (args.clear) {
      await clearSamples(pool);
      return 0;
    }
    return await play(pool, args.force);
  } finally {
    await pool.end();
  }
}

// ---------- the game ----------

type Item = { at: Date; p: Persona; day: number; market: Market; first: boolean };

async function play(pool: pg.Pool, force: boolean): Promise<number> {
  const clock = (await pool.query<{ running: boolean; ends_at: Date | null }>('SELECT running, ends_at FROM world_clock')).rows[0];
  if (!clock) {
    console.error('Refusing to run: there is no world clock row. Run `npm run seed:world` first.');
    return 1;
  }
  const realNow = (await pool.query<{ now: Date }>('SELECT now()')).rows[0].now;
  const calendar = await loadCalendar(pool);
  const worldStart = worldStartAt(await firstCommonDay(pool));
  const startDate = zonedParts(worldStart, ISRAEL).date;
  const monthEnd = zonedToInstant(addDays(startDate, GAME_DAYS), 0, ISRAEL);
  if (clock.ends_at !== null && clock.ends_at < monthEnd) {
    console.error(`Refusing to run: the price history ends before day ${GAME_DAYS} of the world (${clock.ends_at.toISOString()}).`);
    return 1;
  }
  const firstRealDate = addDays(zonedParts(realNow, ISRAEL).date, -(GAME_DAYS - 1));

  // ----- the checks before wiping anything -----
  const counted = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM (SELECT 1 FROM users WHERE uid <> ALL($1::text[]) LIMIT $2) x',
    [SAMPLES, MAX_DEV_PLAYERS + 1],
  );
  const tooBig = checkPlayers(counted.rows[0].n, force);
  if (tooBig) {
    console.error(`Refusing to run: ${tooBig}`);
    return 1;
  }
  const realOrders = (await pool.query<{ orders: number; players: number }>(
    'SELECT count(*)::int AS orders, count(DISTINCT uid)::int AS players FROM orders WHERE uid <> ALL($1::text[])',
    [SAMPLES],
  )).rows[0];
  if (realOrders.orders > 0 && !force) {
    console.error(
      `Refusing to run: ${realOrders.players} real player(s) have ${realOrders.orders} order(s). The sample game starts the ` +
        'world over, which wipes every order, holding and board (their accounts, roles and visits stay). ' +
        'Run again with -- --force to wipe them.',
    );
    return 1;
  }

  // ----- 1. start the world over -----
  const wiped = await withLock(pool, 'start the world over', (c) => startOver(c, worldStart));
  console.log(`World start: ${worldStart.toISOString()} (${startDate}). Wiped ${wiped.orders} real orders of ${wiped.players} player(s).`);
  console.log(`Playing world days ${startDate} to ${addDays(startDate, GAME_DAYS - 1)}, shown on real days ${firstRealDate} to ${addDays(firstRealDate, GAME_DAYS - 1)}`);

  // ----- 2. play the month -----
  const personas = planPersonas();
  const tradingDay = (k: number) => isTradingDay(addDays(startDate, k), calendar);
  const plans = personas.map((p) => planPlayer(p, tradingDay));
  const prices = await loadPrices(pool, startDate);
  const priceAt = (at: Date) => (symbol: string) => latestClose(prices, symbol, lastClosedDay(MARKET_OF.get(symbol)!, at, calendar));

  const items: Item[] = personas
    .flatMap((p, i) =>
      plans[i].flatMap((d) =>
        d.sends.map((s, j): Item => ({
          // A few seconds past the minute: never at the very instant of an open or close.
          at: worldInstant(startDate, d.day, s.minute, 7 + ((i * 7 + j * 13) % 47)),
          p, day: d.day, market: s.market, first: d.day === p.joinDay,
        })),
      ),
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.p.uid < b.p.uid ? -1 : 1));
  const events = eventsBetween(new Date(worldStart.getTime() - 1), monthEnd, calendar);
  const lastEvent = events.at(-1)!;
  const finalAt = items.length > 0 && items.at(-1)!.at > lastEvent.at ? items.at(-1)!.at : lastEvent.at;

  const run: RunSummary = { events: 0, ordersExecuted: 0, ordersRejected: 0, playersUpdated: 0 };
  let nextEvent = 0;
  // Runs every open and close up to `at` (only when one is due), then puts the stopped clock at `at`.
  const advanceTo = async (at: Date, running = false) => {
    if (nextEvent < events.length && events[nextEvent].at <= at) {
      const s = await withLock(pool, 'run the opens and closes', (c) => runUntil(c, at));
      run.events += s.events;
      run.ordersExecuted += s.ordersExecuted;
      run.ordersRejected += s.ordersRejected;
      run.playersUpdated += s.playersUpdated;
      while (nextEvent < events.length && events[nextEvent].at <= at) nextEvent++;
    }
    await setClock(pool, at, running);
  };

  const created = new Set<string>();
  const sent = new Map<string, number>();       // `${uid}|${day}` → orders stored
  const clientIds = new Map<string, number>();  // uid → orders stored (the client order id's number)
  const refused = new Map<string, number>();    // code → sends refused
  let skipped = 0;
  let lastDay = -1;
  for (const it of items) {
    await advanceTo(it.at);
    if (it.day !== lastDay) {
      lastDay = it.day;
      process.stdout.write(`\r  world ${addDays(startDate, it.day)}: ${created.size} players, ${[...clientIds.values()].reduce((a, b) => a + b, 0)} orders sent`);
    }
    const { uid } = it.p;
    if (!created.has(uid)) {
      const plan = plans[personas.indexOf(it.p)];
      await upsertUser(pool, uid, sampleEmail(uid), SAMPLE_NAMES[SAMPLES.indexOf(uid)]);
      const signup = realInstant(firstRealDate, it.p.joinDay, signupMinute(it.p, plan), 0, realNow);
      await pool.query('UPDATE users SET created_at = $2 WHERE uid = $1', [uid, signup]);
      created.add(uid);
    }

    let stored = false;
    for (let attempt = 0; attempt < ATTEMPTS && !stored; attempt++) {
      const market = attempt === ATTEMPTS - 1 ? (it.market === 'US' ? 'TASE' : 'US') : it.market;
      const rng = mulberry32(seedOf(`${uid}|${it.at.toISOString()}|${attempt}`));
      const d = decide(it.p, rng, await loadView(pool, uid), market, priceAt(it.at), it.first);
      if (!d) continue;
      const n = (clientIds.get(uid) ?? 0) + 1;
      const clientOrderId = `sg-${uid}-${n}`;
      const body = d.side === 'buy'
        ? { symbol: d.symbol, side: 'buy', amountIls: d.amountIls, ...(d.stopPrice ? { stopPrice: d.stopPrice } : {}), clientOrderId }
        : { symbol: d.symbol, side: 'sell', units: d.units, clientOrderId };
      const out = await sendOrder(pool, uid, body);
      if ('order' in out.body) {   // 201 (or 200, a replay of the same client id, which can't happen here)
        clientIds.set(uid, n);
        const key = `${uid}|${it.day}`;
        sent.set(key, (sent.get(key) ?? 0) + 1);
        // Real time: on the real day this world day is shown on. Never within a minute of now, so the
        // 5-a-minute limit (which counts created_at) never sees the orders of the run.
        await pool.query('UPDATE orders SET created_at = $2 WHERE id = $1', [
          out.body.order.id, realOfWorld(startDate, firstRealDate, it.at, realNow),
        ]);
        stored = true;
      } else {
        refused.set(out.body.code, (refused.get(out.body.code) ?? 0) + 1);
        if (out.status !== 422) break;   // not a rule of the order (game over, no user...): deciding again won't help
      }
    }
    if (!stored) skipped++;
  }
  process.stdout.write('\n');

  // ----- 3. the month's last opens and closes; the clock after the last send -----
  await advanceTo(finalAt, clock.running);
  if (nextEvent < events.length) throw new Error(`${events.length - nextEvent} events of the month did not run`);

  // ----- 4. the real-time side -----
  const written = await writeRealTime(pool, personas, plans, sent, startDate, firstRealDate, realNow);
  // Postgres's row estimates for the DB health card (D-036): the tables just grew from nothing.
  await pool.query('ANALYZE');

  await report(pool, { run, refused, skipped, written, finalAt, running: clock.running });
  return 0;
}

// ---------- step 1 ----------

// One transaction. Deleting an order cascades to its stop losses and its journals; the ledger's append-only rule
// allows a delete only as a cascade (D-019), so every reserve, buy, sell and release line goes with its order and
// the 'start' journal (no order) stays. Each portfolio is then set back to what that ledger says.
async function startOver(c: pg.PoolClient, worldStart: Date): Promise<{ orders: number; players: number }> {
  await c.query('BEGIN');
  try {
    await lockClock(c);
    const real = (await c.query<{ orders: number; players: number }>(
      'SELECT count(*)::int AS orders, count(DISTINCT uid)::int AS players FROM orders WHERE uid <> ALL($1::text[])',
      [SAMPLES],
    )).rows[0];
    await c.query('DELETE FROM users WHERE uid = ANY($1::text[])', [SAMPLES]);
    await c.query('DELETE FROM orders');
    await c.query('DELETE FROM positions');
    await c.query('DELETE FROM portfolio_snapshots');
    await c.query('DELETE FROM standings');
    await c.query('DELETE FROM weekly_scores');
    await c.query('DELETE FROM market_events');
    await c.query(
      `UPDATE portfolios p SET
         cash = COALESCE((SELECT sum(e.amount) FROM ledger_entries e
                          WHERE e.uid = p.uid AND e.account IN ('cash_free', 'cash_locked')), 0),
         reserved_cash = 0, holdings_value = 0, realized_pnl = 0, unrealized_pnl = 0, marked_at = NULL,
         last_event_at = NULL, week_start = NULL, week_start_value = NULL, peak_value = NULL, max_drawdown_pct = 0`,
    );
    const uids = (await c.query<{ uid: string }>('SELECT uid FROM portfolios')).rows.map((r) => r.uid);
    const bad = await ledgerMismatches(c, uids);
    if (bad.length > 0) throw new Error(`after the reset the ledger doesn't match the portfolios of: ${bad.join(', ')}`);
    await c.query('UPDATE world_clock SET now_at = $1, real_at = now(), running = FALSE, events_through = NULL', [worldStart]);
    await c.query('COMMIT');
    return real;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// The first day every series has data, as `npm run seed:world` works it out (the world starts HISTORY_DAYS later).
async function firstCommonDay(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ first: string | null }>(
    `SELECT GREATEST(
       (SELECT min(p.day) FROM prices p JOIN securities s USING (symbol) WHERE s.market = 'TASE'),
       (SELECT min(p.day) FROM prices p JOIN securities s USING (symbol) WHERE s.market = 'US'),
       (SELECT min(day) FROM usd_ils)
     )::text AS first`,
  );
  if (!rows[0]?.first) throw new Error('No prices loaded: run `npm run seed:world` first');
  return rows[0].first;
}

// ---------- step 2 helpers ----------

// The runner's lock, waiting while someone else holds it (the API's ticker, if the API is running).
async function withLock<T>(pool: pg.Pool, what: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let i = 0; i < LOCK_TRIES; i++) {
    const out = await withRunnerLock(pool, fn);
    if (out !== null) return out;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`could not ${what}: the runner's lock stayed taken for a minute (a long run of the API's ticker?)`);
}

// The clock row, moved the way the admin's moves do it: the fair exclusive lock (D-021), one transaction.
async function setClock(pool: pg.Pool, at: Date, running: boolean): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await lockClock(c);
    await c.query('UPDATE world_clock SET now_at = $1, real_at = now(), running = $2', [at, running]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

// What the player's screens show right now: cash, value, holdings and pending buys.
async function loadView(pool: pg.Pool, uid: string): Promise<PlayerView> {
  const p = (await pool.query<{ cash: number; equity: number }>(
    'SELECT available_cash::float8 AS cash, equity::float8 AS equity FROM portfolios WHERE uid = $1',
    [uid],
  )).rows[0];
  const held = await pool.query<{ symbol: string; market: Market; units: string; free: string; value: number; cost: number }>(
    `SELECT p.symbol, s.market, p.units::text AS units, (p.units - p.reserved_units)::text AS free,
            COALESCE(p.market_value_ils, p.cost_basis_ils)::float8 AS value, p.cost_basis_ils::float8 AS cost
     FROM positions p JOIN securities s ON s.symbol = p.symbol
     WHERE p.uid = $1 AND p.status = 'open'`,
    [uid],
  );
  const pending = await pool.query<{ symbol: string; amount: number }>(
    `SELECT symbol, sum(amount_ils)::float8 AS amount FROM orders
     WHERE uid = $1 AND status = 'pending' AND side = 'buy' GROUP BY symbol`,
    [uid],
  );
  return {
    availableCash: p.cash,
    equity: p.equity,
    holdings: held.rows.map((h) => ({ symbol: h.symbol, market: h.market, units: h.units, freeUnits: h.free, value: h.value, cost: h.cost })),
    pendingBuys: new Map(pending.rows.map((r) => [r.symbol, r.amount])),
  };
}

type PriceRow = { day: string; close: number };

// Every close of the month and the weeks before it, in memory: the trade screen's "latest close" for the stop.
async function loadPrices(pool: pg.Pool, startDate: string): Promise<Map<string, PriceRow[]>> {
  const { rows } = await pool.query<PriceRow & { symbol: string }>(
    `SELECT symbol, day::text AS day, close::float8 AS close FROM prices
     WHERE day BETWEEN $1::date AND $2::date ORDER BY symbol, day`,
    [addDays(startDate, -30), addDays(startDate, GAME_DAYS + 1)],
  );
  const out = new Map<string, PriceRow[]>();
  for (const r of rows) {
    const list = out.get(r.symbol) ?? [];
    list.push({ day: r.day, close: r.close });
    out.set(r.symbol, list);
  }
  return out;
}

// The latest close on or before `day` (trade.ts's latestClose, from memory).
function latestClose(prices: Map<string, PriceRow[]>, symbol: string, day: string): number | null {
  const list = prices.get(symbol) ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].day <= day) return list[i].close;
  return null;
}

// ---------- step 4 ----------

type Written = { visits: number; pageRows: number; confirmRows: number; stopSells: number; streaks: number };

async function writeRealTime(
  pool: pg.Pool,
  personas: Persona[],
  plans: PlanDay[][],
  sent: Map<string, number>,
  startDate: string,
  firstRealDate: string,
  realNow: Date,
): Promise<Written> {
  const real = (day: number, minute: number, second: number) => realInstant(firstRealDate, day, minute, second, realNow);
  const opens = { uid: [] as string[], at: [] as Date[] };
  const pages = { day: [] as string[], page: [] as string[], uid: [] as string[], views: [] as number[], ms: [] as number[] };
  const confirms = { day: [] as string[], uid: [] as string[], opened: [] as number[], backed: [] as number[] };
  const seen = { uid: [] as string[], at: [] as Date[] };
  const streaks = { uid: [] as string[], days: [] as number[], best: [] as number[], last: [] as string[], week: [] as string[], weekDays: [] as number[] };
  const lastDay = GAME_DAYS - 1;
  const onlineNow: string[] = [];

  personas.forEach((p, i) => {
    let lastSeen: Date | null = null;
    let streak = NO_STREAK;   // D-039: each real day with a visit counts, as the check-in would have counted it
    for (const d of plans[i]) {
      if (d.sessions.length === 0) continue;
      const rng = mulberry32(seedOf(`${p.uid}|${d.day}|visits`));
      for (const m of d.sessions) {
        opens.uid.push(p.uid);
        opens.at.push(real(d.day, m, Math.floor(rng() * 60)));
      }
      const end = real(d.day, Math.min(1439, d.sessions.at(-1)! + 3 + Math.floor(rng() * 12)), 0);
      if (!lastSeen || end > lastSeen) lastSeen = end;

      const date = addDays(firstRealDate, d.day);
      streak = countDay(streak, date) ?? streak;
      const u = usageFor(p, d.day, d.sessions.length, sent.get(`${p.uid}|${d.day}`) ?? 0);
      for (const page of USAGE_PAGES) {
        const x = u.pages[page];
        if (x.views === 0 && x.ms === 0) continue;
        pages.day.push(date);
        pages.page.push(page);
        pages.uid.push(p.uid);
        pages.views.push(x.views);
        pages.ms.push(x.ms);
      }
      if (u.confirms.opened > 0 || u.confirms.backed > 0) {
        confirms.day.push(date);
        confirms.uid.push(p.uid);
        confirms.opened.push(u.confirms.opened);
        confirms.backed.push(u.confirms.backed);
      }
      if (d.day === lastDay && onlineNow.length < ONLINE_AT_END) onlineNow.push(p.uid);
    }
    if (lastSeen) {
      seen.uid.push(p.uid);
      seen.at.push(lastSeen);
    }
    if (streak.lastDay !== null && streak.weekStart !== null) {
      streaks.uid.push(p.uid);
      streaks.days.push(streak.days);
      streaks.best.push(streak.best);
      streaks.last.push(streak.lastDay);
      streaks.week.push(streak.weekStart);
      streaks.weekDays.push(streak.weekDays);
    }
  });

  // The sells the stops made (D-037) were stored by the runner at real now: back to their real day too.
  const stopSells = await pool.query<{ id: string; placed_at: Date }>(
    `SELECT id::text AS id, placed_at FROM orders WHERE origin = 'stop' AND uid = ANY($1::text[])`,
    [SAMPLES],
  );
  const stops = await pool.query<{ id: string; activated_at: Date }>(
    'SELECT id::text AS id, activated_at FROM stop_orders WHERE uid = ANY($1::text[])',
    [SAMPLES],
  );
  const toReal = (at: Date) => realOfWorld(startDate, firstRealDate, at, realNow);

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('INSERT INTO app_opens (uid, at) SELECT * FROM unnest($1::text[], $2::timestamptz[])', [opens.uid, opens.at]);
    await c.query(
      `INSERT INTO usage_pages_daily (day, page, uid, views, ms)
       SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::int[], $5::bigint[])`,
      [pages.day, pages.page, pages.uid, pages.views, pages.ms],
    );
    await c.query(
      `INSERT INTO usage_confirms_daily (day, uid, opened, backed)
       SELECT * FROM unnest($1::date[], $2::text[], $3::int[], $4::int[])`,
      [confirms.day, confirms.uid, confirms.opened, confirms.backed],
    );
    await c.query(
      `UPDATE users u SET last_seen_at = t.at FROM unnest($1::text[], $2::timestamptz[]) AS t (uid, at) WHERE u.uid = t.uid`,
      [seen.uid, seen.at],
    );
    await c.query(
      `UPDATE users u SET streak_days = t.days, streak_best = t.best, streak_last_day = t.last, streak_week = t.week,
                          streak_week_days = t.week_days
       FROM unnest($1::text[], $2::int[], $3::int[], $4::date[], $5::date[], $6::smallint[]) AS t (uid, days, best, last, week, week_days)
       WHERE u.uid = t.uid`,
      [streaks.uid, streaks.days, streaks.best, streaks.last, streaks.week, streaks.weekDays],
    );
    // Online now: seen in the last 2 minutes (D-026), for a few of today's players. It fades within 2 minutes.
    await c.query(
      `UPDATE users u SET last_seen_at = now() - make_interval(secs => t.secs)
       FROM unnest($1::text[], $2::int[]) AS t (uid, secs) WHERE u.uid = t.uid`,
      [onlineNow, onlineNow.map((_, i) => 10 + 20 * i)],
    );
    await c.query(
      `UPDATE orders o SET created_at = t.at FROM unnest($1::bigint[], $2::timestamptz[]) AS t (id, at) WHERE o.id = t.id`,
      [stopSells.rows.map((r) => r.id), stopSells.rows.map((r) => toReal(r.placed_at))],
    );
    await c.query(
      `UPDATE stop_orders s SET created_at = t.at FROM unnest($1::bigint[], $2::timestamptz[]) AS t (id, at) WHERE s.id = t.id`,
      [stops.rows.map((r) => r.id), stops.rows.map((r) => toReal(r.activated_at))],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
  return {
    visits: opens.uid.length, pageRows: pages.uid.length, confirmRows: confirms.uid.length, stopSells: stopSells.rows.length,
    streaks: streaks.uid.length,
  };
}

// ---------- what it did ----------

async function report(
  pool: pg.Pool,
  r: { run: RunSummary; refused: Map<string, number>; skipped: number; written: Written; finalAt: Date; running: boolean },
): Promise<void> {
  const o = (await pool.query<{ sent: number; executed: number; rejected: number; pending: number; with_stop: number; stop_sells: number }>(
    `SELECT count(*) FILTER (WHERE origin = 'player')::int AS sent,
            count(*) FILTER (WHERE origin = 'player' AND status = 'executed')::int AS executed,
            count(*) FILTER (WHERE origin = 'player' AND status = 'rejected')::int AS rejected,
            count(*) FILTER (WHERE origin = 'player' AND status = 'pending')::int AS pending,
            count(*) FILTER (WHERE origin = 'player' AND stop_price IS NOT NULL)::int AS with_stop,
            count(*) FILTER (WHERE origin = 'stop')::int AS stop_sells
     FROM orders WHERE uid = ANY($1::text[])`,
    [SAMPLES],
  )).rows[0];
  const per = (await pool.query<{ min: number; avg: string; max: number }>(
    `SELECT min(n)::int AS min, round(avg(n), 1)::text AS avg, max(n)::int AS max
     FROM (SELECT count(*) AS n FROM orders WHERE origin = 'player' AND uid = ANY($1::text[]) GROUP BY uid) x`,
    [SAMPLES],
  )).rows[0];
  const rejects = await pool.query<{ code: string; n: number }>(
    `SELECT reject_code AS code, count(*)::int AS n FROM orders
     WHERE status = 'rejected' AND uid = ANY($1::text[]) GROUP BY 1 ORDER BY 2 DESC`,
    [SAMPLES],
  );
  const ledger = (await pool.query<{ events: number; unbalanced: number }>(
    `SELECT count(*)::int AS events, count(*) FILTER (WHERE ledger_balanced IS NOT TRUE)::int AS unbalanced FROM market_events`,
  )).rows[0];
  const board = await pool.query<{ day: string; rank: number; name: string; ret: string; score: string; n: number }>(
    `SELECT s.day::text AS day, s.rank, COALESCE(u.display_name, 'שחקן') AS name, s.return_pct::text AS ret, s.score::text AS score,
            (SELECT max(rank) FROM standings WHERE day = s.day)::int AS n
     FROM standings s JOIN users u ON u.uid = s.uid
     WHERE s.day = (SELECT max(day) FROM standings) ORDER BY s.rank LIMIT 3`,
  );
  const weeks = await pool.query<{ week: string; n: number }>(
    'SELECT week_start::text AS week, count(*)::int AS n FROM weekly_scores GROUP BY 1 ORDER BY 1',
  );

  console.log(`Events run: ${r.run.events} (${ledger.unbalanced === 0 ? 'ledger balanced at every one' : `${ledger.unbalanced} NOT balanced`})`);
  console.log(`Orders sent by the players: ${o.sent} (per player ${per.min} to ${per.max}, ${per.avg} on average)`);
  console.log(`  executed ${o.executed}, rejected at the open or close ${o.rejected}, still pending ${o.pending}`);
  if (rejects.rows.length > 0) console.log(`  rejections: ${rejects.rows.map((x) => `${x.code} ${x.n}`).join(', ')}`);
  console.log(`  with a stop loss ${o.with_stop}; stops fired ${o.stop_sells}`);
  const refusedText = [...r.refused].map(([code, n]) => `${code} ${n}`).join(', ');
  console.log(`Sends refused by the rules (not stored, decided again): ${refusedText || 'none'}; sends given up: ${r.skipped}`);
  for (const w of weeks.rows) console.log(`Final board, week of ${w.week}: ${w.n} players`);
  if (board.rows[0]) {
    console.log(`Live board ${board.rows[0].day} (${board.rows[0].n} players):`);
    for (const b of board.rows) console.log(`  #${b.rank} ${b.name}: ${b.ret}%, score ${b.score}`);
  }
  console.log(`Real time: ${r.written.visits} visits, ${r.written.pageRows} page rows, ${r.written.confirmRows} confirm-popup rows; ${r.written.stopSells} stop sales moved to their real day; ${r.written.streaks} daily streaks`);
  console.log(`Clock: ${r.finalAt.toISOString()}, ${r.running ? 'running again' : 'stopped'}`);
  console.log('SAMPLE DATA. Remove the players with: npm run seed:sample-game -- --clear');
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
