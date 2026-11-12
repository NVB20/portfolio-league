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
| `POST /me/orders` | a new `pending` order, and what it sets aside: a buy's cash, a sell's units. A buy may carry a stop loss (`orders.stop_price`, D-037) | `orders` (one row). Buy: a `reserve` journal (`journals` + 2 `ledger_entries`) and `portfolios.reserved_cash`. Sell: `positions.reserved_units` | Only by sending an order the rules allow (D-028). Never cash, units, prices or the clock directly. An order can't be changed or cancelled; its stop loss can be moved once the buy fills (below). A stop's sell is made by the runner, never by a request |
| `PATCH /me/stops/:id` | moves one of the player's active stop losses (D-041) | `stop_orders.stop_price` and `moved_at` of that stop, and one `stop_moves` row | Only the price of their own active stop, below the latest close, at most 5 times a minute. Never its units, never while its market's open or close waits for the runner, and never money |
| `POST /me/seen` | the check-in (D-026) and its optional usage report (D-036) | `users.last_seen_at`, one `app_opens` row when a visit starts; today's `usage_pages_daily` and `usage_confirms_daily` rows (added to) | Only their own rows. The server decides what is a visit; a usage report is capped per request (120 s of time, 50 per count) |
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
- `holdings[]` (`HoldingView`): open positions, biggest first: `units`, `freeUnits` (not locked by pending sells), `valueIls` (the last mark; at cost before the first one), `costBasisIls`, `unrealizedPnlIls`, `weightPct` (of `totalValue`, exact to 4 decimals), `nearCap`, `dayChangePct` (a display % from the latest known closes), `stops` (`StopView[]`, D-037): the position's active stop losses, highest first, `{ id, price, originalPrice, units }` (prices in the security's currency; `price` is the stop now, `originalPrice` the one its buy was sent with, D-041), and `lastClose` (the latest close of its market's last closed day, the price the trade screen shows: a moved stop must be below it; null = none known).
- `rejections[]` (`RejectionView`, D-023): rejected orders the player hasn't seen yet, newest rejection first, at most 5: `{ id, symbol, side, amountIls, units, code, reason, at }`. `code` is one of `NO_PRICE`, `INSUFFICIENT_CASH`, `OVER_LIMIT`, `INSUFFICIENT_UNITS` (for English text); `reason` is the Hebrew; `at` is the open or close that rejected it.
- `stopSales[]` (`StopSaleView`, D-037): sales a stop loss made that the player hasn't seen yet, newest first, at most 5: `{ id, symbol, currency, stopPrice, fillPrice, units, ils, realizedPnlIls, at }`. `id` is the sell order's id; `fillPrice` is the open or close it sold at (at or below `stopPrice`: a gap sells lower); `at` is that open or close.
- `pendingOrders.next[]` (`OrderView`) carry `stopPrice`: a buy's stop loss, or null.
- `leaderboard` (D-032): `{ players, week, top }`, the same board as `GET /me/leaderboard`. The board is the latest scored day (`standings.day`) up to the world's today, with no lower bound, so on the weekend and on Monday before the week's first open it is still the week that just closed.
  - `week` (`BoardWeek`): `{ start, day, final }`. `start` is the week's Monday, `day` the scored day shown. `final` is true when that week is before the current world week or its final board is in `weekly_scores`. null = nothing scored up to today (then `players` is 0 and `top` is empty).
  - `players`: the last place on that day, `max(rank)`. Places are unique, 1..N (no shared places), so this is one index lookup, not a count.
  - `top`: places 1..5, `{ rank, name, returnPct, score, isMe }`. `name` is the display name, or "שחקן" when there is none; never the email.
- `standing` (`StandingView`): my place on that board: `rank`, `players`, `score`, `returnRank`, `stabilityRank`, `rankChange` (places gained since the previous scored day of the same week; null on the week's first scored day, or when I wasn't on it), `days` (my daily scores, Monday up to the board's day) and `maxDrawdownPct` (the board row's drawdown: the board's week, so on Monday before the open it is last week's, while `portfolio.maxDrawdownPct` is already this week's 0). null = I'm not on the board shown (not ranked this week, or nothing scored yet).

### `POST /me/rejections/seen`
The app showed the rejection toasts or the stop-sale toasts (D-037). Body `{ "ids": ["<order id>", ...] }`: exactly the `rejections[].id`s or `stopSales[].id`s it showed, 1 to 5, as strings. Sets `notified_at` on those of this player's rejected orders and executed stop sales that weren't seen yet, and returns `{ marked }` (how many). Only their own rows, only rejected orders or a stop's executed sells; an id that is someone else's, pending, a plain fill or already seen marks nothing, so calling it again is harmless. A rejection that arrives after the read is not touched, whatever its id, and shows on the next read (D-031).

- 400 when `ids` isn't an array of 1 to 5 strings of digits that fit a BIGINT (a JSON number is refused too, like every order id). 404 before `POST /me`.

### `PATCH /me/theme`
Body `{ "theme": "dark" | "light" }`. Other fields are ignored. Returns `{ email, roles, theme }`.

### `GET /me/trade`
Everything the trading screen shows, in one request. Like the dashboard, it first runs the catch-up (D-025) and then only reads stored values (D-031). Returns `TradeView`:

- `clock` (`LiveClockView`, as on the dashboard): world time, whether TASE / US are open, `running`, and `endsAt` (where the price history ends; null = no end). null before the world starts
- `cash`, `availableCash` (cash − cash locked by pending buys: what a new buy can spend), `totalValue` (the stored equity)
- `usdIls`: the latest known rate
- `securities[]`: the 40 securities, each with the latest close **already known in world time** (a display price, as in D-009), the day change, the last 11 closes (the 10-day chart), your holding (`units`, `freeUnits`, `valueIls` at the last mark, `weightPct`, `stops`: the same numbers as the dashboard's holdings), and `execution`: when an order sent now would run (today's close if its market is open, otherwise the next open), with `gameOver: true` when that moment is after `endsAt`: the open never comes, and `POST /me/orders` would refuse the order with `GAME_OVER` (D-022, D-028)
- `pendingOrders[]`: all your pending orders, in the order they will run, each with `stopPrice` (a buy's stop loss, or null)
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

Body (`SendOrderBody`): `{ symbol, side, amountIls?, units?, stopPrice?, clientOrderId? }`

- `symbol`: `^[A-Z0-9-]{1,10}$` (400), and in the game (404 `UNKNOWN_SYMBOL`).
- `side: "buy"` takes `amountIls` (₪, up to 2 decimals) and no `units`. `side: "sell"` takes `units` (up to 8 decimals) and no `amountIls` (D-018).
- Sizes are a decimal string (`"100000.00"`) or a JSON number, read from the request's own text, digit for digit (never through a double). Positive, at most 20 characters, no exponent. Nothing is rounded: `0.1 + 0.2`, `"100.001"`, `100.0000000000000001` or `1e2` is a 400, not a rounded order.
- `stopPrice` (optional, buys only, D-037): a stop loss, in the security's own currency (₪ for TASE, $ for US), up to 4 decimals, read like a size. On a sell it is a 400. When the buy fills, the stop covers the units it got; at every later open and close of its market, an open or close at or below the stop sells them at that price (a gap sells below the stop). It can't be cancelled; once the buy fills it can be moved (`PATCH /me/stops/:id`, D-041).
- `clientOrderId` (optional, `^[A-Za-z0-9_-]{1,64}$`): send the same id again after a lost response and you get the same order back.

What it checks, in this order:

| Check | Answer |
|-------|--------|
| The body | 400 `BAD_REQUEST` |
| The player exists (`POST /me` was called) | 404 `NO_USER` |
| The symbol is in the game | 404 `UNKNOWN_SYMBOL` |
| `clientOrderId` already used by this player: the same symbol, side, size and stop | **200** `{ order, replay: true }`: the stored order as it is now (its `status` may have changed). No new row, no second reserve, doesn't count toward the rate limit |
| … the same id with a different order | 409 `CLIENT_ID_CONFLICT` |
| More than 5 orders in the last real minute (orders the player sent: a stop's sell doesn't count) | 429 `RATE_LIMITED`, with `Retry-After` (seconds until one more is allowed, at least 1) |
| The world has started (a `world_clock` row) | 409 `NO_WORLD` |
| It would run after the world's end (`world_clock.ends_at`), or the clock is at the end | 409 `GAME_OVER` |
| Buy: under ₪100 | 422 `BELOW_MIN` |
| Buy: over the available cash (cash − reserved cash) | 422 `INSUFFICIENT_CASH` |
| Buy: would take the stock over 20% of the stored portfolio value (its holding at the last mark, or at cost if never marked, + this player's pending buys of it + this buy) | 422 `OVER_LIMIT` |
| Sell: no open position | 422 `NO_POSITION` |
| Sell: more units than are free (units − units locked by pending sells) | 422 `INSUFFICIENT_UNITS` |
| Sell: worth under ₪100 at the last mark, and not every free unit | 422 `BELOW_MIN` |
| Buy with a stop: no close known yet for the stock | 422 `STOP_NO_PRICE` |
| Buy with a stop: the stop is at or above the latest close the trade screen shows (the latest close of the market's last closed day) | 422 `STOP_NOT_BELOW_PRICE` |

**201** `{ order, replay: false }` (`SendOrderResult`). `order` is an `OrderView` plus `status` (`pending`), `placedAt` (the world time it was sent) and `clientOrderId`. In the same transaction:

- Buy: a `reserve` journal (`cash_free −A`, `cash_locked +A`, `world_at` = the send's world time) and `portfolios.reserved_cash += A`.
- Sell: `positions.reserved_units += U`. No journal: units aren't money until they're sold.

Errors are `{ error, code, reason? }` (`SendOrderError`): `error` in English, a stable `code`, and `reason` in Hebrew for the player (on 409 `NO_WORLD`/`GAME_OVER`, 422 and 429). A refused send writes nothing; only orders the runner rejects are stored (with `reject_code`, D-023).

**When it runs:** the send uses the effective world time (`worldNow`: the running clock, capped at `ends_at`, never before the latest event the runner has started). During an admin jump that has already started the 17:30 close, an order goes to the next open, not into the close. The send holds the player's portfolio `FOR UPDATE` and then the clock row `FOR SHARE`, so one player's sends run one at a time, other players never wait, and a clock move or event start waits for the sends in progress. Those writers lock the clock table in `EXCLUSIVE` mode, which Postgres queues fairly: a send that arrives after one waits behind it, so a stream of sends can't hold an event back (D-021).

### `PATCH /me/stops/:id`
Moves one of the player's active stop losses, up or down (D-041, [api/src/stopMoves.ts](../api/src/stopMoves.ts), rules in [api/src/game/stopMove.ts](../api/src/game/stopMove.ts)). Active = its buy filled and its position is still open, fully or partly. The units it sells don't change. The app calls it from the holding cards' and the journal's pencil.

Body (`MoveStopBody`): `{ stopPrice }`: the new price in the security's own currency, up to 4 decimals, read like a new stop's (a decimal string, or a JSON number read digit for digit). Other keys are ignored.

What it checks, in this order:

| Check | Answer |
|-------|--------|
| The id (digits, 1 to the BIGINT maximum) and the body | 400 `BAD_REQUEST` |
| The player exists (`POST /me` was called) | 404 `NO_USER` |
| The stop exists and is the player's (someone else's is "not found" too) | 404 `STOP_NOT_FOUND` |
| The stop is active (not fired, not expired) | 409 `STOP_NOT_ACTIVE` |
| The stop is already at that price | **200** `{ stop, changed: false }`. Nothing is written and it doesn't count toward the limit, so a retry after a lost answer is safe |
| More than 5 moves in the last real minute | 429 `RATE_LIMITED`, with `Retry-After`. Separate from the 5 orders a minute |
| The world has started | 409 `NO_WORLD` |
| Its market's next open or close comes after the world's end (it would never be checked again) | 409 `GAME_OVER` |
| Its market's latest open or close (at or before now) isn't `orders_done` yet: not started, or started with its stops not checked | 409 `STOP_CHECK_RUNNING`, with `Retry-After: 15` |
| No close known for the stock | 422 `STOP_NO_PRICE` |
| The new price is at or above the latest close the trade screen shows (the latest close of its market's last closed day) | 422 `STOP_NOT_BELOW_PRICE` |

**200** `{ stop, changed: true }` (`MoveStopResult`; `stop` is a `StopView`). In the same transaction: `stop_orders.stop_price` = the new price, `moved_at` = the world time, and one `stop_moves` row (`from_price`, `to_price`, `world_at`). Errors are `{ error, code, reason? }` (`MoveStopError`) with the Hebrew `reason` on 404 `STOP_NOT_FOUND`, 409, 422 and 429. A refused move writes nothing.

**Why the check-running refusal:** the screens show a close as soon as the world clock passes it, but the runner checks the stops at it up to a minute later (D-030). A move in between could dodge a stop that close had already reached.

**After a move**, the stop fires on an event's price only: the "bought at or below its own stop, so it fires at the first check" rule (D-037) no longer applies, so a stop raised above the buy price doesn't fire at the next check.

**Locks:** the player's portfolio `FOR UPDATE` (moves run one at a time per player), then the clock row `FOR SHARE` (no open or close can start meanwhile), then, only after the check above, the stop row `FOR UPDATE`. The runner locks stops before portfolios, but only while its event is `pending`, which a move refuses before touching the stop, so the two never wait on each other.

### `POST /me/seen`
The app checks in when it opens and every 60 seconds while it is open and visible (D-026). The body is optional: a usage report (D-036). Returns `{ ok: true }`; 404 before `POST /me`.

- **Presence (D-026):**
  - Sets `users.last_seen_at`. Check-ins less than 30 seconds apart write nothing.
  - Locks the player's `users` row `FOR NO KEY UPDATE`, not `FOR UPDATE`: the runner's scoring holds `FOR KEY SHARE` on every ranked player's row until it commits (the board's foreign keys, D-034), and a check-in must not wait for it.
  - A check-in after more than 30 minutes away (or the first one ever) adds one row to `app_opens`: a new visit. Nothing in the body can start one.
- **Usage (D-036, [api/src/usage.ts](../api/src/usage.ts)):** the optional JSON body (`UsageReport`) is what happened since the app's last check-in: `{ "pages": { "<page>": { "views": 1, "ms": 42000 } }, "confirms": { "opened": 1, "backed": 0 } }`. Both fields are optional. `<page>` is `dashboard`, `trade`, `journal` or `leaderboard`; `confirms` is the trade screen's confirm popup (opened, and closed without sending).
  - The server caps it: `views`, `opened` and `backed` at most 50 each, `ms` at most 120,000 for all pages together (over that, every page shrinks by the same factor). Below 0 counts as 0 and fractions are cut. Unknown pages and unknown top-level fields are dropped.
  - No body, an empty body, `null` or `{}` is a plain check-in, as older app versions send.
  - It is added to today's rows (real Israel date, computed by Postgres) of `usage_pages_daily` and `usage_confirms_daily`, both in one statement (the pages upsert is a `WITH` part of the popup upsert): a report is written whole or not at all, and on one date. A part with nothing to add writes no row. It is written even when the presence part writes nothing, in its own statement after the presence transaction, so the `users` row lock is never held longer.
  - So an error answer (401, 404, 5xx) means no usage was written, and the app sends that report again with its next check-in. After a 400 or its own 10 s timeout it doesn't (D-036).
- 400 `{ error }` when the body isn't JSON or isn't an object, or a known field has the wrong shape: `pages` or a page that isn't an object, a `views`, `ms`, `opened` or `backed` that is missing or isn't a finite number. Nothing is written, not even the check-in.

### `GET /me/leaderboard?view=top|around&from=`
The weekly table (D-032, [api/src/leaderboard.ts](../api/src/leaderboard.ts)). Read-only: the runner's scoring step writes `standings` and `weekly_scores` (D-034), and this route only reads them. It doesn't run the catch-up (D-025). Returns `LeaderboardView`.

- **Which board:** the same as the dashboard's. It is the latest scored day up to the world's today, with no lower bound. On the weekend and on Monday before the week's first open, that is still the week that just closed.
- **Who is on it, and when it changes (D-034):** every player who holds a stock now, or whom an open or close touched this week (a stock held at it, or an order due at it). A cash-only player nothing touched this week isn't on it, so `me` is null for them. The runner rewrites the day at every open and close, and writes the week's final board (`weekly_scores`, so `final` turns true) at the week's last event.
- `view` (optional, default `top`):
  - `top`: 20 places from `from`.
  - `around`: my place ± 5 (fewer at either end). When I'm not on the board, the answer is the top 20 from place 1, with `view: "top"`, whatever `from` says.
- `from` (optional, default 1, used by `top` only): the first place of the page, a whole number from 1 to 999999999 written as digits. "Load more" is `from` + 20. A `from` past the last place gives an empty page.

The response:

- `clock` (`LiveClockView`): the world clock, the same as the dashboard's. The screen's top bar shows it, and the screen reloads the board when it passes an open or a close. null = the world hasn't started.
- `week` (`BoardWeek`): `{ start, day, final }`, as on the dashboard. `final` = the week is before the current world week, or its final board is in `weekly_scores`, so its places won't change. null = nothing scored up to today; then `players` is 0, `me` is null, and `podium` and `rows` are empty (`pastWeeks` is still filled).
- `players`: the last place on that day (`max(rank)`). Places are unique, 1..N: equal scores never share a place.
- `me` (`LeaderboardMe`): my place card. It has the dashboard's `StandingView` fields (`rank`, `players`, `score`, `returnRank`, `stabilityRank`, `rankChange`, `days`), plus `returnPct`, `maxDrawdownPct`, and `ahead` (`{ rank, score }` of the place just above mine; null when I'm first). null = I'm not on this board (not ranked this week).
- `podium`: places 1..3, as rows.
- `rows` (`LeaderboardRow[]`), in place order. Each row has:
  - `rank`, `name` (the display name, or "שחקן"; never the email) and `isMe`
  - `returnPct`, `maxDrawdownPct`, `returnRank`, `stabilityRank` and `score` (the stored values, as display numbers; how they are computed: D-034)
  - `rankChange`: places gained since the previous scored day of the same week. null on the week's first scored day, or for a player who wasn't on that day.
  - `days`: the daily score Mon..Fri, always 5 entries; null = no score that day.
  - `avatar`: 0..4, which of the five avatar fills (LD-06). It is FNV-1a (32-bit) of the uid, mod 5. No uid or email is ever sent.
- `view`: what `rows` holds. `from`: the place of `rows[0]` (1 when `rows` is empty). `hasMore`: there are places after the page.
- `pastWeeks` (`PastWeekView[]`): my last 4 closed weeks before the board's week, newest first, from `weekly_scores`: `{ weekStart, rank, players, score }`. `players` is that week's last place, as the week closed (a user deleted later leaves a gap that isn't renumbered, D-032). With no board, the last 4 weeks of all.
- `scoredAt`: the world instant (ISO) of the latest finished open or close (`market_events.status = 'done'`); null = none yet. The scoring commits in the same transaction as the event's `done`, so it changes exactly when the board is rewritten. The screen's "load more" glues a page under the rows only when its `week.day`, `scoredAt` and `players` match (`sameBoard`).
- `behind`: the world clock has passed an open or close that isn't scored yet (started and not `done`, or not started: the clock follows real time, and the ticker runs a passed event up to a minute later). The board is about to change, so the screen loads it again every 15 to 30 seconds while this is true, at most 20 times in a row. False when no world exists. Read in the same snapshot as the board, so it can be true for one answer too many, but never false while the board is older than the clock.
- **Cost:** every read is an index lookup, never a scan of a whole day:
  - the day and `players`: backward probes of `(day, rank)`; `final`: one probe of `weekly_scores (week_start, rank)`
  - a page and "around me": a range of `(day, rank)`
  - my row, the rank changes and each row's days: `(uid, day)`
  - past weeks: `(uid, week_start)`

  - `scoredAt` and `behind`: `market_events` by `at` (`market_events_at_idx`, `market_events_unfinished_idx`): a handful of rows

  About 9 short queries per request, one pool connection at a time. The board's reads run in one read-only `REPEATABLE READ` transaction (two more round trips, `BEGIN` and `COMMIT`), so a scoring commit between two of them can't mix two rankings in one answer. The dashboard's top 5 and standing do the same.
- 400 when `view` isn't `top` or `around`, or `from` isn't 1 to 999999999 written as digits (`0`, `-1`, `1.5`, `1e3` and `01` are refused). 404 before `POST /me`.

### `GET /me/journal?filter=&period=&before=&limit=`
The trade journal (D-035, [api/src/tradeJournal.ts](../api/src/tradeJournal.ts)): every order the player sent, newest first, what happened to each, and the period's results. Read-only, no catch-up (orders change only when the runner runs them). Returns `TradeJournalView`.

- `filter` (optional, default `all`): `all`, `pending`, `executed` or `rejected`. Picks the rows only; `stats` and `counts` are always the whole period.
- `period` (optional, default `all`): `all` = the whole game; `week` = orders whose `executes_at` is on or after Monday 00:00 (Israel) of the world week, so a pending order is always in it. With no world yet both show everything.
- `before` (optional): an order id. The page holds only orders sent before it, so "load more" is `before=<the last row's id>`. Per player, ids follow the order orders were sent.
- `limit` (optional, default 20): 1 to 100 rows. The screen's reload asks for as many rows as it shows.

The response:

- `clock` (`LiveClockView`): as on the dashboard. The screen reloads when it passes an open or a close. null = no world.
- `filter`, `period`: what this answer holds.
- `stats` (`TradeJournalStats`), from the period's filled sells: `wins` (stored gain > 0), `losses` (< 0), `even` (exactly 0), `winRatePct` = wins ÷ (wins + losses) × 100 to one decimal (null = no win or loss yet), `realizedPnlIls` (the stored `orders.realized_pnl_ils` of those sells, summed in NUMERIC), `avgWinIls` and `avgLossIls` (rounded to agorot; null = none). A buy has no result until it is sold.
- `counts`: the period's orders per status (`all`, `pending`, `executed`, `rejected`), for the filter's labels.
- `reservedCash`: ₪ held by pending buys right now (`portfolios.reserved_cash`).
- `rows` (`TradeJournalRow[]`), newest sent first: `id`, `symbol`, `nameHe`, `market`, `currency`, `side`, `status`, `amountIls` (buys) or `units` (sells), `priceType`, `placedAt`, `executesAt` (pending: when it will run; otherwise the open or close that ran it), `fill` (executed only: `price` in the security's currency, `fxRate` for US, `units`, `ils`, `realizedPnlIls` for sells), `reject` (rejected only: `code` and the Hebrew `reason`), `origin` (`player`, or `stop` for a sell a stop loss made, D-037), `stopPrice` (the stop loss a buy was sent with, or the stop a stop's sell came from; null otherwise) and `stop` (`JournalStopView`, D-041: a filled buy's stop as it is now, `{ id, price, status, lastClose }`, where `status` is `active`, `triggered` or `expired` and `lastClose` is set only while active, for moving it; null = no stop, or the buy hasn't filled). A stop's sells are rows too: they move money like any sell.
- `hasMore`: older rows exist.
- `due`: a pending order's time has passed and the runner hasn't run it yet (the ticker does within about a minute). The screen asks again every 15 to 30 seconds while this is true, at most 20 times in a row.
- **Cost:** 4 short queries: the clock, the portfolio row, one pass over the player's orders for the counts and results (`orders_uid_idx`), and one page of rows (the same index, sorted by id). A player has hundreds to a few thousand orders at most (5 a minute, D-028), so both stay small. A fifth, only when the page has an active stop: the latest close of those stocks.
- 400 when `filter` or `period` is unknown, `before` isn't an order id (digits, 1 to the BIGINT maximum), or `limit` isn't 1 to 100. 404 before `POST /me`.

### Admin routes

Everything under `/admin` needs a valid token **and** `'admin'` in the caller's `users.roles`, read from Postgres on every request (403 otherwise, including before `POST /me`). Removing the role with SQL takes effect on the next request. The `GET` routes are read-only; the `POST /admin/clock/*` routes move the clock.

### `GET /admin/overview`
The admin page's numbers, in one request. Returns `AdminOverview`:

- `clock`: the world clock, like the dashboard's (`running`, `endsAt`), plus `lastTickAt`: the ticker's last beat in real time (D-030; null = never ticked). The page doesn't show it; it is there for an uptime check. null before the world starts
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
Up to 5 players, by rank on the latest scored day of this week, then by portfolio value. Returns `{ players, limit }`; each player has `uid`, `name`, `email`, `isAdmin`, `joinedAt`, `totalValue`, `rank` (null = not scored), `pendingOrders`, `lastSeenAt` (null = never checked in), `visitsToday`.

- `q` (optional) filters by display name or email, case-insensitive. `%` and `_` match themselves.
- `q` longer than 100 characters: 400.
- `totalValue` is the stored `portfolios.equity` the runner keeps current after every event (D-019, D-024), the same number the player's dashboard shows. Nothing is added up on read (D-031).

### `GET /admin/monitoring`
The monitoring page (D-036, [api/src/monitoring.ts](../api/src/monitoring.ts)): how players use the app. Real time and real Israel dates; the world clock plays no part. Returns `AdminMonitoring`:

- `today`: Postgres's real Israel date, the same one the check-ins write with. Every range ends on it.
- `since`: the first day with any usage row; null = nothing measured yet, so the page can say so instead of showing zeros as data.
- `totals.today`, `totals.d7` (today and the 6 days before) and `totals.d30` (today and the 29 days before), each a `MonitoringTotals`:
  - `orders`: orders players sent in the range (real `orders.created_at`, from midnight Israel time of the range's first day), by their status now: `sent` = `executed` + `rejected` + `pending`. From the orders table, never from the app. A stop's sell isn't one a player sent: it is in `stops.fired`.
  - `stops` (D-037), from the same rows: `buys` (buys players sent), `withStop` (of them, with a stop loss), `buyers` and `players` (distinct players who sent a buy, and a buy with a stop loss), `fired` (sells the stops made, by when the runner fired them) and `firedPnlIls` (their stored gains added up; negative = losses taken). Plus `moved` and `movers` (D-041): stop moves in the range and the distinct players who made them, from `stop_moves` by real `created_at`.
  - `confirms`: `{ opened, backed }`, the trade screen's confirm popup.
  - `pages` (`MonitoringPageRow[]`): `{ page, views, ms, players }`, most time first (then most views, then by name). A page nobody used in the range is left out.
  - `ms`: all time in the app. `players`: distinct players with any page usage; a player on two pages counts once.
- `daily`: 30 `UsageBucket`s `{ start, players, ms: { dashboard, trade, journal, leaderboard } }`, oldest first, ending today. A day with no usage is all zeros.
- `weekly`: 12 buckets, each a Monday-to-Sunday week (`date_trunc('week')`, like the game's week), oldest first, ending with this week so far. Zero-filled the same way.
- `stopsNow`: `{ active, players }`: the active stop losses right now and how many players hold them, whatever the range (`stop_orders_active_idx`).
- A page that is no longer tracked keeps its old rows out of every number.
- **One run at a time** per API process: a request that arrives while a run is going gets that run's answer, so retries and reloads never stack up runs that each hold a pool connection.
- **Cost:** 9 short queries, one pool connection at a time: `today` and `since` (`min(day)` of each table's primary key), the orders and the stop-loss counts (each a range of `orders_created_idx`, the 3 ranges as `FILTER`s of one pass), the active stops, the popup totals, the page totals (one row per page per player first, then `GROUPING SETS` give the page rows and the all-pages row), the time per day and page for the 12 weeks (in the primary key's order; the 30 daily and 12 weekly bars are added up from it), and the distinct players per day (30 days) and per week (12 weeks). Distinct players compare ids byte by byte (`COLLATE "C"`), not by the database's language collation. The usage tables grow with players × pages per day, never with clicks: about 1M rows for 12 weeks at 4,000 daily players on 3 pages. Measured on local Postgres 17, the request takes about 1 s there and about 3 s at 3.4M rows.

### `GET /admin/db`
The database's health, read live (D-036). Read-only, and there is no SQL console. Its own route, so the page can refresh it every 30 seconds without running the usage queries again. Returns `AdminDbHealth`:

- `checkedAt` (real time, ISO) and `latencyMs`: the round trip of `SELECT 1` from the API, the wait for a pool connection included.
- `pool`: the API's own pg pool: `max`, `total`, `idle` and `waiting` (requests waiting for a free connection).
- `server`:
  - `version` (for example `17.2`), `startedAt` (`pg_postmaster_start_time()`), `sizeBytes` (this database)
  - `connections`: client connections to the whole server by state (`active`, `idle`, `idleInTransaction`), their `total`, and `max_connections` as `max`
  - `longestQuerySec`: the longest-running active query other than this request's own; null = none
  - `cacheHitPct`: the share of this database's block reads served from memory since its statistics were last reset; null = no reads yet
- `tables`: the 5 largest tables of the `public` schema, indexes included: `{ name, bytes, rows }`. `rows` is Postgres's estimate from the last `VACUUM` or `ANALYZE`; -1 before the first (no estimate yet, never shown as 0 rows). Autovacuum leaves a table with fewer than about 50 changed rows alone, so a small table can stay at -1.
- No query text is ever returned: `pg_stat_activity.query` is never read.
- On a managed host the API's role may not see every statistic. Postgres hides other roles' connection states (they count in `total` only); a statistic the host refuses outright falls back to zeros or null and is logged, and the rest still answers.
- If Postgres is down, the admin check itself fails (500), so the page shows "no connection" from the failed request instead of numbers.

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
