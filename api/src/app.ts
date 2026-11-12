// The HTTP routes. Everything the API needs from outside (database, token check, allowed origins)
// is passed in, so tests can build the same app with a test database and test keys.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import type { Pool } from 'pg';
import { requireAuth, type AppEnv, type VerifyToken } from './auth.js';
import { setTheme, upsertUser } from './users.js';
import { getDashboard, markRejectionsSeen, parseSeenIds } from './dashboard.js';
import { getLeaderboard } from './leaderboard.js';
import { getTrade, saveChartSettings } from './trade.js';
import { getTradeJournal, parseJournalQuery } from './tradeJournal.js';
import { cachedDaily, fetchYahooDaily, getChart, type FetchDaily } from './chart.js';
import { pickChartSettings } from './chartSettings.js';
import { ACTIVITY_DAYS, getAdminActivity, getAdminOverview, getAdminPlayers, requireAdmin } from './admin.js';
import { recordSeen } from './presence.js';
import { hasUsage, parseUsageText, recordUsage } from './usage.js';
import { getAdminMonitoring, getDbHealth, oneAtATime } from './monitoring.js';
import { sendOrder } from './orders.js';
import { parseOrderJson } from './game/orderRules.js';
import { advanceClock, parseAdvanceBody, startClock, stopClock } from './clockActions.js';

export type Deps = {
  db: Pool;
  verifyToken: VerifyToken;
  corsOrigins: string[];   // web origins allowed to call the API, e.g. the Firebase Hosting domains
  fetchDaily?: FetchDaily; // where chart bars come from; default = Yahoo behind a 12-hour cache. Tests pass a fake.
};

// A game ticker: letters, digits, '-' (BRK-B). Checked before it reaches SQL or a Yahoo URL.
const SYMBOL = /^[A-Z0-9-]{1,10}$/;
// The admin player search: long enough for any email, short enough to keep the query cheap.
const MAX_SEARCH = 100;
// The leaderboard's first place: 1 to 999,999,999, digits only (so the page's last place still fits an INTEGER).
const LEADERBOARD_FROM = /^[1-9][0-9]{0,8}$/;

export function createApp({ db, verifyToken, corsOrigins, fetchDaily = cachedDaily(fetchYahooDaily) }: Deps) {
  const app = new Hono<AppEnv>();

  // The web app and the API are on different domains, so the browser asks permission first (CORS).
  // No cookies are used (the token goes in a header), so credentials stay off.
  app.use(
    '*',
    cors({
      origin: corsOrigins,
      allowMethods: ['GET', 'POST', 'PATCH'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 7200,
    }),
  );

  // Refuse bodies over 16 KB before reading them, so one huge request can't fill the server's memory.
  app.use('*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'body too large' }, 413) }));

  // For the host's health check and uptime monitors: is the API up, and can it reach the database?
  app.get('/health', async (c) => {
    await db.query('SELECT 1');
    return c.json({ ok: true });
  });

  // Everything under /me needs a valid Firebase token.
  const me = new Hono<AppEnv>();
  me.use(requireAuth(verifyToken));

  // Called by the app right after login: creates the user row the first time, and returns it.
  me.post('/', async (c) => {
    const { uid, email, name } = c.get('user');
    return c.json(await upsertUser(db, uid, email, name));
  });

  // The app checks in when it opens and about once a minute while open (D-026). The server alone decides whether
  // this starts a new visit: nothing in the body can claim one. The optional body is a usage report (UsageReport,
  // D-036): time and views per page, and the confirm popup, since the last check-in. It is checked and capped
  // before anything is written, so a bad body is a 400 that writes nothing, not even the check-in. No body = a
  // plain check-in, as older app versions send. The report is written even when the check-in itself writes
  // nothing (under 30 s apart), in its own statement after the presence transaction.
  me.post('/seen', async (c) => {
    const uid = c.get('user').uid;
    const usage = parseUsageText(await c.req.text().catch(() => ''));
    if (!usage.ok) return c.json({ error: usage.error }, 400);
    const seen = await recordSeen(db, uid);
    if (!seen) return c.json({ error: 'user not found, call POST /me first' }, 404);
    if (hasUsage(usage.report)) await recordUsage(db, uid, usage.report);
    return c.json({ ok: true });
  });

  // Everything the dashboard shows, in one request. Empty world = empty fields, never made-up numbers.
  me.get('/dashboard', async (c) => {
    const dashboard = await getDashboard(db, c.get('user').uid);
    if (!dashboard) return c.json({ error: 'user not found, call POST /me first' }, 404);
    return c.json(dashboard);
  });

  // The weekly table (D-032). ?view=top (default) with ?from= (a place, default 1): 20 rows from there.
  // ?view=around: my place ± 5. Read-only: no catch-up, the scoring writes the places.
  me.get('/leaderboard', async (c) => {
    const view = c.req.query('view') ?? 'top';
    const from = c.req.query('from') ?? '1';
    if (view !== 'top' && view !== 'around') return c.json({ error: 'view must be "top" or "around"' }, 400);
    if (!LEADERBOARD_FROM.test(from)) return c.json({ error: 'from must be a whole number from 1 to 999999999' }, 400);
    const board = await getLeaderboard(db, c.get('user').uid, { view, from: Number(from) });
    if (!board) return c.json({ error: 'user not found, call POST /me first' }, 404);
    return c.json(board);
  });

  // Body: { "theme": "dark" | "light" }. Any other field (like roles) is ignored.
  me.patch('/theme', async (c) => {
    const body = await c.req.json().catch(() => null);
    const theme = body?.theme;
    if (theme !== 'dark' && theme !== 'light') {
      return c.json({ error: 'theme must be "dark" or "light"' }, 400);
    }
    const updated = await setTheme(db, c.get('user').uid, theme);
    if (!updated) return c.json({ error: 'user not found, call POST /me first' }, 404);
    return c.json(updated);
  });

  // Everything the trading screen shows, in one request. Its only write is the D-025 catch-up before reading.
  me.get('/trade', async (c) => {
    const trade = await getTrade(db, c.get('user').uid);
    if (!trade) return c.json({ error: 'user not found, call POST /me first' }, 404);
    return c.json(trade);
  });

  // The trade journal (D-035): every order I sent, newest first, and the period's wins, losses and realized gain.
  // ?filter=all|pending|executed|rejected, ?period=week|all, ?before=<order id> (next page), ?limit=1..100.
  me.get('/journal', async (c) => {
    const q = parseJournalQuery({
      filter: c.req.query('filter'),
      period: c.req.query('period'),
      before: c.req.query('before'),
      limit: c.req.query('limit'),
    });
    if (!q.ok) return c.json({ error: q.error }, 400);
    const journal = await getTradeJournal(db, c.get('user').uid, q.query);
    if (!journal) return c.json({ error: 'user not found, call POST /me first' }, 404);
    return c.json(journal);
  });

  // Real OHLC + volume for the full chart, cut at the world clock. ?tf=D (default) or W.
  me.get('/chart/:symbol', async (c) => {
    const symbol = c.req.param('symbol');
    const tf = c.req.query('tf') ?? 'D';
    if (!SYMBOL.test(symbol)) return c.json({ error: 'bad symbol' }, 400);
    if (tf !== 'D' && tf !== 'W') return c.json({ error: 'tf must be "D" or "W"' }, 400);
    try {
      const chart = await getChart(db, fetchDaily, symbol, tf);
      if (!chart) return c.json({ error: 'no chart for this symbol' }, 404);
      return c.json(chart);
    } catch (err) {
      console.error('Chart source failed', err);
      return c.json({ error: 'chart source unavailable' }, 502);
    }
  });

  // Body: any of the ChartSettings keys. Unknown keys and bad values are ignored; nothing valid = 400.
  me.patch('/chart-settings', async (c) => {
    const valid = pickChartSettings(await c.req.json().catch(() => null));
    if (!valid) return c.json({ error: 'no valid chart setting in the body' }, 400);
    const saved = await saveChartSettings(db, c.get('user').uid, valid);
    if (!saved) return c.json({ error: 'user not found, call POST /me first' }, 404);
    return c.json(saved);
  });

  // Sends an order (D-018, D-028). Body: { symbol, side, amountIls (buy) | units (sell), clientOrderId? }.
  // 201 = a new pending order; 200 = the same clientOrderId again (a replay: nothing new is written).
  // Errors carry a stable `code` and, for the player, a Hebrew `reason`. Orders can't be changed or cancelled.
  // The body is read from its text, so a size sent as a JSON number keeps its exact digits (parseOrderJson).
  me.post('/orders', async (c) => {
    const body = parseOrderJson(await c.req.text().catch(() => ''));
    const out = await sendOrder(db, c.get('user').uid, body);
    if ('retryAfter' in out && out.retryAfter !== undefined) c.header('Retry-After', String(out.retryAfter));
    return c.json(out.body, out.status);
  });

  // The app showed the rejection toasts (D-023). Body: { "ids": ["<order id>", ...] }, exactly the ones it
  // showed (1 to 5). Marks only those of this player's rejected orders. Returns { marked }.
  me.post('/rejections/seen', async (c) => {
    const ids = parseSeenIds(await c.req.json().catch(() => null));
    if (ids === null) return c.json({ error: 'ids must be 1 to 5 order ids, each a string of digits' }, 400);
    const marked = await markRejectionsSeen(db, c.get('user').uid, ids);
    if (marked === null) return c.json({ error: 'user not found, call POST /me first' }, 404);
    return c.json({ marked });
  });

  app.route('/me', me);

  // Everything under /admin needs a valid token AND the admin role in Postgres (403 otherwise).
  // Read-only, except the clock moves (POST /admin/clock/*).
  const admin = new Hono<AppEnv>();
  admin.use(requireAuth(verifyToken), requireAdmin(db));

  // The admin page's numbers: clock, player counts, order queue, the state of the world's data.
  admin.get('/overview', async (c) => c.json(await getAdminOverview(db)));

  // Up to 5 players by this week's rank. ?q= filters by display name or email.
  admin.get('/players', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length > MAX_SEARCH) return c.json({ error: `q must be at most ${MAX_SEARCH} characters` }, 400);
    return c.json(await getAdminPlayers(db, q === '' ? null : q));
  });

  // Active players, visits and sign-ups per day, and next-day / 7-day return. ?days= 7 to 90 (default 30).
  admin.get('/activity', async (c) => {
    const raw = c.req.query('days');
    const days = raw === undefined ? ACTIVITY_DAYS.default : Number(raw);
    if (!Number.isInteger(days) || days < ACTIVITY_DAYS.min || days > ACTIVITY_DAYS.max) {
      return c.json({ error: `days must be a whole number from ${ACTIVITY_DAYS.min} to ${ACTIVITY_DAYS.max}` }, 400);
    }
    return c.json(await getAdminActivity(db, days));
  });

  // The monitoring page (D-036): orders sent and the confirm popup, time and views per page for today, 7 and
  // 30 days, and the usage chart's 30 days and 12 weeks. Usage is real time, from POST /me/seen's reports.
  // One run at a time per API process: a request that arrives during a run shares its answer.
  const monitoring = oneAtATime(() => getAdminMonitoring(db));
  admin.get('/monitoring', async (c) => c.json(await monitoring()));

  // The database's health, read live (D-036). Its own route, so the page can refresh it every 30 s without
  // running the usage queries again. If Postgres is down, the admin check above already fails.
  admin.get('/db', async (c) => c.json(await getDbHealth(db)));

  // The clock moves (D-017, D-030). Each runs the opens and closes it passes, then moves the clock and logs the
  // action in one transaction. 409 NO_WORLD | CLOCK_BUSY (the runner is busy; try again) | CLOCK_AT_END and
  // CLOCK_MOVED (advance only). Advance takes an optional body { from }: the world time the page showed, so a
  // click sent again after a lost answer doesn't jump twice. Start and stop take no body.
  admin.post('/clock/advance', async (c) => {
    const body = parseAdvanceBody(await c.req.json().catch(() => null));
    if (!body.ok) return c.json({ error: body.error }, 400);
    const out = await advanceClock(db, c.get('user').uid, { seen: body.seen });
    return c.json(out.body, out.status);
  });
  admin.post('/clock/start', async (c) => {
    const out = await startClock(db, c.get('user').uid);
    return c.json(out.body, out.status);
  });
  admin.post('/clock/stop', async (c) => {
    const out = await stopClock(db, c.get('user').uid);
    return c.json(out.body, out.status);
  });

  app.route('/admin', admin);

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  // Log the real error on the server; never send its details to the browser.
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
