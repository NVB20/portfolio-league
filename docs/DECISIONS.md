# Decisions

Gaps in the brief, and the choices we made. Each entry: what we decided, why, and what would make us change it.

## D-001: Trusted game logic runs in our API

**Status:** Active. The "one transaction" part is replaced by batches (D-021).

**Decision:** Players can only create *pending* orders. When an admin advances the world clock, the API (`api/`) runs the execution logic and writes trades, cash, holdings and snapshots to Postgres in **one transaction**. Only users with the `admin` role can call it.

**Why:**
- Code in the browser can be changed by anyone, so it can't be trusted with money. The API is the only thing that writes to Postgres.
- One transaction means a run either finishes completely or not at all. No half-executed clock advance.
- No need for the Firebase Blaze plan (Cloud Functions).

**The logic stays pure TypeScript** with no database or framework imports, so it can be unit tested:

```ts
executeOrders(pendingOrders, prices, usdIls, portfolios) → { trades, updatedPortfolios, rejected }
```

The API loads the data, calls this function, and saves the result.

**Known weaknesses:**
- A person still has to advance the clock. A cron job could do it on a schedule later.
- One API service and one database node: no built-in backups or uptime monitors (Phase 7 adds a `pg_dump` cron and an external uptime check).

## D-002: Local Postgres (Docker) for development

**Status:** Active. Changed 07.11.2026: it now also holds the app's local databases.

**Decision:** A Postgres container, run with `docker compose`, holds three databases on the developer's machine:
- `prices`: 3 years of daily open/close prices for USD/ILS (`ILS=X`), 20 large TASE stocks and 20 large US stocks (NYSE + NASDAQ). A one-off scraper container (`docker compose run --rm scraper`) fetches them from Yahoo Finance. The game uses 20 of these 40 stocks (brief: "20 stocks or funds").
- `portfolio`: the app's data when the API runs locally (`cd api && npm run dev`).
- `portfolio_test`: wiped and refilled by the API tests (`cd api && npm test`).

**Why:**
- We fetch the prices once and keep them, so we don't call Yahoo again every time we develop.
- SQL tables are the most structured way to store them. `daily_prices` has the key `(symbol, day)`, so there's one row per security per day, no duplicate days, and the types are checked.
- Developing against the same database engine as production (Postgres) catches SQL problems early.

**Gotchas:**
- TASE prices from Yahoo are in **agorot** (`currency = 'ILA'`). Divide by 100 for ₪.
- The current day is never saved, because its "close" is only the latest live price.

**Known weaknesses:**
- Yahoo is unofficial, and FX "open/close" depends on Yahoo's day boundaries. The official Bank of Israel rate (שער יציג) only has one value per day.
- **Yahoo has no TASE Sunday data.** TASE traded Sunday to Thursday until January 2026, then moved to Monday to Friday. Before 2026, every Sunday is missing, so a TASE stock has about 627 days against about 753 for a US stock. From 2026 on, the data is complete.

## D-003: Game prices are real history, loaded once

**Status:** Active.

**Decision:** The 20 securities and USD/ILS use real daily open/close prices, downloaded once (see D-002) and copied from the local `prices` database into the game's Postgres tables.

**Why:** Realistic charts, and every number can be traced back to a real market day.

**Known weaknesses:** The game can only run as far as the downloaded history goes.

## D-004: All orders live in one `orders` table

**Status:** Active (planned for Phase 5).

**Decision:** One `orders` table with a `uid` column that references `users`, and a `status` column (`pending`, `executed`, `rejected`).

**Why:** When the clock advances (D-001), one query finds every pending order. The API lets a player read only their own orders and create only `pending` ones. Once sent, an order can't be changed or cancelled (brief, rule 3).

## D-005: Cash and holdings are separate rows, changed together

**Status:** Replaced by D-019 (09.11.2026). `holdings` becomes `positions`, and cash moves through a double-entry ledger.

**Decision:** `portfolios(uid, cash)` and `holdings(uid, symbol, units)`. Money and units are `NUMERIC`, never float (fractions of a unit are allowed).

**Why:** Constraints check the data (for example, cash and units can't go below zero), and cash and holdings are changed in the same transaction, so they can never disagree. Only the API writes them (D-001).

## D-006: The leaderboard is computed when the clock advances

**Status:** Replaced by D-032 (10.11.2026) and D-034 (11.11.2026). The leaderboard reads stored places (`standings`, `weekly_scores`) through the API (D-032). The runner writes them at every open and close, not only when the admin advances the clock, and the percentiles are exact integers that give ties the higher percentile, not `percent_rank()` (D-034). The reason below still holds.

**Decision:** When the admin advances the clock, the API computes everyone's scores in SQL (percentile ranks with `percent_rank()`) and saves them for that week. Players read the leaderboard through the API.

**Why:** Players never see each other's portfolios, only the scores. Scores change only when the clock moves, so computing them once and saving them keeps each read cheap, even with thousands of players.

## D-007: Dark/light theme is chosen by the user

**Status:** Active. Replaces DD-01 ("dark-only dashboard") in `design/dashboard/README.md`.

**Decision:** The avatar dropdown has a dark/light switch (next to logout). The whole app follows the chosen theme. The dashboard needs a light version. The login page is the same for everyone and has no switch (07.11.2026). The dashboard's light version is designed: see DD-11 in `docs/design/dashboard/README.md`.

**Where it's saved:** In Postgres, in the user's row (`users.theme`: `'dark'` or `'light'`, default `'dark'`), so it follows them to any device. The app changes it with `PATCH /me/theme`, which can change only the theme, never `roles`. The color sets themselves live in `src/theme.ts`.

**Why:** Phase 1 requires a dark/light theme. A user choice, rather than following the device setting, lets players pick what reads best for charts.

## D-008: The portfolio is created with the user, on first login

**Status:** Active.

**Decision:** `POST /me` creates the `users` row and the `portfolios` row (₪1,000,000 cash, the brief's starting amount) in one SQL statement. Players who logged in before the game tables existed got their portfolio in the migration.

**Why:** A player without a portfolio would need a special case on every screen. One statement means a user never exists without one, even with two tabs logging in at once.

## D-009: Until Phase 2, a holding is valued at the latest close that has already happened

**Status:** Replaced by D-024 (10.11.2026). The dashboard and the trading screen now read the values the runner stores at each open and close (D-031). Only display percentages (a holding's day change, the prices on the trading list) still use the latest close already known.

**Decision:** The dashboard values each holding at its most recent daily **close** whose market has already closed in world time. Today's TASE close counts only after 17:30 (13:50 on Friday); today's US close only after New York closes. The USD/ILS rate is yesterday's close. US holdings are converted at that rate.

**Why:** The price table has one open and one close per day. Using a close that hasn't happened yet in world time would show players the future.

**Known weakness:** During trading hours the value doesn't move, because the day's open isn't used yet.

## D-010: The leaderboard shows a display name, never an email

**Status:** Active.

**Decision:** `users.display_name` comes from the Firebase token's `name` claim (Google sign-in has one). Players without one show as "שחקן".

**Why:** The leaderboard is visible to every player, and emails are private.

**Decided 09.11.2026:** players can't choose a name. Choosing one would need an abuse check, and the name from Google is enough for a demo.

## D-011: 40 securities, not 20

**Status:** Active (08.11.2026).

**Decision:** The world has 40 securities: 20 large TASE stocks and 20 large US stocks (NYSE + NASDAQ), all the ones in the local price database. The list lives in `api/src/world/securities.ts` and is copied into the game by `npm run seed:world`.

## D-012: Trades use the stored open/close; charts use live Yahoo OHLC

**Status:** Active (08.11.2026).

**Decision:** Orders execute only at the daily open/close stored in our `prices` table (D-003). The full chart on the trading screen shows real daily OHLC + volume fetched from Yahoo by the API (`GET /me/chart/:symbol`), cut at the last day already closed in world time.

**Why:** Candles need high, low and volume, which we never stored. Re-scraping them would add data the game never uses for money. Keeping money on our own copy means a Yahoo outage or a change in Yahoo's history can never change a trade or a score.

**Known weaknesses:** Yahoo is unofficial and can rate-limit or change. The API caches each symbol for 12 hours. If Yahoo is down, only the chart is affected. Yahoo's numbers may differ slightly from ours (rounding, later corrections).

## D-013: The world starts 20 days into the price history, on a Monday at 09:00 Israel time

**Status:** Active. Changed 10.11.2026 (was the first day of the history, 2023-11-06; before that Monday 5 January 2026). Easy to change before launch: `UPDATE world_clock ...`.

**Decision:** The history starts on the first day every series has data (both markets and USD/ILS): 2023-11-06. The world clock starts on the **first Monday at least 20 days later**, 09:00 Israel time, one hour before TASE opens: **Monday 27 November 2023**. `npm run seed:world` works the date out from the data (`api/src/game/worldStart.ts`, `HISTORY_DAYS = 20`) and sets the clock only if it was never set. All prices are still copied from the first day.

**Why:**
- Players only see closes that already happened in world time (D-009). On the first day of the history nothing has closed yet, so the dollar card, last prices and the 10-day charts were empty.
- 20 days gives 15 USD/ILS closes and 12 TASE / 14 US trading days behind the start.
- A Monday, so the first game week is a full week (the leaderboard is weekly).
- It still uses almost all 3 years of history (154 game weeks, to the week of Monday 2 November 2026).

**Known weaknesses:**
- Until 2026, TASE traded Sunday to Thursday. Yahoo has no TASE Sundays, and TASE was closed on Fridays. So in the game, TASE trades **Monday to Thursday until 2 January 2026**, then Monday to Friday. The calendar (D-016) records this.
- The game ends when the history does (TASE 2026-11-04, US 2026-11-05) unless we scrape again.

## D-014: The smallest order is ₪100

**Status:** Active (08.11.2026). The app's preview checks it, and since 10.11.2026 `POST /me/orders` enforces it, with an exception for selling every free unit (D-028).

**Decision:** Orders under ₪100 are refused.

**Why:** Fractional units make ₪1 orders possible. They add rows and noise and change nothing in a ₪1,000,000 portfolio. A floor also slows down order spam.

## D-015: Chart settings are saved per player

**Status:** Active (08.11.2026).

**Decision:** The full chart's settings (type, timeframe, range, background, colors, indicators) are saved in `users.chart_settings` (JSONB) through `PATCH /me/chart-settings`. The API keeps only known keys with allowed values. Tools like the ruler and the position tool are not saved.

**Why:** The same reason as the theme (D-007): the chart looks the same on any device. A strict whitelist means the column can't fill with junk or be used to store anything else.

## D-016: A market calendar table holds every weekday a market is closed

**Status:** Active. Built 09.11.2026: `market_closures` table, list in `api/src/world/closures.ts` (187 rows), checked against the prices by `npm run seed:world`.

**Decision:** A `market_closures(market, day, reason)` table has one row for every **Monday to Friday** on which TASE or the US is closed. Saturdays and Sundays are a rule in code and get no rows. The rows are seeded from the price data (a weekday with no price row is a closed day), then checked by hand and given a reason ("Passover", "Thanksgiving", "TASE closed on Fridays until 2026").

**What the data shows (2023-11-06 to 2026-11-04):**
- TASE: 156 closed weekdays. 113 of them are Fridays before 2026 (10.11.2023 to 02.01.2026), and 43 are holidays.
- US: 31 closed weekdays.
- On 28 days only TASE is open, on 153 only the US is open (mostly the Fridays before 2026), and on 3 weekdays both are closed.
- In 2026 alone (to 05.11), the markets differ on 25 weekdays (for example, 01.04 to 02.04 TASE is closed for Passover while the US is open, and 03.04 the US is closed for Good Friday while TASE is open).
- These numbers are checked by a test against the list (`api/test/calendar-clock.test.ts`), so they can't drift from it. (Corrected 10.11.2026: it said 112 + 44, 154 and 22.)

**Why:** The two markets have different holidays, so "is the market open?" depends on the day as well as the hour. A table makes the calendar visible and easy to fix by hand. Weekends never change, so they don't need rows.

**Known weaknesses:** A day missing from Yahoo by mistake looks like a holiday until someone checks it. One such day exists: Friday 18.09.2026 has no TASE prices and no known holiday, so it is listed as "no trading data" and is closed in the game. Early-close days (US half days, TASE holiday eves) use the normal hours, because we only have one open and one close per day.

## D-017: The world clock runs in Israel time and moves in three ways

**Status:** Active (09.11.2026). Built 10.11.2026: the admin moves `POST /admin/clock/advance`, `/start`, `/stop` and the per-minute ticker ([api/src/clockActions.ts](../api/src/clockActions.ts), details in D-030), on top of the pure clock in [api/src/game/clock.ts](../api/src/game/clock.ts).

**Decision:**
- World time is shown and calculated in **Israel time**. US hours (9:30 to 16:00 New York) are converted, usually to 16:30 to 23:00 Israel time. For the few weeks a year when only one country is on summer time, the conversion moves by an hour.
- **Move 1, "to the close":** if a market is open, jump to its next close (TASE 17:30, Friday 13:50; US 23:00 Israel time).
- **Move 2, "to the next open":** if no market is open, jump to the next open. Weekends and days when both markets are closed (D-016) are skipped.
- **Move 3, running:** when no admin jumps, world time runs at real speed from where it was left. The clock row stores the world time and the real time it was set, so `now = world_at + (real now − real_at)`. When the running clock reaches a day when both markets are closed, it skips straight to the next trading day.
- Every move runs **all events in between, in time order**. At each open and close, it executes the orders due then and updates the value of only the players that event affects (D-021, D-024).
- **Only admins** can jump the clock, including on the live link. The README explains how a reviewer gets the admin role. A ticker in the API (every minute) handles events the running clock passes. The clock never goes back past an open or close that has already run: the time shown is never before `world_clock.events_through`. One small exception in display only: stopping a running clock freezes it at the moment the stop took the runner lock, so the time shown steps back by however long that stop's run took (D-030).
- **End of history:** the clock stops one minute before the first open that has no prices (`world_clock.ends_at`, 05.11.2026 09:59 Israel time, just before TASE would open with no data). Moves past it are refused, and the game freezes there.

**Why:** Jumps let reviewers play a week in minutes. The running clock means the world never freezes while the admin is away.

## D-018: Buy in shekels; sell always in units

**Status:** Active. Changed 09.11.2026 (a sell was a ₪ amount or units).

**Decision:**
- A buy is always a ₪ amount (the brief's rule). The order stores `amount_ils`.
- A sell is always a **number of units**. The order stores `units`, which are locked when the order is sent.
- The player may type a ₪ amount; the app turns it into units at the last known price before sending. "Sell all" sends every free unit.
- The ₪ received is worked out at execution: units × execution price × USD/ILS rate.
- A `CHECK` constraint makes buys carry only `amount_ils` and sells only `units`.

**Why:** Units are what the player owns, so locking and selling them is exact. There are no leftover fractions, and a pending sell can never ask for more than the player holds.

## D-019: Money is kept in a double-entry ledger, with stored balances

**Status:** Active. Rewritten 09.11.2026. Schema built (`20261109140000000_engine.sql`); written by order sending (D-028) and the runner (D-029) since 10.11.2026. Diagram and a worked example: [Portfolio League Money Model](https://claude.ai/artifact/FHvdTjTcr7Nohn5SmwQyuG).

**Decision:**
- **Ledger.** Every money event is a `journals` row (start, reserve, release, buy, sell) with two or more `ledger_entries` rows that **add up to exactly 0**. A deferred constraint trigger refuses any transaction whose journal doesn't balance, and another trigger refuses UPDATE and DELETE. Mistakes are fixed with a reversing journal.
- **Accounts per player:**
  - `cash_free`
  - `cash_locked` (pending buys)
  - `stock_cost:<symbol>` (₪ paid for the units held)
  - `realized_pnl`
  - `capital` (the starting ₪1,000,000)
  - Sign rule: plus = what the player has (cash, stock), minus = where it came from (capital, gains). A ₪100 gain is written as −100 and shown as +100.
- **Stored balances.** The totals are columns, written in the same transaction as the entries, so a screen never adds anything up:
  - `portfolios`: `cash`, `reserved_cash`, `available_cash` (a generated column), `holdings_value`, `equity`, `realized_pnl`, `unrealized_pnl`, `marked_at`
  - `positions`: `units`, `reserved_units`, `avg_cost_ils`, `cost_basis_ils`, `realized_pnl_ils`, `market_value_ils`, `unrealized_pnl_ils`, `marked_at`
  - At every clock event, a check confirms that each stored balance of the players it trades equals its ledger account (in each order batch, D-029). A mismatch is logged and stored on the event (`ledger_balanced = false`), and the runner carries on (changed by D-029).
- **Positions** replace `holdings`. A buy from 0 units starts a new `open` row, and at 0 units it becomes `closed` and stays as history. A partial unique index allows only one open row per player per stock. Units are not money, so they live on `positions`; the executed orders (`filled_units`) can rebuild them.
- **Orders** carry the fill: `fill_price`, `fx_rate`, `filled_units`, `filled_ils`, `realized_pnl_ils`, `position_id`. There is no executions table, because every order fills once, in full, or is rejected. `client_order_id` is unique per player, so a retried request can't create a second order.
- **Profit is measured at average cost.** A sale's gain = units sold × (execution price × rate − average cost per unit). A sale never changes the average; only a buy does.
- **Unrealized gain** = market value − cost basis. It is not a ledger entry, because nothing was paid or received. The runner updates and stores it at every open and close (prices only change then), for the players that event affects (D-024).
- All money and units are `NUMERIC`: ₪ to agorot, units to 8 decimals.
- **Rounding (decided 09.11.2026):** on a buy, units = amount ÷ (price × rate), rounded **down** to 8 decimals, and the ₪ paid is exactly the amount. Every ₪ value (proceeds, market value, cost released) is rounded to the agora, half away from zero, like Postgres `round()`. A partial sale releases units × average cost, but never more than the cost left; selling everything releases all the remaining cost, so a closed position keeps no rounding agora.
- **In code:** the pure engine (`api/src/game/fixed.ts`, `ledger.ts`, `engine.ts`, `week.ts`) uses bigint fixed-point, never floats. Every journal it builds balances, or it throws.

**Example (buy 10 units at ₪100, sell them at ₪110):**

| Event | Entries (sum = 0) |
|-------|-------------------|
| Start | cash_free +1,000 · capital −1,000 |
| Send buy | cash_free −1,000 · cash_locked +1,000 |
| Fill buy | cash_locked −1,000 · stock_cost +1,000 |
| Fill sell | cash_free +1,100 · stock_cost −1,000 · realized_pnl −100 |

The balances afterwards: cash_free 1,100, stock_cost 0, realized_pnl −100 (shown as a +₪100 gain).

**Sending an order:** in one transaction, lock the player's portfolio row (`SELECT … FOR UPDATE`), check free cash (buy) or free units (sell), insert the order, then write the reserve journal (buy) or add to `reserved_units` (sell). **An order without enough free cash or units is refused when sent.**

**Why double entry:** a bug that creates money is the worst bug a trading game can have. With single entry, code that adds sale cash but forgets to remove the stock would go unnoticed. With double entry, the database refuses that transaction. It is also how banks and brokers keep their books, and it lets every number on screen be traced to the entries behind it.

**Cost:** two or three entries per event instead of one, a short list of account types, and about half a day more work.

## D-020: The 20% limit is checked again at execution, at the execution price

**Status:** Active (09.11.2026). Built 10.11.2026: the send-time check in `POST /me/orders` (D-028), and the execution-time check in the pure engine, which the runner calls (D-029).

**Decision:**
- **When sent:** checked with the last known price. A breach is refused, and the preview shows it.
- **When executed:** checked again with the real execution price: (current holding value + buy amount) ÷ portfolio value, both at that moment's prices, must be ≤ 20%. Portfolio value counts all cash, including reserved cash. A breach rejects the order, releases its cash and gives the reason ("would be 21.3% of the portfolio").
- Several buys of the same stock at one event are checked one by one, in the order they were sent.
- The reason shows the share it would have reached with one decimal, rounded once from the exact ratio. A breach is never shown as "20.0%": anything just over the limit shows at least 20.1%, so the message can't read as allowed.
- We **never** sell on the player's behalf, except a stop loss the player set on the buy (D-037). A holding that grows past 20% because its price rose is allowed. The rule applies only at the moment of purchase.

**Why:** An order sent while the market is open fills at that day's close. A stock at 19% when the order is sent can be at 21% by the close. Only a check at the real execution price closes that gap.

## D-021: Postgres is the queue: the orders table plus an event log

**Status:** Active. Updated 09.11.2026 for a target of 1M players (decided in the admin-dashboard session). Built 10.11.2026: the runner ([api/src/runner.ts](../api/src/runner.ts), details in D-029) and order sending (D-028). The per-minute ticker and the admin clock moves that call the runner: D-030. Replaces D-001's "one transaction per clock advance".

**Decision:**
- **Sending** is a short transaction that locks only that player's portfolio row, so players never wait for each other. The limit is **5 orders per minute** per player.
- **Sending vs. clock moves:** sending an order takes a shared lock on the `world_clock` row (`FOR SHARE`), and a clock move takes an exclusive one. An order sent at 17:29 can't slip in after the runner has already passed the 17:30 close.
  - Every writer of the clock row (the runner starting an event, the admin's clock moves, the ticker's heartbeat) first locks the table with `LOCK TABLE world_clock IN EXCLUSIVE MODE`. A row lock alone is not queued fairly: Postgres grants a new `FOR SHARE` on a row that only share lockers hold even while a `FOR UPDATE` is waiting, so overlapping sends could hold an event back until the 10 s statement timeout cancelled it, on every tick. The table lock is queued: a send that arrives after it waits behind it, so a writer waits only for the sends already in progress (milliseconds). Plain reads of the clock never wait.
  - A send locks the player's own portfolio row first and the clock second, so one player's queued sends hold nothing the runner needs. (Updated 10.11.2026 after review: a single player sending refused orders in parallel could stop every event.)
- **Execution** happens at clock events, not when an order is sent. A rush of orders at market open only adds `pending` rows; nothing is executed in that rush.
- **Postgres only.** One runner at a time (`pg_advisory_lock`), working in batches. No Redis.
  - BullMQ is ruled out because it only works with Redis.
  - pg-boss (a job queue that runs in Postgres) is not used for the market-close engine. Events must run in order and the clock can't move until an event is fully done, so we'd still need our own event log. pg-boss is the next step for independent jobs: retention notifications, emails, and the per-minute ticker as a cron job. The README says so.
- **Event log:** `market_events` has one row per open or close. Status goes `pending` → `orders_done` → `done`, and the row stores counts and duration.
- **The flow for one event** (for example the TASE close):
  1. **Orders:** run the orders due at this event in batches of about 500 (by `executes_at`, then `id`). Each batch also checks the ledger of its own players (D-019, D-029). Mark the event `orders_done`; from then on, this event's prices are in effect.
  2. **Affected players:** players who held a position in that market before the event, plus players whose order executed at this event (a first buy, or a sale of everything). Cash-only players and players with only the other market's stocks are skipped. Page through them by uid (`WHERE uid > $last LIMIT 5000`); never load all ids into Node.
  3. **Online players first:** two passes over the same query, first the players who are online (`users.last_seen_at`, online as D-026 defines it), then everyone else. A single `ORDER BY online DESC, uid` can't page with `uid > $last`. The second pass skips players the first already updated, through the `last_event_at` check.
  4. **Update in batches** of about 5,000 players. Each batch is one short transaction that sets value, peak, drawdown and `last_event_at` (D-024).
  5. **Finish:** write the daily chart rows, then in one transaction the median, the leaderboard (D-034) and the event's `done` (with the ledger check's result). `ANALYZE` of the board follows the commit when the event wrote a new day or weekly rows. Only then does the clock move. (Updated 11.11.2026: this said the leaderboard came after `done`. It is in the same transaction, so a crash before the commit re-runs the scoring with the event.)
- **Safe to retry:** the event log plus `portfolios.last_event_at`. A player's update applies only `WHERE last_event_at < event_at` (or `IS NULL`), so a retried batch changes nothing. Orders change status as they run. After a crash, the runner restarts at the first event that isn't `done`, at the step it stopped. Retry safety does not depend on whether a snapshot row exists.
- **Kept in mind for the admin page** (`/admin-dashboard`, built separately). It will show players online, unique players today, repeat opens, the last run and the queue per market. For that:
  - `market_events` stores orders executed and rejected, players updated, duration and whether the ledger balanced.
  - `users.last_seen_at` (a heartbeat about once a minute) and `app_opens` come with the admin session's presence migration (D-026).
  - Later, with the admin page: an `admin_actions` log.

**Why:** Postgres already gives us ordering, locking and retries. A separate queue would be one more service to run and watch while we're away. Updating only the players an event affects, in short batches, keeps one event's work proportional to the players it really changes.

**What would make us change it:** if one event takes more than about a minute, move the runner to its own worker service (still Postgres, with `FOR UPDATE SKIP LOCKED` so several workers can share the batches).

## D-022: Each market's status comes from the calendar and is shown separately

**Status:** Active (09.11.2026). Built 10.11.2026: `sessionOn` and `marketStatus` read the calendar ([api/src/game/marketHours.ts](../api/src/game/marketHours.ts)), `GET /me/dashboard` and `GET /me/trade` return both markets' statuses, and the top bar, the world clock card and the trading screen show them.

**Decision:**
- `sessionOn`, `isMarketOpen`, `executionFor` and the clock moves all read the calendar (D-016). There is one answer to "is TASE open?", and the screens, the order engine and the clock all use it.
- The API returns each market's status: `open`, `pre_open`, `after_close`, `weekend` or `holiday`, plus the reason ("פסח", "Thanksgiving", "הבורסה בת״א סגורה בימי שישי עד 2026") and the next open time.
- **Dashboard:** the top bar shows two status chips, TASE and New York, each open or closed. When only one market trades that day, a line says so ("היום רק ניו יורק פתוחה · ת״א סגורה: פסח"). The world clock card shows "closed today" with the reason and the next open.
- **Trading screen:** each security shows its own market's status. When that market is closed, the ticket says when the order will run ("השוק סגור · יתבצע בפתיחה, יום ב׳ 10:00"). At the end of the price history that open never comes: the API marks the execution `gameOver` (an order sent now is refused with `GAME_OVER`, D-028) and the trading screen's clock carries `endsAt`, so the ticket can say so instead of promising a time. (Added 10.11.2026 after review. The app says "המשחק הסתיים" and promises no time.) The top bar's two chips (ת״א, ניו יורק) say פתוחה or סגורה in words and follow the live clock, and a line under the top bar says when only one market trades today and why ("היום רק ניו יורק פתוחה · ת״א סגורה: פסח"; a weekend reads "סוף שבוע").
- The clock's "to the next open" move skips any day on which neither market opens.

**Why:** Players need to know before they send an order whether it fills at today's close or at a later open. On the 181 days when only one market trades, a single "market open" light would be wrong for half the stocks.

## D-023: A rejected order shows a toast

**Status:** Active (09.11.2026). API part built 10.11.2026: `GET /me/dashboard` returns the unseen rejections and `POST /me/rejections/seen` marks them seen (D-031). App part built 10.11.2026: the dashboard shows up to 5 unseen rejections (what, how much, and the server's Hebrew reason), and reports their ids as seen only once they are on screen and the tab is visible, so a toast the player never saw is never marked.

**Decision:** When an order is rejected, the player sees a toast with the reason the next time the app loads their data. The journal page (D-035, built 11.11.2026) lists every rejected order with its reason.

**Why:** A rejection happens at a clock event, usually while the player is away. Without a message they would only notice that their cash didn't change.

## D-024: Weekly running totals per player, not a snapshot of everyone

**Status:** Active (09.11.2026, decided in the admin-dashboard session). Written by the runner since 10.11.2026 ([api/src/runner.ts](../api/src/runner.ts)): the running totals, the lazy reset, the daily chart rows and the median per event (D-029). Replaces D-009: the dashboard and the trading screen read these columns (D-031).

**Decision:**
- **Running totals on `portfolios`:** `week_start` (the Monday), `week_start_value`, `peak_value`, `max_drawdown_pct`, plus `equity` (D-019) as the current value and `last_event_at`. At each event, for each affected player (D-021):
  - `peak = max(peak, value)`
  - `mdd = max(mdd, (peak − value) / peak)`

  Scoring reads these columns and never scans history.
- **Lazy weekly reset:** a row whose `week_start` is older than the event's week is reset the first time it is touched: `week_start_value` and `peak_value` become the value before the event, and the drawdown becomes 0. Nothing writes 1M rows when a week starts. `week_start` is a date, not a week number, because week numbers repeat every year.
- **Untouched players:** a row nobody touched this week means the player's value didn't change, so their return is 0 and their drawdown 0. (Updated 11.11.2026, D-034: a cash-only player nobody touched this week is not ranked at all. A player who holds a stock but wasn't touched yet this week, such as a US-only holder before New York opens on Monday, is ranked at 0 / 0. The scoring tells them apart by `week_start` and the open positions, and never scans history.)
- **Which events change which values:** a TASE event revalues only TASE positions. A US event revalues US positions at that event's price and USD/ILS rate (the day's open rate at the open, the close rate at the close). A TASE event therefore never changes a US-only player's value, and that is what makes "affected players" correct.
- **Chart history:** `portfolio_snapshots` gets at most one row per player per trading day. It is written at that day's last event, for every player an open or close re-valued that day (whose `last_event_at` falls on that day), whether or not the value moved. Cash-only players and players nothing touched that day get no row. The value at time t is the latest row at or before t. (Corrected 10.11.2026: this said "only for players whose value changed". The runner always wrote it for every player touched that day, D-029. Comparing each value with the day before would cost a lookup per player and draw the same chart.)
- **Median player line:** one row per event in `market_events` (`median_value`, `median_return_pct`), not one row per player.

**Why:** a snapshot of every player at every open and close is 1M rows per event, about 4M a day. The running totals give return and drawdown in one row per player, and the chart needs at most one row per player per day.

**Known weakness:** the week chart shows one point per day, not one per open and close.

## D-025: A player's value is brought up to date when they open the app

**Status:** Active (09.11.2026, decided in the admin-dashboard session). Built 10.11.2026: `catchUpPlayer` in [api/src/runner.ts](../api/src/runner.ts). `GET /me/dashboard` and `GET /me/trade` call it before reading (D-031).

**Decision:** when a player opens the dashboard and their `last_event_at` is behind the latest event whose prices are in effect (status `orders_done` or `done`), the API updates that one player on the spot. It uses the same function and the same `last_event_at` check as the batch, so the batch skips them later.
- **"The latest event" is the latest one the runner has started, whatever its status.** If that event is still `pending` (its orders are running, in batches of 500), there is no catch-up. Every event before it is already done, so nobody is behind one of those. And a player whose order filled in an earlier batch already holds the running event's prices: applying the event before it would re-mark a position at a price from before it was bought, and fold a value that never existed into the week's peak, drawdown or start value (D-024). Step 2 of the running event updates that player.
- **Never an older event over a newer state.** The shared update (`updatePlayers`, used by the batch and the catch-up) skips a player a later event has already traded: an open position marked or opened after the event, or an order executed at a later event. It checks this after locking the player's row, so the next event starting between the catch-up's first read and its update changes nothing. The runner's own batches never meet such a player, because events run in time order.

(Both added 10.11.2026 after review: on Fridays the TASE open and close, and the US open and close, are back to back, so a busy close could corrupt the week's numbers of a player who opened the app during it.)

- **A read never waits for a lock.** The catch-up skips a player whose row someone else holds (`FOR UPDATE SKIP LOCKED`): the runner's batch, which updates them anyway, or their own order being sent. The read then shows the stored values, and the next read catches up. It also doesn't add to `market_events.players_updated`, which now counts the runner's own pages only: that one row was written by every catch-up of the event, so a burst of reads queued on its lock. Whether the player is due is one statement, because every read pays for it. (Added 10.11.2026 after review: a burst of 2,000 reads right after a close held pool connections while waiting on those locks, the 10-connection pool ran dry, and some reads failed with a connection timeout.)

**Why:** during an event, the batches take time to reach everyone, and an online player would see an old value until then. This keeps online players correct without a second queue. "Behind the latest finished event" is read as "behind the latest event whose orders have run", because that window, before the event is `done`, is exactly when an old value would show.

## D-026: Presence: the app checks in once a minute, and the server counts visits

**Status:** Active (09.11.2026, admin-dashboard session).

**Decision:**
- While the app is open and visible, it calls `POST /me/seen` right away and then every 60 seconds. A hidden tab or an app in the background stops the check-ins; coming back sends one at once.
- Each check-in sets `users.last_seen_at`. **Online now** = seen in the last 2 minutes. **Players today** = seen since midnight (real Israel date), each player once.
- **A visit** starts with a check-in after more than 30 minutes away, or with the very first one. It is one row in `app_opens`. "Came back several times today" = players with 2 or more visits today.
- **The server decides**, never the app: the body is ignored, check-ins less than 30 seconds apart write nothing, and the row is locked so check-ins at the same moment start one visit, not several.
- **The body is no longer ignored** (11.11.2026, D-036). It may carry a usage report (time and views per page, the confirm popup), which the server caps and adds to the usage tables. The visit logic still ignores it: nothing in the body can start a visit or move `last_seen_at`.
- **The lock is `FOR NO KEY UPDATE`, not `FOR UPDATE`** (11.11.2026, after review of D-034). A check-in changes only `last_seen_at`, never the key. The runner's scoring holds `FOR KEY SHARE` on every ranked player's `users` row until its finish transaction commits (the foreign keys of `standings` and `weekly_scores`), and `FOR UPDATE` waited for it. Measured at 200,000 ranked players: at the week's last event a check-in waited up to 4 s, the waiting check-ins took all 10 pool connections, and unrelated requests waited too. With `FOR NO KEY UPDATE` the longest wait was 48 ms. Two check-ins of the same player still wait for each other, so a visit is still counted once.
- Everything here is real time, not world time: it measures people, not the game.

**Why:** the admin page needs online now, players today and repeat visits, and the retention feature needs the same numbers to show it works. 30 minutes is the common session timeout in web analytics, and a visit decided by the server can't be inflated by a client.

**Known weakness:** every online player writes once a minute. Thousands online is about 50 writes a second, which Postgres handles easily. At hundreds of thousands online, move check-ins to an in-memory counter flushed in batches, or check in less often.

## D-027: Retention is measured as day-1 and day-7 return; admin actions are logged with the action

**Status:** Active (09.11.2026, admin-dashboard session).

**Decision:**
- **Day-1 return** = of the players who signed up on a day, the share who started a visit (D-026) on the next calendar day. **Day-7 return** = the same, 7 days later. Real Israel dates.
- Only players whose day 1 (or day 7) is already over are counted, so a player who signed up yesterday doesn't count as "didn't come back" while today is still going. The cohort is everyone who signed up in the last 30 days (`GET /admin/activity`).
- The admin page also shows active players per day for 30 days (players who started a visit that day).
- **Admin action log:** every admin clock action (advance to the close, to the next open, start, stop) writes one `admin_actions` row in the **same transaction** as the action. The engine's clock endpoints write it; the admin page reads the newest 5.

**Why:** the brief asks for the retention feature to come with a way to measure it. Day-1 and day-7 return are the common measures for "does it bring players back every day", and they need nothing beyond the visits we already record. Writing the log in the action's transaction means the log can't miss an action or show one that rolled back.

**Known weakness:** "active on a day" counts visits started that day, so a player who keeps the app open across midnight without a 30-minute break isn't counted on the second day.

## D-028: What is checked when an order is sent

**Status:** Active (10.11.2026). Built: `POST /me/orders` ([api/src/orders.ts](../api/src/orders.ts)); the rules are pure code in [api/src/game/orderRules.ts](../api/src/game/orderRules.ts). The API now enforces D-014.

**Decision:** sending an order is one short transaction (D-019, D-021) that checks what is already certain, sets the cash or units aside, and stores a `pending` order. The runner checks cash, units and the 20% limit again at the execution price (D-020). A refused send is answered with `{ error, code, reason }` (English, a stable code, Hebrew) and stores nothing.

- **₪100 minimum, also for sells (D-014).** A buy under ₪100.00 is refused. A sell is valued at the position's last mark (units × last price × its USD/ILS rate; at average cost if it was never marked), and under ₪100 is refused, **unless it sells every free unit**. Without that exception, a position worth ₪60 could never be closed. The app sends every free unit when the ₪ typed reaches the free units' value as shown in whole ₪ (or with "מכור הכל"), so a sell never leaves a dust position behind; any other ₪ amount is turned into units at the position's last mark, rounded down to 8 decimals (D-018).
- **The 20% limit counts pending buys of the same stock.** When sent: (the holding at its last mark, or at cost if never marked, + this player's pending buys of that stock + this buy) × 100 ≤ 20 × the stored `equity`, compared exactly. Without the pending buys, five ₪199,000 orders sent one after another would each pass alone and together put 99.5% in one stock; the runner would reject four of them at the close, and the player would only find out then. Pending sells are not subtracted.
- **Game over.** An order that would run after `world_clock.ends_at` (or is sent once the clock is there) is refused with 409 `GAME_OVER`. No event will ever run it, so its cash would stay locked for good.
- **Rate limit: 5 orders per real minute per player (D-021).** Counted from `orders.created_at` inside the transaction that holds the player's portfolio row `FOR UPDATE`, so requests sent in parallel can't get past it. Over the limit: 429 `RATE_LIMITED` with `Retry-After` = the seconds until the oldest of the last 5 is a minute old (at least 1). Only stored orders count.
- **Retried requests (`clientOrderId`).** Optional, unique per player. The same id with the same symbol, side and size returns the stored order (200, `replay: true`), whatever its status now, with no new row, no second reserve, and no count toward the rate limit. The same id with a different order is 409 `CLIENT_ID_CONFLICT`. An app that lost the response can safely send again.
- **Exact sizes.** ₪ up to 2 decimals, units up to 8, positive, at most 20 characters. A JSON number is read from the request's own text, digit for digit, not through a JavaScript number: `JSON.parse` rounds first, so `100.0000000000000001` arrived as 100 and was stored as a ₪100.00 order, and `99.999999999999999` slipped past the ₪100 minimum. Anything we would have to round (`"100.001"`, `100.0000000000000001`, `0.1 + 0.2`) or an exponent (`1e2`) is a 400, so the stored order is exactly the order sent. (Changed 10.11.2026 after review: it said "read as `String(n)`".)
- **The send's "now"** is the effective world time (`worldNow`: the running clock, capped at `ends_at`, never before `world_clock.events_through`), read from the clock row the send holds `FOR SHARE`. `placed_at`, `executes_at` and the reserve journal's `world_at` come from it. An order sent while the runner is already running the 17:30 close goes to the next open, not into the close.

**Why:** a player should hear about anything certain when they press send, not in a toast after the close (D-023). Everything that depends on the execution price stays with the runner, which has the real price.

**Known weaknesses:**
- The 20% check when sent uses the last mark, which can be a day old. The execution-time check (D-020) is the real gate, so a send can pass and still be rejected at the close.
- Refused sends store nothing, so they don't count toward the limit. The limit protects the order queue, not the endpoint. A flood of invalid requests needs a limit in front of the API (per IP or per token), which we don't have. Such a flood costs database work but can no longer hold an open or close back: a send takes the clock lock only after its own portfolio row, and the clock's writers are queued fairly (D-021).
- A replay returns the order as it is now, not the exact first response. An app that retries after the order already ran sees `executed` or `rejected` instead of `pending`.

## D-029: The runner: event prices, the ledger check, daily chart rows and the effective "now"

**Status:** Active (10.11.2026). Built: [api/src/runner.ts](../api/src/runner.ts), tested in [api/test/runner.test.ts](../api/test/runner.test.ts). The effective "now" is `worldNow` in [api/src/game/clock.ts](../api/src/game/clock.ts). Changes one line of D-019: a ledger mismatch no longer stops the runner.

**Decision:**
- **Event prices.** An open uses each security's `prices.open` for that day, and a close uses `prices.close`. A security with no row that day has no price: its orders are rejected `NO_PRICE` (a buy gets its cash back through a release journal, a sell gets its units back), and its positions keep their last mark.
- **USD/ILS for a US event:** that day's `usd_ils.open` at the open, and `usd_ils.close` at the close. A day with US prices but no rate row (2025-04-21 is one) uses the latest earlier day's close. With no rate at all, the US event has no prices. TASE prices are already in ₪.
- **The effective "now"** is the later of the clock time (the running clock, capped at `ends_at`) and `world_clock.events_through`, the latest event the runner has started. The screens, order sending and the runner all use this one rule (`worldNow`). During an admin jump the runner starts the 17:30 close before the clock row moves. An order sent at that moment goes to the next open, and the screens already show 17:30.
- **Ledger check at every event (D-019).** It covers the players whose orders the event executed or rejected, and runs **inside each order batch**, in its transaction, for that batch's players (at most 500). Their rows are locked by the batch, so nothing can change them between the writes and the check, and the check's cost never grows with the event. `cash` must equal cash_free + cash_locked, `reserved_cash` must equal cash_locked, and `realized_pnl` must equal −realized_pnl. For each stock, the open position's cost basis must equal stock_cost (0 when there is no open position). On a mismatch the runner logs the uids (`console.error`), sets `ledger_balanced = false` on the event at once (a clean batch after it never sets it back), and **carries on**. An event that finishes with no mismatch gets `true`. The admin page shows it in red. (Changed 10.11.2026 after review: one statement at the finish over every player with an order at the event took over 10 s at about 150,000 such players, inside the finish transaction, so the event could never finish.)
- **Daily chart rows (D-024).** At the last open or close of an Israel day (from the calendar, so on a US holiday it is the TASE close), each player whose `last_event_at` falls on that day gets one `portfolio_snapshots` row: the event's time and the stored `equity`. `ON CONFLICT DO NOTHING`, so a re-run adds nothing. They are written in pages of 5,000 players by uid, each page one statement on its own, before the transaction that marks the event `done`. One statement over everyone touched that day took over 10 s at about 750,000 players (its foreign key check alone is seconds), so the event never finished and every later event waited behind it.
- **The runner's own statement timeout.** A run (`withRunnerLock`: the ticker and the admin's moves) sets `statement_timeout` to 5 minutes on its connection, and the pool's 10 s comes back when the run ends. A step that grows slower than a player's request must still finish; one that fails is retried by every tick, and nothing after it runs.
- **The median (D-024) is exact.** It is the middle `equity` of all portfolios, or for an even count the mean of the two middle values, rounded half up to the agora. The week return works the same way, in % to 4 decimals, with 0 for a row not touched this week. Only the middle one or two rows leave Postgres. There are no floats and no `percentile_cont`. The count and both middles come from **one statement**, so they see one set of players: the finish runs at READ COMMITTED, and a player signing up between a count and an `OFFSET` read gave a median of neither set (fixed 10.11.2026 after review).
- **The leaderboard is written in the finish transaction (D-034, 11.11.2026).** After the median: read `world_clock.ends_at`, decide whether this is the week's last event (`isLastEventOfWeek`), write the day's `standings` (and `weekly_scores` at the week's end), then mark the event `done`. `ANALYZE` of the board runs after the commit when the event wrote a new day or weekly rows, on the runner's connection, and a failure there is only logged.
- **A lost database connection fails the run, not the process.** If the database ends a session (a restart, a failover, a dropped proxy connection), node-postgres emits an `error` event on that connection, and the pool doesn't listen while a connection is checked out. Unheard, Node throws it and the whole API process exits: every request in flight, and the ticker. The API's pool (`api/src/db.ts`) listens on every connection for its whole life, and the runner's lock holder listens too, so only the query that was running fails; the ticker logs it and the next tick resumes the event. The server drops the advisory lock with the session. (Added 10.11.2026 after review.)
- **The runner shares the API's event loop (D-030).** A page of 5,000 players is a few hundred milliseconds of JavaScript (parsing, marking, formatting). The long loops give the loop back every 500 items (`eachSlice`). Measured at 50,000 players during a close: the longest stall of the event loop went from about 420 ms to about 140 ms, and the 99th percentile from 220–320 ms to 60–90 ms. (Added 10.11.2026 after review.)
- **Late orders run late, not never.** An order whose `executes_at` is earlier than the event being run (missed after a crash or a manual clock change) runs at the next event of its market, at that event's price.
- **Order of events:** a close comes before an open at the same instant. The runner lists events from 1 ms before `events_through`, so a second event at the same minute as the last one started still runs. Events already `done` are skipped. The runner never starts an event after `ends_at`.

**Why:**
- **Prices:** the brief fills orders at the open or the close, and the daily rows are all the prices we have (D-003, D-012). Yahoo's rate history is missing a day now and then, and the previous close is the closest real number. Refusing a whole US day because one rate is missing would reject good orders.
- **The ledger check:** stopping the runner would freeze the game for everyone while nobody is around to fix it (the brief's "you are on vacation"). A mismatch is a bug to find. The flag, the log line and the uids are enough to find it, and the append-only ledger keeps the true record either way.
- **Chart rows:** the dashboard needs one point per day. Writing it once a day, only for the players an event re-valued that day, keeps the table small.
- **The effective "now":** without it, the screens and the order rules disagree during an admin jump, and an order could land inside an event that is already running.

**Known weaknesses:**
- The median sorts every portfolio twice per event (by value and by return, in one statement). That is nothing at thousands of players. At a million it is a second or two per event, inside the finish transaction (under the runner's 5-minute timeout). The fix is a sampled or bucketed median.
- `players_updated` counts the runner's own pages, not the players a read caught up first (D-025), so after a busy event it can be lower than the players whose value changed.
- The daily chart rows find their players by `last_event_at`, which has no index: the pages walk the whole `portfolios` primary key once per trading day.
- A step that fails on every try (for example one slower than 5 minutes) still stops the game. The ticker logs every failed run, but nothing alerts anyone yet.
- After a mismatch the game carries on from the stored balances, which may be the wrong side of the mismatch until someone fixes it with a reversal journal.

## D-030: The admin's clock moves run the events first, then move the clock; a ticker in the API runs the rest

**Status:** Active (10.11.2026). Built: [api/src/clockActions.ts](../api/src/clockActions.ts) (`POST /admin/clock/advance`, `/start`, `/stop`, and `startTicker`, wired in [api/src/server.ts](../api/src/server.ts)), tested in [api/test/clock-admin.test.ts](../api/test/clock-admin.test.ts).

**Decision:**
- **Run first, then move.** Advance and stop take the runner's advisory lock and run every open and close up to the target (D-021, D-029). Only then do they move the clock row, in **one transaction** that also writes the `admin_actions` row (D-027): advance sets `now_at` = the target and `real_at` = now, and stop also sets `running = false`. A failed move leaves no log row, and a log row always means the clock moved.
- **During the run, "now" already follows the events.** Each event the runner starts raises `world_clock.events_through`, and the effective now (`worldNow`, D-029) is never before it. Screens and order sending see the jump as it happens, and an order sent mid-jump runs after the event that is running.
- **Where a jump goes** is `jumpTarget` (D-017): the next close of an open market, otherwise the next open, from the effective now, never past `ends_at`. At `ends_at` the answer is 409 `CLOCK_AT_END`. A running clock keeps running from the target.
- **Busy means 409 `CLOCK_BUSY`, not waiting.** If the lock is held (by the ticker, another API instance or a second click), advance and stop answer at once, and the admin clicks again. An HTTP request never waits behind a long event.
- **A click sent twice moves once.** Advance takes an optional body `{ from }`: the world time the admin page showed when the admin clicked (`clock.at`). Under the runner lock, if an open or close has started after that time (`events_through > from`: the first click already went through and its answer was lost, or the ticker ran an event meanwhile), the answer is 409 `CLOCK_MOVED` and nothing moves. A running clock that only ticked on, with no event in between, still moves. Without `from` every click jumps, as before. Every jump runs at least the event it lands on, which is what makes `events_through` the test (`movedSince`, game/clock.ts). (Added 10.11.2026 after review.)
- **Start** sets `running = true` and `real_at` = now, and anchors `now_at` at the effective now: the time every screen shows, the later of `now_at` and `events_through`. Its log row has that time as `world_from` = `world_to`. No world time passes, so nothing runs: it takes no runner lock and is never busy. **Stop** freezes at the effective now of the moment it took the lock, after running every event up to it. A second start or stop answers `{ changed: false }` and writes nothing. (Start's anchor changed 10.11.2026 after review: it kept the old `now_at`, so after an advance whose final transaction failed, a started clock stood still at `events_through` for hours while it looked like it was running, and the log named a time no screen showed.)
- **The ticker** lives in the API process (`startTicker`, started in `server.ts`, not in `createApp`, so tests never start it). It ticks once at start-up and then every 60 seconds:
  1. Write `world_clock.last_tick_at` (real time), always, even when nothing is due or the lock is busy. It is the heartbeat the admin page watches.
  2. Take the runner lock. If it is busy, skip this tick: whoever holds it is doing the same work.
  3. Run everything up to the effective now: what a running clock has passed, plus any event a crash left unfinished. It never moves `now_at` or `running` and writes no `admin_actions` row; it isn't an admin action.
  - A tick whose previous run is still going skips its own run, so runs never overlap. Errors are logged and never thrown out of the timer, and the next tick resumes the event at the step it stopped. That includes the database ending the run's connection mid-run: the run's query fails like any error, and the process lives on (D-029). `TICKER=off` turns the ticker off. On SIGTERM it stops and waits for the tick in progress.
  - Several API instances may each tick. The advisory lock lets one run at a time, and a run cut short by a deploy is resumed by the next one.

**Why:** Running before moving means the clock never shows a time whose events haven't run. The log in the same transaction is D-027's rule. Refusing when busy keeps admin requests short and predictable. The ticker is the brief's "you are on vacation": with nobody clicking, the running clock's opens and closes still run within a minute, and an event that crashed half way finishes on its own. The heartbeat lets an uptime check tell "nothing is due" from "the ticker is dead" (the admin page showed it as a light until 11.11.2026; the user removed it). The ticker stays in the API process because it is one less service to deploy and watch. pg-boss is the next step for it (D-021).

**Known weaknesses:**
- If the final transaction fails after the run, the events stay done (they are retry-safe and are not undone), but the clock row did not move. The effective now is already at the last event (`events_through`), so the screens show the jump's time. A **stopped** clock is re-anchored there by the next start. A **running** clock stands still there until its own time catches up, or until the admin's next advance, or a stop and a start, sets a new anchor.
- Stop sets the anchor when the move commits to the time it took the lock. On a running clock, the time shown steps back by however long the run took (milliseconds normally, more for a big event). Advance lands on its target, so there the time shown only stands still during the run.
- Advance and stop run inside the HTTP request. At a million players one event takes long enough that a proxy may time out the request. The work still finishes, because nothing cancels it, but the admin sees an error and the log row appears when the work ends. A click sent again with `from` answers `CLOCK_MOVED` instead of jumping a second time. **The admin page doesn't send `from` yet** (`src/admin/useAdmin.ts`, the admin session's file): until it does, a retry after a lost answer jumps again. The fix for the long request itself is D-021's own worker service.
- The ticker shares the API's pool (10 connections) with players' requests. Its run sets its own 5-minute statement timeout on its connection (D-029), so a slow event isn't cancelled at the pool's 10 s.
- The ticker also shares the API's CPU. Its loops pause every 500 items (D-029), but a request can still wait up to about 140 ms behind it at 50,000 players, and an event of hundreds of thousands of players takes CPU from players' requests on that instance for its whole length. The fix is the same worker service.
- The heartbeat is an UPDATE of the clock row once a minute. Order sends hold that row `FOR SHARE`, so for a moment they wait for it (and it for them). The wait is fair: the heartbeat waits only for the sends already in progress, and later sends wait behind it (D-021).
- An admin click that lands while the ticker is running an event gets `CLOCK_BUSY` and has to click again.

## D-031: The screens read the stored values; the app tells the API which rejections it showed

**Status:** Active (10.11.2026). Built: `loadPortfolio` and the week numbers in [api/src/dashboard.ts](../api/src/dashboard.ts), used by `GET /me/dashboard` and `GET /me/trade` ([api/src/trade.ts](../api/src/trade.ts)), and `POST /me/rejections/seen`. Replaces D-009 (with D-024).

**Decision:**
- **Read, never add up.** Cash, reserved cash, available cash, the total (`equity`), realized and unrealized gain come from `portfolios`. Each holding comes from its open `positions` row: units, free units (units − units locked by pending sells), value (`market_value_ils`, or the cost basis before the first mark), cost basis and unrealized gain. The weight is value ÷ the stored equity. If the stored total ever disagreed with the holdings, the screen would show both as stored: a ledger problem is the ledger check's job (D-029), not the screen's.
- **Exact until the JSON.** NUMERIC columns are parsed into bigint (`fixed.ts`). The weight and the week numbers are worked out exactly (4 decimals). They become JS numbers only in the response.
- **The week's numbers come from the running totals (D-024).** Return = `weekReturnPct` (week.ts) of the stored equity. Max drawdown = the stored column. Both are 0 for a row whose `week_start` isn't this week: nothing touched it this week, so its value hasn't changed. "vs. median" = my return − `median_return_pct` of the latest **finished** (`done`) event this week. Before the first finished event of the week it is empty (null), not 0.
- **The week chart.** Mine: a point at Monday 00:00 (`week_start_value`, or the current equity for a week nothing has touched), this week's daily rows from `portfolio_snapshots`, and the stored equity now. The median: `median_value` of each finished event this week. Points are one per instant (a close and an open in the same minute keep the later one).
- **Catch-up first (D-025).** Both reads call `catchUpPlayer` before reading. It never waits for a lock: a player whose row is busy is skipped for this read. If it fails, the error is logged and the screen shows the stored values: a stale number for a minute beats an error page, and the runner's batch brings the row up to date anyway.
- **Rejection toasts (D-023).** The dashboard returns the player's unseen rejected orders (`notified_at` null): newest rejection first (the event's world time), at most 5, each with the Hebrew reason and a stable `code`. After showing them, the app calls `POST /me/rejections/seen { ids }` with exactly the ids it showed (1 to 5). The API sets `notified_at = now()` on those of that player's rejected orders not seen yet. It touches only their own rows and only rejected ones, and a second call marks nothing. (Changed 10.11.2026 after review: it was `{ upToId }`, every rejection with id ≤ the largest shown. Order ids follow the order orders were sent, rejections the events: a rejection of a lower id arriving between the read and the call was marked without ever being shown.)
- **What stays on the closes:** a holding's day change % and the prices on the trading list are display numbers from the latest close already known in world time (as in D-009). Money never comes from them.

**Why:**
- The runner already stores every balance in the same transaction as its ledger entries (D-019). A screen that added things up again could disagree with the ledger, and it would read prices for every holding on every request. One row per position is cheaper and can't drift.
- The week numbers must match the scoring, and scoring reads the running totals. The chart has one point per day, so a drop and a recovery between two daily rows would be invisible to a drawdown computed from the chart.
- "Seen" is stored on the server, so a toast seen on the phone doesn't come back on the laptop. Exact ids mark only what was shown, are safe to retry, and a client can't mark another player's rows.

**Known weaknesses:**
- With more than 5 unseen rejections, the oldest wait: they come in the next read, once the newer ones are marked seen. The journal (D-035) shows every rejection, but opening it doesn't mark them seen.
- The value shown is as of the latest open or close, while the day change % is from closes. During trading hours a holding's value is its open price and its day change is yesterday's.
- The median line has one point per open and close, and mine one per day. They share the axis but not the moments.
- Every read now does the catch-up's small query first, and a write when the player is behind.
- **Capacity under a burst.** A dashboard read is about 9 statements one after another, each its own pool checkout, on a 10-connection pool, so one API instance serves roughly 550–600 dashboard reads a second (measured at 50,000 players: 2,000 reads at once took 3.5 s for everyone, 5,000 took 9 s). Right after a close, when most readers also catch up, 2,000 reads took 12 s, but none failed (before the D-025 lock changes, 5 of them failed with a connection timeout and 879 catch-ups gave up). A burst much bigger than that per instance will hit the pool's 5 s wait for a connection. The next steps: fewer round trips per read (merge the portfolio, pending and rejection reads; cache for a second what is the same for every player, like the clock row and the week's median line), more API instances, or PgBouncer in front of Postgres.

## D-032: The leaderboard reads stored places; the scoring mechanism is Phase 4b

**Status:** Active (10.11.2026). Built: the tables in [api/migrations/20261110172700000_leaderboard.sql](../api/migrations/20261110172700000_leaderboard.sql) ([SCHEMA.md](SCHEMA.md#standings)), the reads in [api/src/leaderboard.ts](../api/src/leaderboard.ts) (`GET /me/leaderboard`, and the dashboard's standing and top 5), the screen at [src/app/leaderboard.tsx](../src/app/leaderboard.tsx) with its logic in [src/leaderboard/](../src/leaderboard/). Partly replaces D-006. The scoring mechanism (who is ranked, the percentiles, when scores are written) is Phase 4b, its own session: built 11.11.2026 as D-034. The runner now writes both tables at every open and close ([api/src/scoring.ts](../api/src/scoring.ts)).

**Decision:**
- **Two tables are the contract with Phase 4b.** `standings` is the live board: one row per ranked player per scored day, with the week's return and drawdown so far, both percentile ranks, the score and the place. `weekly_scores` is each closed week's final board, a copy of its last scored day, written once. 4b writes them and the API only reads them. What 4b must keep true is in [SCHEMA.md](SCHEMA.md#standings): one row per ranked player per day, places 1..N with no gaps, a day written in one transaction, the closed week kept until the next week's first scoring. D-034 meets it.
- **One board for everyone, whatever market (user, 10.11.2026).** The board ranks everyone's week by return and drawdown, whichever market their stocks are in. A player holding only US stocks is on the board from Monday's first event. Their numbers wait for New York's open (a TASE event never changes them, D-024), but their place can move as other players' numbers change.
- **No shared places (user, 10.11.2026).** Equal scores are broken by % gain, then the smaller drawdown, then the earlier sign-up. **Only percentages decide, never ₪ amounts** (user, 10.11.2026: an earlier "₪ gain" step was dropped). Portfolios never reset, so a ₪ step would put a bigger portfolio above a smaller one with the same %. So `rank` is unique per day (and per week in `weekly_scores`), it runs 1..N, and it is the list order. The database enforces the uniqueness (`UNIQUE (day, rank)`, `UNIQUE (week_start, rank)`).
- **Which board is shown:** the latest `standings` day up to the world's today (Israel date), with no lower bound. On the weekend, and on Monday before the week's first open, that is still the week that just closed, not an empty board. `final` = that day's week is before the current world week, or its `weekly_scores` rows exist (written at the week's last event, so on Friday evening too). The app then shows the week as closed instead of "updates at every open and close".
- **Players = `max(rank)` of that day:** one index probe. Never `count(*)`, which reads a whole day (a day can hold every player).
- **The rank change (▲ / ▼)** = my place on the previous scored day of the same week − my place now. It is null on the week's first scored day, and for a player who wasn't on the previous scored day.
- **Every read is an index lookup.** The day and the player count by backward probes of `(day, rank)`, places by `(day, rank)` ranges (the top 20, "around me" = my place ± 5, "load more" = the next 20, the podium, the place just above mine), my row, my place on the previous scored day and my rows this week by `(uid, day)`, `final` by one probe of `weekly_scores (week_start, rank)`, past weeks by `(uid, week_start)`. Nothing scans or sorts a whole day. This needs current planner statistics for the newest day, so the scoring runs `ANALYZE` after it writes a new day ([SCHEMA.md](SCHEMA.md#standings), D-034).
- **One snapshot per answer.** The reads of one request (`GET /me/leaderboard`, and the dashboard's top 5 and standing) run in one read-only `REPEATABLE READ` transaction. A scoring run that re-ranks or replaces a day between two of them can't give a place card whose row is missing from "around me", or an empty page of a week just deleted.
- **The answer says how far the scoring has got** (11.11.2026, after review). `scoredAt` is the latest finished open or close. The scoring commits with the event's `done`, so it is the exact version of the rows read with it. `behind` is true when the clock has passed an open or close that isn't scored yet (started and not `done`, or not started). Both are read in the answer's snapshot.
  - **The screen asks again while `behind`.** The clock follows real time, and the ticker runs a passed event up to a minute later (D-030), so the screen's reload as the clock passes an open or close came before the scoring about 9 times in 10. The screen then showed the old places until the next open or close, up to 6.5 hours. Now it loads again every 15 to 30 seconds (spread so open screens don't all ask at once) while `behind`, at most 20 times in a row.
  - **"Load more" checks `scoredAt`.** A page is glued under the loaded rows only when its day, `scoredAt` and player count match. A same-day re-score where two neighbours swap places changes neither the count, the podium nor my row, so the old check (those three) glued two rankings together: one player twice and one missing.
- **No uid or email in the JSON.** Rows carry the display name ("שחקן" without one, D-010) and `isMe`. Which of the five avatar fills a row gets (LD-06) is a hash of the uid made on the server (FNV-1a, mod 5): the same for a player on every day and device, without sending their id.
- **The dashboard reads the same board** (`loadBoard`), so its standing and top 5 never disagree with the leaderboard page. The standing carries the board row's drawdown (`maxDrawdownPct`), so the dashboard's sentence about the drawdown speaks of the board's week. On Monday before the open the board is last week's, while the portfolio's drawdown is already the new week's 0 (it said "a drop of 0.0%"). The sentence also only says the drop is "more than most players" when the stability rank is below 50, and never to the leader.
- **Cut from the design (user, 10.11.2026)**, also noted in the local design files (docs/design/leaderboard, not in git, D-002):
  - **The histogram** of every player's return (LD-05). It is an aggregate over a whole day, so it can't be an index lookup at a million players. If it comes back, the scoring step (`scoreEvent`, D-034) would need to write bins at each scoring; 4b shipped without them.
  - **Search by name.** Matching part of a name across every player needs its own index (trigram) on a table that isn't the board. The two questions players ask, who is winning and who is next to me, are the top 20 and "around me".
  - **Sort by return or drawdown.** Sorting the whole field by another column needs another index on a table rewritten at every scoring. Sorting only the 20 loaded rows would look like a ranking and isn't one.
  - **The sticky "you" strip** (LD-04). The "your place" card at the top and the "around me" view already show your row. A strip pinned to the bottom of a card inside a scrolling page is fiddly in React Native for little gain.

**Why:**
- Splitting the board from the scoring lets the API and the screen be built and tested now, against a fixed table shape, while the open scoring questions (who is ranked, mid-week joiners, ties inside a percentile, how often it runs) get their own session (answered in D-034).
- Stored places keep each read cheap (D-006's reason, kept): thousands of players open the board at the same moments, right after a close, and a read is a handful of index lookups however many players there are.
- A unique place makes paging exact: places 21 to 40 are exactly the next 20 rows, "around me" is one range, and the count is the last place. Shared places (1, 2, 2, 4) would need a separate list position for all three.
- The closed week on the weekend: a blank board for two days, right after the week's result, would hide the moment players most want to see.

**Known weaknesses:**
- **It depends on the scoring keeping places 1..N without gaps.** Nothing in the database checks "no gaps". A deleted user's rows go with them (CASCADE) and leave a gap until the next scoring, at the next open or close (D-034 rewrites the day whole, and a test checks the gap closes). Until then the player count reads one too high, a page shows one row fewer, and the player just below the gap gets no "place just above mine".
- **A closed week's final board (`weekly_scores`) is never rewritten.** A deleted user's rows there go too (CASCADE) and leave a permanent gap. The other players keep the place and the player count (`max(rank)`) the week closed with, which is the frozen result they saw. This applies to every closed week the user was ranked in, and to a gap the backfill copies from a day. Nothing reads a closed week by rank range today (past weeks read my row and `max(rank)`). A future full past-week board must page by list position, or a user deletion must renumber that user's closed weeks in the same transaction (delete and re-insert each week with `row_number() OVER (ORDER BY rank)`). A test pins the current behaviour.
- **The board is empty before the first open or close the runner scores**, apart from the development sample (D-033). The dashboard and the leaderboard then show their empty state.
- **The rank change compares days, not events.** The scoring rewrites the day at every open and close (D-034), so a player who climbed and fell back within the day sees no change.
- **A past week counts as final even without its `weekly_scores` rows** (for example if the runner was stopped before Friday's last event): the board then shows that week's last scored day as final. Since D-034 the two agree: the next week's first scoring copies that same last day into `weekly_scores` before it deletes the old days.
- **The other way round, on the weekend the week is final only once its `weekly_scores` rows exist.** On Saturday and Sunday the world's week is still the closed one, so `final` rests on `weekly_scores` alone. D-034 writes them in the same transaction that marks the week's last event `done`, so a failed write leaves the event unfinished and the next tick retries it. They are still missing when the event that turned out to be the week's last didn't know it when it ran (for example, a closure added for Friday after Thursday's close had run). Then the weekend board shows as live, and the next week's first scoring writes the final board from Thursday.
- **A day the planner has no statistics for is slow to read.** Until `ANALYZE` (or autoanalyze) runs after a new day is written, "my row" and "my days" scan the whole day (measured at 50,000 players: 5 to 16 ms per statement instead of under 0.1 ms). The scoring runs `ANALYZE` after committing a new day (D-034). If that fails, it is only logged, and reads stay slow until autoanalyze runs.
- **Scores and ranks are display numbers** in the JSON (`::float8`, as on the dashboard). The exact values stay in Postgres.

## D-033: A sample board for development

**Status:** Active (10.11.2026), development only. Built: [api/scripts/seed-sample-board.ts](../api/scripts/seed-sample-board.ts) (`npm run seed:sample-board`), its pure parts in [api/src/sampleBoard.ts](../api/src/sampleBoard.ts), tested in [api/test/sample-board.test.ts](../api/test/sample-board.test.ts). Since 11.11.2026 the runner writes real boards (D-034). The sample is still useful for a full board on a local database with few players and no trades. A scoring that ranks nobody leaves the day alone, so the sample survives the opens and closes until someone trades.

**Decision:**
- **A script writes made-up places**, so the leaderboard could be seen filled before 4b existed (D-034 now writes real boards). It is sample data, not the scoring mechanism, and says so in its header and its output: each player's week is a seeded random walk, not anyone's portfolio. The same seed gives the same numbers, so a second run writes the same rows.
- **Players:** 40 sample users (`sample-01` to `sample-40`, emails at `sample.invalid`, Hebrew names, four without a name and one Latin name), plus every real user in the database, so the developer sees their own row. Two samples never move (return 0, drawdown 0), so the board always shows the tie-break at work.
- **Samples are `users` rows only.** No portfolio, no journal, no orders: the ledger is append-only (D-019), and the samples must stay a plain delete that touches nothing but the two board tables. `created_at` is 2000-01-01, so the admin page's sign-ups and day-1 / day-7 cohorts (D-027) never count them.
- **What it writes, in one transaction:**
  - `standings` for each trading day of the world's current week, Monday to today (on the weekend, Monday to Friday). A weekday when neither market opens is skipped (D-016).
  - `weekly_scores` for the 4 weeks before, and for the current week once no open or close is left in it.
  - Ranks are percentiles as Postgres `percent_rank()` gives them (× 100, to 2 decimals). The score is 0.85 × return rank + 0.15 × stability rank. Places run 1..N by score, then % gain, then the smaller drawdown, then uid (every sample has the same sign-up time, so uid stands in for it).
  - **Not the real formula (D-034).** `percent_rank()` gives tied players the **lower** percentile (the players strictly below ÷ (N − 1)); the real scoring gives them the **higher** one (the others at least as good ÷ (N − 1)). The sample also ranks every user, while the real scoring ranks only players who hold a stock or were touched this week.
- **Safe to run again:** each day and week it writes is deleted and written again. Older sample days and weeks, from a run in an earlier week, are removed.
- **It refuses to run** (it prints why and exits with 1) unless `DATABASE_URL` points at `localhost` or `127.0.0.1`, the database isn't `portfolio_test` and `NODE_ENV` isn't `production`. A URL with a `host` in its query string is refused too, because node-postgres would connect there instead. These checks are a pure function with tests (`NODE_ENV` in any case). After connecting it also refuses a database with more than 1,000 real players, since a port forward or a proxy to a shared database connects through localhost too. It refuses when there is no world clock, and when a day or week it would write holds rows but none of a sample player (a real scoring run wrote them). `--force` overrides the last two (more than 1,000 players, foreign days). After writing it runs `ANALYZE standings, weekly_scores`, as the real scoring does (D-034).
- **`--clear`** deletes, in one transaction, every `standings` day and `weekly_scores` week where a sample player has a row (with the real players' rows on them, which are sample numbers too), then the 40 sample users.
- **A variable already set wins over `api/.env`.** `DATABASE_URL=postgres://...@localhost:5432/other npm run seed:sample-board` uses `other` (Node's `--env-file` never overrides the environment).
- **With the real scoring on the same database (D-034):**
  - The real scoring's first run on a day that ranks anyone deletes the whole day, sample rows included, and writes the real ranking. Sample players have no portfolio, so the real scoring never ranks them. A run that ranks nobody leaves the day as it is (changed 11.11.2026 after review: it deleted the sample's current day at the next open or close on a database with no trades).
  - The first scoring of a new week that ranks anyone deletes the older sample days. Before that, a sample week with no `weekly_scores` rows gets them from its last day.
  - Every open or close of the current week that isn't its last deletes that week's `weekly_scores`, a sample's included.
  - The script, in turn, refuses a day the real scoring wrote (no sample row on it) unless `--force`.

**Why:** the API and the screen need a filled board to be built and checked: the podium, "around me", paging, the arrows, past weeks. When this was built the real one didn't exist yet (Phase 4b); now it needs players, trades and clock moves. Rows typed into a test fixture show only what the test's author thought of. A script that writes the real tables in their real shape goes through the exact reads players will hit. The safety rules exist because it deletes rows: pointed at production, it would replace real boards.

**Known weaknesses:**
- "Local" is judged by the host name, plus the 1,000-player check. A tunnel on localhost to a small shared database (a port forward, a cloud proxy) still passes.
- The refusal is per day: a day that already holds a sample row counts as the script's own, and all of it is replaced.
- While the samples exist, the admin page's player total counts them, and real players' rows on those days are sample numbers. Run `--clear` before using the database for anything else.
- It takes no lock. Running it while a real scoring run writes the same days would interleave the two.
- A week can mix sample days and real days: the real scoring rewrites only the day of the event it runs, so the sample's earlier days of the week stay until the next week's first scoring deletes them. The rank change (▲ / ▼) then compares a sample place with a real one, and a week backfilled from a sample last day keeps sample numbers in `weekly_scores` until `--clear`.

## D-034: The weekly score: who is ranked, percentiles, when it is written

**Status:** Active (11.11.2026). Built: the rules as pure functions in [api/src/game/score.ts](../api/src/game/score.ts) (the spec, and the oracle the tests check the SQL against), the set-based SQL in [api/src/scoring.ts](../api/src/scoring.ts) (`scoreEvent`, `analyzeBoard`), called from the runner's finish step (`finishEvent` in [api/src/runner.ts](../api/src/runner.ts)). Tested in [api/test/score.test.ts](../api/test/score.test.ts) (pure) and [api/test/scoring.test.ts](../api/test/scoring.test.ts) (the SQL against the oracle, the runner, `GET /me/leaderboard`). It fills the two tables D-032 reads, with no new migration. The brief's formula and the rules marked (user) are fixed. Everything else here is a **default the user can change**: each one is a single function in `score.ts` (named below), mirrored once in the SQL of `scoring.ts`.

**Decision:**
- **The formula (the brief):** score = 0.85 × return rank + 0.15 × stability rank. Return rank = the percentile of the week's return among the ranked players (100 = the highest). Stability rank = the percentile of the week's max drawdown (100 = the smallest drop). One board for everyone, whatever market (user, D-032). Only percentages decide, never ₪ amounts (user).
- **Who is ranked (default, `isRanked`).** At an event of week W (W = the Israel Monday of the event, `weekOf`), every player whose `portfolios.week_start` is W, **or** who holds an open position now.
  - `week_start` = W means the runner touched the player this week: they held a stock at an open or close of this week, or an order of theirs was due at one (D-024's lazy reset).
  - A player who only holds cash and wasn't touched this week is **not ranked** and has no row.
  - A player who sold everything earlier this week stays ranked, with the numbers they locked in.
  - A player holding only US stocks is ranked from Monday's first event (the TASE open), at 0 / 0 until New York opens. Their place can move before that.
  - **What the code does with a rejected order:** the order step starts the week (`startWeek`) of every player with an order due at the event, rejected ones too. So a cash-only player whose only order this week was rejected (for example `NO_PRICE`) is ranked at 0 / 0 for the rest of the week. A test pins this ("a cash-only player whose only order this week was rejected"). To leave them out, either the order step skips `startWeek` for a player with no executed order, or the rule adds "an executed order this week".
- **Mid-week joiners (default).** Ranked from the event where their first buy fills. Their return counts from their value before that first trade (₪1,000,000 for a new player), through the existing lazy week reset (`startWeek`, D-024). The scoring has no special case for them.
- **The numbers (default, `weekNumbers`).** `return_pct` = the week's return so far in %, 4 decimals, rounded half away from zero: the same number as the dashboard (`weekReturnPct`, D-031) and the median (D-029), and in SQL the same exact `div()` expression as `medians()`. `max_drawdown_pct` = `portfolios.max_drawdown_pct`. Both are 0 for a row whose `week_start` isn't W, and the return is 0 when there is no start value (`week_start_value` NULL or ≤ 0).
- **Percentiles and ties (default, `percentile`).** With N ranked players:
  - return rank = 100 × (the **other** ranked players with a return ≤ mine) ÷ (N − 1)
  - stability rank = 100 × (the **other** ranked players with a drawdown ≥ mine) ÷ (N − 1)

  In words: the share of the other players you did at least as well as. **Tied players share the higher percentile** (like places 1, 2, 2, 4), so the best return always gets 100, and so does the smallest drop, as the brief says. N = 1: both ranks are 100. In SQL this is N − `rank()` over the return (high first) and over the drawdown (low first). Each rank is rounded half away from zero to 2 decimals (`NUMERIC(6,2)`), exactly, in integers: no floats and no `percent_rank()`.
- **The score (default, `scoreOf`).** 0.85 × return rank + 0.15 × stability rank, computed from the **stored, already rounded** ranks and rounded half away from zero to 2 decimals, so a row of stored numbers can be checked by hand. The weights are two constants (`RETURN_WEIGHT` = 85, `STABILITY_WEIGHT` = 15, out of 100); the SQL takes them as parameters.
- **A worked example** (from `score.test.ts`). Five players, so each has N − 1 = 4 others and every percentile is a multiple of 25:

  | Player | Return | Drawdown | Return rank | Stability rank | Score | Place |
  |--------|--------|----------|-------------|----------------|-------|-------|
  | a | +3.00% | 1.00% | 100 (4 of 4) | 50 (2 of 4) | 85 + 7.5 = 92.50 | 1 |
  | b | +1.00% | 0.00% | 75 (3 of 4) | 100 (4 of 4) | 63.75 + 15 = 78.75 | 2 |
  | c | +1.00% | 2.50% | 75 (3 of 4) | 25 (1 of 4) | 63.75 + 3.75 = 67.50 | 3 |
  | d | 0.00% | 0.00% | 25 (1 of 4) | 100 (4 of 4) | 21.25 + 15 = 36.25 | 4 |
  | e | −2.00% | 4.00% | 0 | 0 | 0.00 | 5 |

  b and c tie on return. Each did at least as well as 3 of the 4 others (each other, d and e), so both get 75. b and d tie on the smallest drop, and both get 100.
- **The place (user, plus one technical step; `comparePlaces`).** By score, then % return (higher first), then the smaller drawdown, then the earlier sign-up (`users.created_at`, to the microsecond), then the uid in byte order (`COLLATE "C"`). The first three tie-breaks are the user's (D-032). The uid only orders two sign-ups in the same microsecond. In SQL it is `row_number()` over that order, so places are unique, run 1..N with no gaps, and are the list order.
- **When (default).** At **every** open and close, so a day is rewritten up to 4 times. It is part of the runner's finish step (D-021 step 5): after the affected players (step 2) and the daily chart rows, in **one transaction** with the median and `market_events.status = 'done'`. The median comes first, because it is the one statement that must see a single set of portfolios (D-029).
  - The day's `standings` rows are deleted, and one `INSERT … SELECT` with window functions writes the new ranking. Only the count comes back to Node. Delete and insert, not an upsert: it guarantees places 1..N, and `standings_day_rank_key` is deferrable, so it can't be an `ON CONFLICT` arbiter. The ranking rule (`isRanked`) is one SQL fragment in `scoring.ts`, used by the insert and by the delete's guard.
  - A crash before the commit leaves the event `orders_done`, and the re-run scores it again (a test checks it writes the same rows). After the commit the event is `done` and is never scored again.
  - N = 0 writes no rows and deletes none: the day keeps what it holds, which can only be a development sample day (D-033). Within a week the ranked set only grows, except through user deletes, and those cascade. (Changed 11.11.2026 after review: the delete ran first, so a sample day vanished at the next open or close on a database with no trades.)
- **The week's end (default, `isLastEventOfWeek`).** An event is the last of its week when the calendar has no open or close after it before next Monday 00:00 Israel time, or none at or before `world_clock.ends_at`. On a Friday when New York is closed, that is the TASE close. At the same instant a close comes before an open. At that event, in the same transaction, `weekly_scores` for W is written as an exact copy of the day's rows just written. W's existing rows are deleted first, so a sample or a retried write can't conflict. At the world's end the app says the game is over and this is the final board, instead of promising a new week (`gameEnded` in `src/leaderboard/board.ts`).
  - **Beyond the first spec:** every other event of W also deletes W's `weekly_scores` rows (an index probe that normally deletes nothing). If an earlier event wrote the final board and later stopped being the week's last (for example, `ends_at` moved later), the board would otherwise mark a live week as final (D-032's `final`).
- **A new week, and pruning (default).** At a scoring of week W that ranks anyone (N > 0), when `standings` still holds days before W's Monday:
  1. Every earlier week that has `standings` days but no `weekly_scores` rows gets them, copied from that week's **last** scored day. Its last event never wrote them: the world was stopped or ended, or the calendar changed after it.
  2. Then every `standings` row with a day before W's Monday is deleted.

  Same transaction. The earlier days are found by backward index probes, one per day. With N = 0 nothing is pruned. So the closed week stays on the board on the weekend and on Monday before the first event, as D-032 requires.
- **After the commit:** `ANALYZE standings` (plus `weekly_scores` when weekly rows were written) on the runner's connection, outside the transaction, **only when the event wrote a new day** (the day had no rows before) **or weekly rows** (`newDay` / `weekWritten` from `scoreEvent`). A rewrite of a day the planner already knows skips it (see Known weaknesses for why). A failure is logged (`console.error`) and the run carries on, since autoanalyze catches up later. (Changed 11.11.2026 after the benchmark: the first spec said after every event.)
- **Scale:** set-based SQL, one statement per step, nothing per player in JavaScript. It runs under the runner's 5-minute statement timeout (D-029).
- **Measured** (11.11.2026, before the change to `ANALYZE` above; local Docker Postgres 17 with default settings: `shared_buffers` 128 MB, `work_mem` 4 MB; other test runs shared the machine). A throwaway database filled with set-based SQL ran the 20 events of one week, each through the same transaction as `finishEvent` (median, `ends_at`, `isLastEventOfWeek`, `scoreEvent`, commit), then `analyzeBoard`. Many ties: returns from −15% to +15% in 0.01% steps, 40% of drawdowns exactly 0. 15% of the players held only cash and weren't ranked. The whole finish transaction:

  | Ranked | Normal event (rewrite of the day) | Day's first event | Week's last event | Next Monday: delete 5 old days / with the backfill | `ANALYZE` after | `GET /me/leaderboard` |
  |--------|-----------------------------------|-------------------|-------------------|----------------------------------------------------|-----------------|-----------------------|
  | 50,000 | 1.1 s (1.0 to 1.4) | 0.9 s | 1.8 s | 1.0 s / 1.5 s | 0.1 to 0.2 s | 7 to 12 ms (21 ms first call) |
  | 200,000 | 5.4 s (4.5 to 6.2) | 4.3 s | 9.7 s | 4.7 s / 7.0 s | 0.15 s (up to 2.3 s when it cancelled an autovacuum) | 7 to 18 ms (119 ms cold) |

  The ranking insert at 50,000 spends 23% reading and ranking, 51% writing the rows and their three indexes, and 24% on the per-row foreign key check on `users`. The `weekly_scores` copy alone is 0.5 to 0.9 s at 50,000 and 2.9 to 4.0 s at 200,000 (the same foreign key check and indexes). The median (D-029) in the same transaction is 82 ms and 347 ms. Time grows about linearly (4 times the players took 4.7 times as long): at a million ranked players roughly 25 to 35 s per event and about 50 s at the week's end, under the runner's 5-minute timeout. 64 MB of `work_mem` kept the sorts in memory but saved no time (969 vs 1,014 ms at 50,000), and `jit = off` saved nothing measurable, so neither is set.

**Why:**
- **Who is ranked:** an idle sign-up isn't competing. With them in, a falling week's podium would fill with cash accounts that never traded: a return of 0 beats every loss, and a drawdown of 0 is the top stability rank. Holding a stock now, or having been touched this week, is what "playing this week" means in the data we already keep (D-024), so the rule costs no extra table or scan. A player who sold everything stays ranked because their week happened, and a player shouldn't disappear from the board mid-week because they sold.
- **Ties share the higher percentile:** the brief says 100 = the highest return and 100 = the smallest drop. With `percent_rank()` (ties share the lower percentile), players tied at the smallest drop would get less than 100. That happens every Monday morning, when every US-only holder sits at 0 / 0. Sharing the higher one keeps the brief's two promises for any tie.
- **The score from the rounded ranks:** the API returns each rank and the score to 2 decimals, so a row can be checked with a calculator against those numbers, and the database and the tests agree to the last digit. The screens round them: the table shows ranks to 1 decimal and the score to 1; the score card shows 1 decimal and writes ≈ when the rounded numbers don't add up.
- **Exact integers:** the SQL and the pure oracle must give the same digits. Floats would round differently in Postgres and JavaScript, and ties would become near-ties.
- **Every open and close:** values only change at opens and closes (D-024), so that is exactly when the board can change. Scoring once a day would leave the board behind the dashboard's own numbers for hours.
- **Inside the finish transaction:** the board and the event's `done` are one commit. A crash can't leave a done event with an old board, or a new board on an event that isn't done. It reuses the runner's retry safety (D-021) instead of adding a second job to watch.
- **The final board at the week's last event:** the weekend board is final on Friday evening (D-032), not only on Monday.
- **Backfill before pruning:** without it, a week whose last event never ran would lose its final board when its days were deleted (D-032's earlier weakness).

**Known weaknesses:**
- **A ₪100 ticket makes a player ranked while they score almost like cash.** One ₪100 buy puts a player on the board, and with 99.99% in cash their return and drawdown stay near 0. In a falling week that beats most players on return and nearly tops stability, so a player who is almost all cash sits near the top. The brief's 15% stability weight rewards low exposure, and ranking only players who hold stocks doesn't stop it. Fix: a minimum invested share to be ranked, or stability measured against the money invested.
- **Selling everything after a good start locks the week.** The return stops moving and the drawdown can't grow. A player up 5% on Tuesday can sell everything and keep that number until Friday. That is how a weekly return works. A fix would weigh the return by the time money was invested.
- **A mid-week joiner has fewer events to lose, or to gain.** A player whose first buy fills on Thursday has one or two events of drawdown, so a small drop and a high stability rank, and less time for the return to move. Fix: rank only players who held stocks from the week's first event, or scale by the days played.
- **A rejected order puts a cash-only player on the board** at 0 / 0 for the rest of the week (see "Who is ranked"). The app's text says a player gets on when a buy fills, which is the usual case.
- **The rank change compares days, not events (D-032).** The day is rewritten at up to 4 events, and the arrow compares my latest place today with my last place on the previous scored day. A climb and a fall within one day show nothing, and the arrow moves again with each event of the day.
- **`ANALYZE` runs only after a new day or weekly rows** (the user should confirm: the first spec said every event). `ANALYZE` takes a lock that conflicts with autovacuum: when an autovacuum of `standings` is running, `ANALYZE` waits `deadlock_timeout` (1 s) and then cancels it. Run at every event of back-to-back events (an admin jump, a catch-up), it kept `standings` from ever being vacuumed: at 200,000 ranked the table held 0.8 million live and 3.0 million dead rows after Monday to Thursday, and a rewrite grew from 4.1 s to 5.8 s (3.7 to 4.1 s on a just-vacuumed table). Now a rewrite of a known day skips it and leaves the rest to autoanalyze. The cost: if many players join during one day, the planner's row estimate for that day stays low until autoanalyze runs; the reads stay index lookups, since the day itself is known. The once-a-day `ANALYZE` can still cancel one autovacuum. If it fails, "my row" reads are slower until autoanalyze runs (D-032).
- **Every event deletes and rewrites N rows.** That leaves N dead rows per event, about 4N a day, for autovacuum. The first scoring of a new week also deletes about 5 days × N. Both run inside the finish transaction, under the 5-minute timeout (timings: "Measured" above). With events hours apart, autovacuum keeps up. At the default `work_mem` the ranking's sorts spill a few MB to disk; a bigger `work_mem` was measured and saves no time, so it is not set.
- **`return_pct` is `NUMERIC(10,4)`.** A weekly return above 999,999.9999% would make the insert fail, and the runner would stop on that event at every tick. Real prices can't get there, and there is no clamp.
- **N = 0 at the week's last event** deletes W's `weekly_scores` and writes none, the same as copying an empty day.
- **The finish transaction holds `FOR KEY SHARE` on every ranked player's `users` row** (the foreign keys of `standings` and `weekly_scores`) until it commits: about 1 s at 50,000 ranked, 10 s at the week's end at 200,000. A plain `UPDATE` of a non-key column doesn't wait, but `SELECT … FOR UPDATE` on a users row and a user deletion do. The check-in now locks `FOR NO KEY UPDATE` for this reason (D-026); a new `FOR UPDATE` on `users` would bring the wait back, and at a million players the week's end (about 50 s) would outlast the API's 10 s statement timeout. Dropping the foreign keys would save about 20% of the insert but lose `ON DELETE CASCADE`.
- **A closed week keeps a deleted user's gap** in `weekly_scores` for good (D-032): its places and player count stay as the week closed.
- **Screens learn about a new ranking by asking.** The leaderboard screen asks again every 15 to 30 s while the answer says `behind` (D-032). The dashboard's standing and top 5 load when the screen opens, and an open dashboard keeps them until it is opened again.

## D-035: The trade journal replaces the orders and history tabs; a win is a sell with a gain

**Status:** Active (11.11.2026). Built: `GET /me/journal` ([api/src/tradeJournal.ts](../api/src/tradeJournal.ts), [docs/API.md](API.md)), the screen at [src/app/journal.tsx](../src/app/journal.tsx) with its logic in [src/journal/](../src/journal/). No migration. Tested in [api/test/journal.test.ts](../api/test/journal.test.ts) (the endpoint) and [api/test/app-journal.test.ts](../api/test/app-journal.test.ts) (the screen's texts).

**Decision:**
- **One page, "יומן" (user).** The disabled "פקודות" and "היסטוריה" tabs become one tab, the trade journal: every order the player sent, newest first. A filter shows all, waiting (`pending`), filled or rejected orders, so "my waiting orders" is the journal's "ממתינות" filter. The dashboard's and the trading screen's pending-order links open the journal on that filter. A row opens its stock on the trading screen (`/trade?symbol=`).
- **What counts as a win (default).** A filled sell whose stored gain at average cost (`orders.realized_pnl_ils`, D-019) is above 0 is a win, below 0 a loss, and exactly ₪0 neither. Success rate = wins ÷ (wins + losses), one decimal. A buy has no result until it is sold. Partial sells each count: selling a position in three parts is three results.
- **The results shown (user: "keep it simple").** The success rate (the inverse card), wins and losses, realized gain, average win, average loss, and how many orders wait with the cash they hold.
- **The period (user, 11.11.2026).** "מתחילת המשחק" (the default: the journal is every order the player sent; a week view opened empty for a player whose orders all ran in earlier weeks) = everything. "השבוע" = orders whose execution time is on or after Monday 00:00 of the world week, so a waiting order is always in it, and a sell sent on Friday that fills on Monday counts in Monday's week. The results and the filter counts follow the period, never the filter.
- **Money is read, not worked out (D-031).** Each row shows the fill the runner stored. The period's realized gain is the sum of the stored gain of its filled sells, in NUMERIC. For the whole game it equals `portfolios.realized_pnl`. The app formats; it adds nothing up.
- **Paging by order id.** 20 rows a page, "load more" asks for the orders sent before the last one shown. An id never changes, so a page always fits under the rows above it, even if an order ran in between.
- **Fresh enough without a push.** The screen reloads when the world clock passes an open or a close, and while an answer says an order is `due` (its time has passed but the runner hasn't run it yet) it asks again every 15 to 30 s, like the leaderboard's `behind`.
- **Named "trade journal" in code.** `journals` is already the money ledger's table (D-019), so the code says `tradeJournal` / `TradeJournal*` and the screen says "יומן".

**Why:**
- A player asks two questions about their orders: "what is still waiting?" and "how am I doing?". One list with a filter answers both, where two tabs would show the same rows twice.
- A filled sell is the only moment a result is known and stored. Counting positions instead (a win = a position closed at a gain) would give a player who never sells everything no result at all, and would need a new stored figure.
- The week is what the score is about, so it is what opens first; the whole game is one tap away.

**Known weaknesses:**
- **A sell at a gain can still be a bad trade.** The success rate ignores size: ten ₪10 wins and one ₪5,000 loss is 91%. The realized gain and the average win and loss beside it are there to show that.
- **No result for what you still hold.** Unrealized gains (the dashboard's holdings) are not in the journal's numbers.
- **Opening the journal doesn't mark rejections as seen** (D-023): a rejection already read in the journal can still show as a toast on the dashboard once.
- **The results are counted on each read.** One pass over the player's orders per request (`orders_uid_idx`). A player can send at most 5 orders a minute (D-028), so even a very active player has a few thousand rows. If that ever grew, the per-week results would become stored columns written by the runner.

## D-036: Usage monitoring: the check-in carries daily usage totals; a DB health card

**Status:** Active (11.11.2026). The design: `assignment/admin-monitoring-design.md` (a local plan: the `assignment/` folder is not in the repository, so it is not linked). Built (API): the tables in [api/migrations/20261111190015612_usage.sql](../api/migrations/20261111190015612_usage.sql) ([SCHEMA.md](SCHEMA.md#usage_pages_daily)), the report's check and write in [api/src/usage.ts](../api/src/usage.ts) (`POST /me/seen`), the reads in [api/src/monitoring.ts](../api/src/monitoring.ts) (`GET /admin/monitoring`, `GET /admin/db`, [docs/API.md](API.md)). Tested in [api/test/usage.test.ts](../api/test/usage.test.ts) (pure) and [api/test/monitoring.test.ts](../api/test/monitoring.test.ts) (the endpoints). Built (app): the counter in [src/usage/tracker.ts](../src/usage/tracker.ts), fed by [src/usage/useUsageTracking.ts](../src/usage/useUsageTracking.ts) and sent with each check-in by [src/auth/usePresence.ts](../src/auth/usePresence.ts); the page at [src/app/admin-monitoring.tsx](../src/app/admin-monitoring.tsx) ("ניטור"), drawn by [src/screens/AdminMonitoringScreen.tsx](../src/screens/AdminMonitoringScreen.tsx) with its words and chart math in [src/admin/monitoring.ts](../src/admin/monitoring.ts). The counter, the popup's funnel rules and when a failed report is sent again are tested in [api/test/usage-tracker.test.ts](../api/test/usage-tracker.test.ts), including that its reports pass the server's check; the page's sentences in [api/test/app-monitoring.test.ts](../api/test/app-monitoring.test.ts).

**Decision:**
- **Usage rides on the existing check-in.** `POST /me/seen` (D-026), sent every 60 s while the app is open and visible, now carries an optional body (`UsageReport`): time and views per player page, and the trade screen's confirm popup (opened, backed out), since the last check-in. No new request type, so traffic doesn't grow. No body = a plain check-in, so older app versions keep working.
- **Daily totals, not an event log.** Each report is added with an upsert to one row per player per page per day (`usage_pages_daily`) and, for the popup, one row per player per day (`usage_confirms_daily`). The tables grow with players × pages per day, not with clicks. One player's clicks can't be replayed; nothing needs them.
- **Real time, real Israel dates**, like visits (D-026). Postgres computes the day on write, and the admin reads take "today" from Postgres too, so a report written a moment ago always shows in today's numbers. The world clock plays no part.
- **Only the 4 player pages are tracked:** `dashboard`, `trade`, `journal`, `leaderboard`. Admin pages and login are not (an admin clicking around would skew a small player base). The list lives in code (`USAGE_PAGES` in the API, the same list in the app), not in a DB CHECK, so adding a page needs no migration. The reads skip any other name.
- **Time counts only while the tab is visible and someone used it in the last 5 minutes** (pointer, keys, wheel, touch, scroll; web). A tab left open overnight doesn't count as 8 hours. On phones only "app in the foreground" counts.
- **The server caps every report** (`parseUsage`): at most 120,000 ms of time per request for all pages together (scaled down by one factor when over; the app sends every 60 s), and each `views`, `opened` and `backed` at most 50. Below 0 counts as 0, fractions are cut. Unknown pages and unknown top-level fields are dropped. A body that is present but not shaped like `UsageReport` (not JSON, not an object, a known field of the wrong type or not a finite number) gets a 400, and nothing is written, not even the check-in.
- **Usage is written even when the presence check skips its write** (check-ins under 30 s apart write nothing to `users`). It is its own statement, after the presence transaction, so it never holds the `users` row lock longer.
- **A report is written whole or not at all, and sent again only when nothing was written.** Both tables are written by one statement (the pages upsert is a `WITH` part of the popup upsert), so a failure writes neither, and both parts share one date. The app puts a failed check-in's report back for the next check-in after no connection or an error answer (401, 404, 5xx), never after a 400 (it would be refused again forever) or after its own 10 s timeout (the server may still finish and write it, and sending it again would count it twice).
- **"Sent" comes from the `orders` table** (real `created_at`, by each order's status now), never from the app. Opened and backed out come from the app. Since D-037, "sent" counts only orders a player sent (`origin = 'player'`): a sell a stop loss made is counted on the page's stop-loss card instead, with how many players used a stop loss.
- **Backed out** = the popup closed without a send by the player's choice: "חזור", a tap outside or Escape, a change to the order while it was open (side, amount, security), or leaving the screen with it open. A send that fails and closes the popup is an error, not a back-out, and a successful send is not a back-out. Once the order went out, nothing that closes that opening counts as a back-out: not leaving the screen while the send is on its way, and not closing the popup after a send that got no answer (the order may be stored). A definite refusal that keeps the popup open (the rate limit, an id conflict) stored nothing, so backing out after it still counts. Sent orders can't be cancelled (game rule), so "cancelled" means backed out of the popup. The rules live in `ConfirmFunnel` (`src/usage/tracker.ts`), tested without a screen.
- **Ranges:** today, 7 days (today and the 6 days before) and 30 days (today and the 29 days before), each from midnight Israel time. The usage chart has 30 daily bars or 12 weekly bars, stacked by page; weeks start Monday, like the game's week (`date_trunc('week')`). Days and weeks with no usage are zeros, never missing.
- **`GET /admin/monitoring` runs one at a time per API process.** A request that arrives during a run (the retry button, a reload, a second admin) gets that run's answer instead of starting another, so the usage reads hold at most one pool connection per process. The reads collapse rows before counting distinct players (one row per page per player for the ranges; the 12 weeks' time per day and page, added up into the daily and weekly bars in TypeScript) and compare ids byte by byte (`COLLATE "C"`), not by the database's language collation.
- **`GET /admin/db` is its own endpoint**, so the page can refresh it every 30 s without re-running the usage queries. The page asks only while it is on top and visible: on the web the stack keeps a page mounted under the one a tab opened, and it must not go on asking from there. If Postgres is down, the admin check itself fails, so the card shows "אין חיבור למסד או לשרת" from the failed request instead of numbers. A 401 or 403 is not that (the server asked the database and refused the caller), so the card says the check was refused. A table Postgres never analyzed has no row estimate yet: its `rows` is -1 and the card says "not counted yet", never 0.
- **No SQL console.** Read-only status only, and no query text is ever returned (`pg_stat_activity.query` is never read).
- **No made-up numbers.** Before any usage exists, `since` is null and the cards say so.

**Why:**
- The brief's production-readiness part assumes you are away: whoever is on call needs to see how players use the app and whether the database is healthy without opening a SQL client.
- Riding on the check-in adds no requests, and daily totals keep the tables small at any click rate.
- The popup funnel shows whether the confirm step loses orders: how many players open it and walk away.

**Known weaknesses:**
- **The app reports its own time and clicks.** The server caps each report, so one request adds at most 2 minutes and 50 per count, but a modified client could still inflate its own numbers within those caps. Check-ins are not rate-limited, so a client that sends many requests can add more. These numbers are for the admin, never for scores or money.
- **The last minute can be lost.** A report travels with the next check-in; if the app is closed before that one gets through, up to a minute of usage is gone. So is a report whose check-in hit the app's 10 s timeout: the server may have written it, so it is not sent again.
- **A report can still count twice, rarely.** If the server writes a report and its answer is then lost on the network, the app sees no connection and sends the report again. That is the price of not losing every report sent while offline; each one is capped like any other.
- **Players are counted on each read.** The reads go over players × pages × days rows: up to 30 days for the ranges and the daily bars, 12 weeks (84 days) for the weekly bars. At 4,000 daily players on 3 pages that is about 1M rows for the 12 weeks; measured on local Postgres 17, the whole request takes about 1 s there and about 3 s at 3.4M rows (10,000 daily players on all 4 pages), under the API's 10 s statement timeout. Far beyond that it would need a daily rollup of distinct players.
- **Deleting a user scans the usage tables** for their rows, because neither primary key starts with `uid`. Users are deleted rarely and by hand, so there is no extra index.

## D-037: An optional stop loss on a buy, checked only at the open and the close

**Status:** Active (11.11.2026). Built (API): the table and columns in [api/migrations/20261111203926573_stop-loss.sql](../api/migrations/20261111203926573_stop-loss.sql) ([SCHEMA.md](SCHEMA.md#stop_orders)), the rules in [api/src/game/stops.ts](../api/src/game/stops.ts) (pure), the send check in [api/src/game/orderRules.ts](../api/src/game/orderRules.ts) (`checkStop`) and [api/src/orders.ts](../api/src/orders.ts), the runner's step in [api/src/runner.ts](../api/src/runner.ts) (`triggerStops`, `writeStops`, `expireStops`), the reads in `GET /me/trade`, `GET /me/dashboard`, `GET /me/journal` and `GET /admin/monitoring` ([docs/API.md](API.md)). Tested in [api/test/engine-stops.test.ts](../api/test/engine-stops.test.ts) (pure) and [api/test/stops.test.ts](../api/test/stops.test.ts) (end to end). Built (app): the switch and price in the ticket and the order center (`StopLossField` in [src/components/trade/OrderTicket.tsx](../src/components/trade/OrderTicket.tsx), its ⓘ from `InfoButton`), the preview check (`checkStop` in [src/trade/orderCheck.ts](../src/trade/orderCheck.ts)), the stop on the pending and holding cards, the journal's sentence, the stop-sale toast, and the admin's stop-loss card.

**Decision:**
- **Optional, on a buy only.** The ticket has a "סטופ לוס" switch, off by default. On, the player sets a price in the stock's own currency (₪ for Tel Aviv, $ for New York), sent with 2 decimals as `stopPrice`. It must be **below the latest close the screen shows** (the latest close of the market's last closed day): a stop at or above it is refused (`STOP_NOT_BELOW_PRICE`), and so is any stop while no close is known (`STOP_NO_PRICE`). A sell can't carry one.
- **The ticket's stop is the position tool's stop.** Dragging the chart's stop line, typing in the order center's "סטופ" field and typing in the ticket all move the same value. While the switch is on, a new price (a market event) doesn't reset the tool, so a stop the player chose never moves without them; a new security does.
- **Checked only at the open and the close.** The game trades only at those two prices (rule 3, D-012), so a stop is checked at every open and close of its market after its buy filled, never at the event where its own buy filled. It **fires** when that event's price is at or below the stop. A dip during the day that recovers by the close doesn't fire it. **The ⓘ beside the switch says so before the player turns it on**, and the line under the switch always says "נבדק רק בשער הפתיחה והסגירה".
- **A fired stop sells at that event's price**, like any sell at that event (and at that event's USD/ILS rate), so a gap down sells **below** the stop, as a real stop-market order would. If the buy itself filled at or below its stop (the price gapped past it before the buy ran), the stop fires at the first check, whatever the price, as a broker would.
- **It sells the units its buy got**, at most the position's free units (units not locked by a pending sell). Selling by hand leaves it less to sell. Several stops on one position share its free units, the highest stop first. A stop whose units are all locked by a pending hand sell **waits** and is checked again at the next event.
- **A closed position takes all its stops with it.** When a position closes (sold by hand, or by one of its stops), every stop still active on it **expires** at that open or close. This is a rule of the database, not only of the runner, so nothing can leave an active stop on a closed position: a trigger expires them as the position's status turns `closed`, and a stop written as active on a position that is already closed is stored expired ([api/migrations/20261111215659598_stop-loss-closes-with-position.sql](../api/migrations/20261111215659598_stop-loss-closes-with-position.sql)). The second trigger locks the position row, so the two can't miss each other when two transactions write at once, and the migration expires any such row written before it. A buy in the same stock after the close opens a new position, with only its own stop.
- **Fixed once sent.** A stop can't be cancelled or moved, like the order that carries it (D-004, the brief's rule 3). Selling the units by hand is the way out.
- **The runner reuses the order pipeline.** At each event, before the orders, `triggerStops` turns every stop the event's price reached into a pending sell due at that event (`orders.origin = 'stop'`, `stop_id`), locks its units like a hand sell, and marks the stop `triggered`. The event's order batches then run those sells through the same pure engine, journals and ledger checks as any sell. A buy that fills with a `stop_price` makes its `stop_orders` row in the same batch transaction (`writeStops`). The stops are paged by id in transactions of the batch size; a fired or expired stop is no longer active, so a re-run after a crash never fires one twice (D-021). The stops are planned **once per event**, before its orders: once an order batch of the event has committed, a re-run skips them. Planning again would see positions those batches already changed (a buy merged in, a hand sell gone) and could fire a stop that rightly waited, so a crash would change the result.
- **A stop's sale isn't an order the player sent.** It doesn't count toward the 5-a-minute limit (D-028), nor toward "sent" on the monitoring page (D-036). The ₪100 minimum doesn't apply (the runner never checks it).
- **The player is told.** A toast on the dashboard ("הסטופ לוס הופעל": what was sold, at which price against the stop, the ₪ received and the result), marked seen through `POST /me/rejections/seen` like a rejection (D-023, D-031). The journal says "נמכרה בסטופ לוס ₪95.00"; a buy that carries a stop names it. The pending card and the holding cards show the stop.
- **The admin sees who uses it.** The monitoring page's stop-loss card, for the picked range: how many players sent a buy with a stop loss (and what share of the players who bought), how many buys carried one, how many stops fired and their result together; and how many stops are active right now, held by how many players. All from the `orders` and `stop_orders` tables, never from the app.

**Why:**
- A stop loss is the first risk tool real traders learn, and the brief's game has none. It gives a reason to come back after the clock moves: to see whether the stop fired.
- Checking only at the open and the close keeps one rule for every trade in the game, and needs no intraday data we don't store (D-012). Saying so before the switch is turned on keeps the player from expecting a broker's intraday stop.
- Reusing the order pipeline means the money moves through the code already proven by the ledger checks: nothing new writes cash.

**Known weaknesses:**
- **A buy that runs just before a sale of everything keeps the position open.** If a player sends a buy of a stock and then a sale of every unit they hold, both for the same open or close, the buy runs first (orders run in the order they were sent, D-029): the sale leaves the buy's units, the position never closes, and the old stops stay on it (they never sell more than the position's free units). Sent the other way round, the sale closes the position first and the buy opens a new one with only its own stop. Fixing it would mean tracking each buy's units (lots) or running sells before buys, for a case that needs two opposite orders at one price.
- **A dip during the day is never seen.** A stock that fell through the stop at noon and closed above it keeps its stop. That is the game's rule for every trade, and the ⓘ says it, but it isn't how a broker's stop works.
- **The stop can't be moved.** A player who wants a tighter stop has to sell and buy again.
- **Stops are checked for every active stop of the market at every event.** A small partial index (`stop_orders_active_idx`) holds only active stops, so the cost grows with active stops, not with history.

