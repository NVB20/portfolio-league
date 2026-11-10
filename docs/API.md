# API

The app never talks to Postgres. Every read and write goes through our API (`api/`, Hono).
The app calls it with `apiFetch` ([src/api.ts](../src/api.ts)), which adds the player's Firebase token.

- **Base URL:** `EXPO_PUBLIC_API_URL` (local: `http://localhost:3000`)
- **Auth:** every `/me` route needs `Authorization: Bearer <Firebase ID token>`. The API checks the token itself ([api/src/auth.ts](../api/src/auth.ts)). The user is always the one in the token, never one named in the request.
- **Body limit:** 16 KB. **Errors:** `{ "error": "..." }`, never a stack trace. The order and clock routes add a stable `code` and, where there is one, a Hebrew `reason`.
- **Types:** the JSON shapes live in [api/src/contract.ts](../api/src/contract.ts), shared by the API and the app.

## What saves data

Only these write to the database. Everything else is read-only.

| Who | Writes | Tables / columns | Can a player change it? |
|-----|--------|------------------|-------------------------|
| `POST /me` | creates the user and the portfolio on first login, refreshes email and name after | `users` (uid, email, display_name), `portfolios` (₪1,000,000 cash) | Only their own row, only those fields. Never `roles`, never cash |
| `PATCH /me/theme` | the dark/light choice | `users.theme` | Yes, only that column |
| `PATCH /me/chart-settings` | the full chart's settings | `users.chart_settings` (JSONB, known keys only) | Yes, only that column |
| `POST /me/orders` | a new `pending` order, and what it sets aside: a buy's cash, a sell's units | `orders` (one row). Buy: a `reserve` journal (`journals` + 2 `ledger_entries`) and `portfolios.reserved_cash`. Sell: `positions.reserved_units` | Only by sending an order the rules allow (D-028). Never cash, units, prices or the clock directly. An order can't be changed or cancelled |
| `POST /me/rejections/seen` | the rejection toasts the app showed (D-023) | `orders.notified_at` of the player's own rejected orders | Only that column, only on their own rejected orders |
| `GET /me/dashboard`, `GET /me/trade` (the catch-up before reading, D-025) | the player's value at the latest open or close whose orders have run, when the runner's batch hasn't reached them yet | that player's `portfolios` totals and week columns, and the marks of their `positions` | No. The runner's own update, for this one player (D-031) |
| `POST /admin/clock/advance`, `/start`, `/stop` (admins only) | the clock move; advance and stop first run every open and close they pass (the runner, D-021, D-029) | The run: `market_events`, executed/rejected `orders`, `journals` + `ledger_entries`, `positions`, `portfolios`, `portfolio_snapshots`, `world_clock.events_through`. Then one transaction: `world_clock` (`now_at`, `real_at`, `running`) + one `admin_actions` row | No. Admins only (D-017, D-030) |
| The ticker (inside the API process, every minute) | the heartbeat, and the opens and closes the running clock passes (the runner) | `world_clock.last_tick_at`, and the same run as above. Never moves `now_at` or `running` | No. Nobody calls it (D-030) |
| `npm run seed:world` (script, not an endpoint) | the 40 securities, their daily open/close, the USD/ILS rate, the clock's start | `securities`, `prices`, `usd_ils`, `world_clock` | No. Run by a developer with the database URL |
| SQL by hand | player roles (`admin`) | `users.roles` | No. Never through the API |

Players can never write cash, holdings, prices, the clock, scores or roles (D-001).

## Routes

### `GET /health`
No auth. `{ "ok": true }` when the API is up and can reach Postgres. For the host's health check and uptime monitors.

### `POST /me`
Called by the app right after login. Creates the user (role `user`) and the portfolio the first time.
Returns `{ email, roles, theme }`.

### `GET /me/dashboard`
Everything the dashboard shows, in one request: clock, portfolio value and chart, holdings, the next pending orders, unseen rejections, USD/ILS, standing, leaderboard top 5. 404 before `POST /me`.

Before reading, it brings the player up to the latest open or close whose orders have run, if the runner hasn't reached them yet (`catchUpPlayer`, D-025). While a later open or close is still running its orders, it does nothing: a player filled there already holds that event's prices, and the runner updates them next. It never waits for a lock: if the player's row is busy (the runner's batch, or their own order being sent), this read shows the stored values and the next one catches up. That is its only write; if it fails, the error is logged and the stored values are shown. Every ₪ figure is a value the runner stored (D-019, D-024); nothing is added up on read (D-031).

- `clock` (`LiveClockView`): the world time and both markets (like `/me/trade`), plus what the admin controls: `running` (false = stopped) and `endsAt` (where the clock stops by itself, as world time; null = no end). The app moves the time on by itself while `running` (D-017), so it doesn't need to poll.
- `portfolio` (`PortfolioView`): `totalValue` (the stored equity), `cash`, `availableCash` (cash − cash locked by pending buys), `reservedCash`, `realizedPnl`, `unrealizedPnl`, and the week:
  - `weekReturnPct` and `maxDrawdownPct` from the weekly running totals; both 0 when nothing touched the player this week. null only before the world starts.
  - `vsMedianPct`: my week return minus the median player's after the latest **finished** open or close this week; null before the first one.
  - `series`: my value at Monday 00:00, one point per trading day (the daily rows), and now. `medianSeries`: the median player's value after each finished open or close this week.
- `holdings[]` (`HoldingView`): open positions, biggest first: `units`, `freeUnits` (not locked by pending sells), `valueIls` (the last mark; at cost before the first one), `costBasisIls`, `unrealizedPnlIls`, `weightPct` (of `totalValue`, exact to 4 decimals), `nearCap`, and `dayChangePct` (a display % from the latest known closes).
- `rejections[]` (`RejectionView`, D-023): rejected orders the player hasn't seen yet, newest rejection first, at most 5: `{ id, symbol, side, amountIls, units, code, reason, at }`. `code` is one of `NO_PRICE`, `INSUFFICIENT_CASH`, `OVER_LIMIT`, `INSUFFICIENT_UNITS` (for English text); `reason` is the Hebrew; `at` is the open or close that rejected it.

### `POST /me/rejections/seen`
The app showed the rejection toasts. Body `{ "ids": ["<order id>", ...] }`: exactly the `rejections[].id`s it showed, 1 to 5, as strings. Sets `notified_at` on those of this player's rejected orders that weren't seen yet, and returns `{ marked }` (how many). Only their own rows, only rejected orders; an id that is someone else's, pending or already seen marks nothing, so calling it again is harmless. A rejection that arrives after the read is not touched, whatever its id, and shows on the next read (D-031).

- 400 when `ids` isn't an array of 1 to 5 strings of digits that fit a BIGINT (a JSON number is refused too, like every order id). 404 before `POST /me`.

### `PATCH /me/theme`
Body `{ "theme": "dark" | "light" }`. Other fields are ignored. Returns `{ email, roles, theme }`.

### `GET /me/trade`
Everything the trading screen shows, in one request. Like the dashboard, it first runs the catch-up (D-025) and then only reads stored values (D-031). Returns `TradeView`:

- `clock` (`LiveClockView`, as on the dashboard): world time, whether TASE / US are open, `running`, and `endsAt` (where the price history ends; null = no end). null before the world starts
- `cash`, `availableCash` (cash − cash locked by pending buys: what a new buy can spend), `totalValue` (the stored equity)
- `usdIls`: the latest known rate
- `securities[]`: the 40 securities, each with the latest close **already known in world time** (a display price, as in D-009), the day change, the last 11 closes (the 10-day chart), your holding (`units`, `freeUnits`, `valueIls` at the last mark, `weightPct`: the same numbers as the dashboard's holdings), and `execution`: when an order sent now would run (today's close if its market is open, otherwise the next open), with `gameOver: true` when that moment is after `endsAt`: the open never comes, and `POST /me/orders` would refuse the order with `GAME_OVER` (D-022, D-028)
- `pendingOrders[]`: all your pending orders, in the order they will run
- `chartSettings`: your saved chart settings on top of the defaults

### `GET /me/chart/:symbol?tf=D|W`
Real daily OHLC + volume for the full chart, from Yahoo Finance (D-012).

- `:symbol` is a game ticker (`TEVA`, `BRK-B`). It must match `^[A-Z0-9-]{1,10}$` (400 otherwise).
- `tf=D` (default) sends up to 320 daily bars, and `tf=W` up to 80 weekly bars (Monday-keyed, built by us from the daily bars).
- Bars stop at the **last day already closed in world time**, so players never see the future.
- TASE prices are converted from agorot to shekels.
- 404 for an unknown symbol, 502 if Yahoo fails (the reason is logged on the server, not sent).

Returns `{ symbol, currency, tf, lastDay, bars: [{ time, open, high, low, close, volume }] }`.

### `PATCH /me/chart-settings`
Body: any of `type` (`candles|bars|line|area`), `tf` (`D|W`), `range` (`22|66|126`), `bg` (`app|black|paper`), `colors` (`mint|classic|blue`), and the booleans `volume`, `sma20`, `sma50`, `grid`, `watermark`, `lastLine`.

- Unknown keys and bad values are dropped. If nothing valid is left, the answer is 400.
- Valid keys are merged into what is already saved.
- The app batches quick clicks into one request (600 ms).
- Returns the full settings.

### `POST /me/orders`
Sends an order ([api/src/orders.ts](../api/src/orders.ts), rules in [api/src/game/orderRules.ts](../api/src/game/orderRules.ts), D-028). Nothing executes now: the order waits as `pending` for its market's close (sent while open) or next open (sent while closed), and the runner checks cash, units and the 20% limit again at the execution price (D-020). Orders can't be changed or cancelled.

Body (`SendOrderBody`): `{ symbol, side, amountIls?, units?, clientOrderId? }`

- `symbol`: `^[A-Z0-9-]{1,10}$` (400), and in the game (404 `UNKNOWN_SYMBOL`).
- `side: "buy"` takes `amountIls` (₪, up to 2 decimals) and no `units`. `side: "sell"` takes `units` (up to 8 decimals) and no `amountIls` (D-018).
- Sizes are a decimal string (`"100000.00"`) or a JSON number, read from the request's own text, digit for digit (never through a double). Positive, at most 20 characters, no exponent. Nothing is rounded: `0.1 + 0.2`, `"100.001"`, `100.0000000000000001` or `1e2` is a 400, not a rounded order.
- `clientOrderId` (optional, `^[A-Za-z0-9_-]{1,64}$`): send the same id again after a lost response and you get the same order back.

What it checks, in this order:

| Check | Answer |
|-------|--------|
| The body | 400 `BAD_REQUEST` |
| The player exists (`POST /me` was called) | 404 `NO_USER` |
| The symbol is in the game | 404 `UNKNOWN_SYMBOL` |
| `clientOrderId` already used by this player: the same symbol, side and size | **200** `{ order, replay: true }`: the stored order as it is now (its `status` may have changed). No new row, no second reserve, doesn't count toward the rate limit |
| … the same id with a different order | 409 `CLIENT_ID_CONFLICT` |
| More than 5 orders in the last real minute | 429 `RATE_LIMITED`, with `Retry-After` (seconds until one more is allowed, at least 1) |
| The world has started (a `world_clock` row) | 409 `NO_WORLD` |
| It would run after the world's end (`world_clock.ends_at`), or the clock is at the end | 409 `GAME_OVER` |
| Buy: under ₪100 | 422 `BELOW_MIN` |
| Buy: over the available cash (cash − reserved cash) | 422 `INSUFFICIENT_CASH` |
| Buy: would take the stock over 20% of the stored portfolio value (its holding at the last mark, or at cost if never marked, + this player's pending buys of it + this buy) | 422 `OVER_LIMIT` |
| Sell: no open position | 422 `NO_POSITION` |
| Sell: more units than are free (units − units locked by pending sells) | 422 `INSUFFICIENT_UNITS` |
| Sell: worth under ₪100 at the last mark, and not every free unit | 422 `BELOW_MIN` |

**201** `{ order, replay: false }` (`SendOrderResult`). `order` is an `OrderView` plus `status` (`pending`), `placedAt` (the world time it was sent) and `clientOrderId`. In the same transaction:

- Buy: a `reserve` journal (`cash_free −A`, `cash_locked +A`, `world_at` = the send's world time) and `portfolios.reserved_cash += A`.
- Sell: `positions.reserved_units += U`. No journal: units aren't money until they're sold.

Errors are `{ error, code, reason? }` (`SendOrderError`): `error` in English, a stable `code`, and `reason` in Hebrew for the player (on 409 `NO_WORLD`/`GAME_OVER`, 422 and 429). A refused send writes nothing; only orders the runner rejects are stored (with `reject_code`, D-023).

**When it runs:** the send uses the effective world time (`worldNow`: the running clock, capped at `ends_at`, never before the latest event the runner has started). During an admin jump that has already started the 17:30 close, an order goes to the next open, not into the close. The send holds the player's portfolio `FOR UPDATE` and then the clock row `FOR SHARE`, so one player's sends run one at a time, other players never wait, and a clock move or event start waits for the sends in progress. Those writers lock the clock table in `EXCLUSIVE` mode, which Postgres queues fairly: a send that arrives after one waits behind it, so a stream of sends can't hold an event back (D-021).

### `POST /me/seen`
The app checks in when it opens and every 60 seconds while it is open and visible (D-026). The body is ignored. Returns `{ ok: true }`; 404 before `POST /me`.

- Sets `users.last_seen_at`. Check-ins less than 30 seconds apart write nothing.
- A check-in after more than 30 minutes away (or the first one ever) adds one row to `app_opens`: a new visit.

### Admin routes

Everything under `/admin` needs a valid token **and** `'admin'` in the caller's `users.roles`, read from Postgres on every request (403 otherwise, including before `POST /me`). Removing the role with SQL takes effect on the next request. The `GET` routes are read-only; the `POST /admin/clock/*` routes move the clock.

### `GET /admin/overview`
The admin page's numbers, in one request. Returns `AdminOverview`:

- `clock`: the world clock (like the dashboard's) plus `running` and `endsAt`; null before the world starts
- `players`: `total`, `joinedToday` (signed up today, real Israel date), `withHoldings` (own at least one security)
- `presence` (D-026, real time): `onlineNow` (checked in during the last 2 minutes), `seenToday`, `visitsToday`, `returningToday` (2+ visits today), `visitBuckets` (`two`, `threeToFive`, `sixPlus`), `avgVisits` (null = no visits yet)
- `orders`: pending orders per market (`tase`, `us`), `rejectedThisWeek` (this world week), and the 3 most common `rejectReasons`
- `world`: number of `securities`, and the last day with data: `pricesUntil.tase`, `pricesUntil.us`, `usdIlsUntil`

- `lastRun`: the latest open or close the engine started (`market_events`): market, kind, world time, status, orders executed and rejected, players updated, duration, whether the ledger balanced. null = none yet
- `eventsBehind`: opens and closes already due in world time that aren't `done` (the engine is behind or stuck)
- `recentActions`: the newest 5 rows of `admin_actions` (admin name, action, world time before and after, detail)

### `GET /admin/activity?days=`
Active players, visits and sign-ups per real Israel day, and day-1 / day-7 return (D-027). `days` is 7 to 90, default 30 (400 otherwise). Returns `{ days: [{ date, activePlayers, visits, signups }], retention: { d1, d7 } }`, each rate `{ cohort, returned, pct }` (`pct` null = nobody old enough to measure).

### `GET /admin/players?q=`
Up to 50 players, by rank on the latest scored day of this week, then by portfolio value. Returns `{ players, limit }`; each player has `uid`, `name`, `email`, `isAdmin`, `joinedAt`, `totalValue`, `rank` (null = not scored), `pendingOrders`, `lastSeenAt` (null = never checked in), `visitsToday`.

- `q` (optional) filters by display name or email, case-insensitive. `%` and `_` match themselves.
- `q` longer than 100 characters: 400.
- Values use the same rule as the dashboard (D-009): the latest close already known in world time.

### Admin clock moves: `POST /admin/clock/advance`, `/start`, `/stop`
The admin's clock buttons (D-017, D-030; [api/src/clockActions.ts](../api/src/clockActions.ts)). Admins only, like every `/admin` route. Start and stop take no body; advance takes an optional one (below).

A move that changes the clock writes **one `admin_actions` row in the same transaction as the move** (D-027): `uid`, `action`, `world_from`, `world_to` and, for advance and stop, `detail = { events, ordersExecuted, ordersRejected, playersUpdated }`. If the move fails, there is no row.

- **`advance`**: from the effective world time (`worldNow`), jump to the next close of a market that is open (`kind: "to_close"`), or to the next open when neither is (`kind: "to_open"`), never past `ends_at`. It first runs every open and close up to the target, in order (the runner: orders, then the affected players, D-021). Then, in one transaction, `now_at` = the target and `real_at` = now, so a running clock keeps running from there. Action `clock_to_close` or `clock_to_open`.
  Returns `ClockAdvanceResult`: `{ kind, from, to, events, ordersExecuted, ordersRejected, playersUpdated, clock }`. `from` and `to` are `WorldTime`, and `clock` is the dashboard's `LiveClockView` after the move.
  Optional body (`ClockAdvanceBody`): `{ "from": "<ISO time>" }`, the world time the admin page showed when the admin clicked (`clock.at`). If an open or close has started after that time (the click already went through and its answer was lost, or the ticker ran one meanwhile), the answer is 409 `CLOCK_MOVED` and nothing moves, so a click sent twice moves once. A `from` that isn't an ISO time is a 400. No body, or no `from`: every click jumps.
- **`start`**: a stopped clock starts running from where it stands: `now_at` = the effective world time every screen shows (the later of `now_at` and `events_through`), `running = true`, `real_at` = now. Nothing runs, so it never waits for the runner. Action `clock_start`, with `world_from` = `world_to` = that time. Returns `{ changed: true, clock }`. Already running: `{ changed: false, clock }`, and nothing is written.
- **`stop`**: freezes a running clock at the effective world time of the moment the runner lock was taken. First it runs every open and close up to that time, then in one transaction sets `now_at` = that time and `running = false`. Action `clock_stop`, with `world_from` = `world_to` = that time. Returns `{ changed: true, at, events, ordersExecuted, ordersRejected, playersUpdated, clock }`. Already stopped: `{ changed: false, clock }`, and nothing is written.

Errors are `{ error, code, reason }` (`ClockActionError`: English, a stable code, Hebrew):

| Code | When |
|------|------|
| 409 `NO_WORLD` | No `world_clock` row yet |
| 409 `CLOCK_BUSY` | advance or stop while the runner is running (the ticker, another API instance, or another click). Try again in a moment. Nothing was written |
| 409 `CLOCK_AT_END` | advance with the clock at `ends_at` |
| 409 `CLOCK_MOVED` | advance with `from`, and an open or close has started after that time. Reload and look at the clock first. Nothing was written |

**The ticker** runs inside the API process, not as a route. It ticks once at start-up and then every minute. Each tick writes `world_clock.last_tick_at` (real time, the heartbeat the admin page watches), even when nothing is due or the runner is busy. It then takes the runner lock (busy = skip this tick) and runs every open and close up to the effective now: what a running clock has passed, plus any event a crash left unfinished. It never moves `now_at` or `running`, and never writes `admin_actions`. Ticks never overlap; a failed run is logged and resumed by the next tick, also when the database drops the run's connection (a restart or failover fails the run, never the process, D-029). `TICKER=off` turns it off.

## Outside services we call

| Service | From | What for | Data sent |
|---------|------|----------|-----------|
| Firebase Auth | the app | sign-in, the ID token | email/password or Google sign-in |
| Google public keys | the API | checking the token's signature | nothing about the user |
| Yahoo Finance `v8/finance/chart` | the API (`GET /me/chart`), and the one-off `scraper/` | chart bars; the game's daily prices (once) | only the stock symbol |

**Yahoo and load:** the API calls Yahoo at most once per symbol every 12 hours (an in-memory cache, and requests that arrive together share one call). 40 symbols means at most 40 calls per 12 hours per API instance, however many players open charts. If Yahoo blocks us, the chart shows an error, but trading and scoring keep working: they never use Yahoo.

## Local commands

```bash
cd api
npm run dev          # the API on :3000 (reads api/.env)
npm run migrate:dev  # new migrations
npm run seed:world   # copy the world from the local price DB (docker compose up -d first)
npm test             # tests against portfolio_test (Yahoo is faked)
```
