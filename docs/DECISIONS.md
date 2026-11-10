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

**Status:** Active (planned for Phase 6).

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
- We **never** sell on the player's behalf. A holding that grows past 20% because its price rose is allowed. The rule applies only at the moment of purchase.

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
  5. **Finish:** write the daily chart rows and the median, and mark the event `done` (with the ledger check's result). Only then come the leaderboard update and the clock move.
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
- **Trading screen:** each security shows its own market's status. When that market is closed, the ticket says when the order will run ("השוק סגור · יתבצע בפתיחה, יום ב׳ 10:00"). At the end of the price history that open never comes: the API marks the execution `gameOver` (an order sent now is refused with `GAME_OVER`, D-028) and the trading screen's clock carries `endsAt`, so the ticket can say so instead of promising a time. (Added 10.11.2026 after review; the app's wording for it is still to be written.)
- The clock's "to the next open" move skips any day on which neither market opens.

**Why:** Players need to know before they send an order whether it fills at today's close or at a later open. On the 181 days when only one market trades, a single "market open" light would be wrong for half the stocks.

## D-023: A rejected order shows a toast

**Status:** Active (09.11.2026). API part built 10.11.2026: `GET /me/dashboard` returns the unseen rejections and `POST /me/rejections/seen` marks them seen (D-031). The app's toast is not built yet.

**Decision:** When an order is rejected, the player sees a toast with the reason the next time the app loads their data. A journal page that lists every rejected order comes later.

**Why:** A rejection happens at a clock event, usually while the player is away. Without a message they would only notice that their cash didn't change.

## D-024: Weekly running totals per player, not a snapshot of everyone

**Status:** Active (09.11.2026, decided in the admin-dashboard session). Written by the runner since 10.11.2026 ([api/src/runner.ts](../api/src/runner.ts)): the running totals, the lazy reset, the daily chart rows and the median per event (D-029). Replaces D-009: the dashboard and the trading screen read these columns (D-031).

**Decision:**
- **Running totals on `portfolios`:** `week_start` (the Monday), `week_start_value`, `peak_value`, `max_drawdown_pct`, plus `equity` (D-019) as the current value and `last_event_at`. At each event, for each affected player (D-021):
  - `peak = max(peak, value)`
  - `mdd = max(mdd, (peak − value) / peak)`

  Scoring reads these columns and never scans history.
- **Lazy weekly reset:** a row whose `week_start` is older than the event's week is reset the first time it is touched: `week_start_value` and `peak_value` become the value before the event, and the drawdown becomes 0. Nothing writes 1M rows when a week starts. `week_start` is a date, not a week number, because week numbers repeat every year.
- **Untouched players:** a row nobody touched this week means the player's value didn't change, so their return is 0 and their drawdown 0. All cash-only players tie, and scoring can count them as one group.
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

- **₪100 minimum, also for sells (D-014).** A buy under ₪100.00 is refused. A sell is valued at the position's last mark (units × last price × its USD/ILS rate; at average cost if it was never marked), and under ₪100 is refused, **unless it sells every free unit**. Without that exception, a position worth ₪60 could never be closed.
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

**Why:** Running before moving means the clock never shows a time whose events haven't run. The log in the same transaction is D-027's rule. Refusing when busy keeps admin requests short and predictable. The ticker is the brief's "you are on vacation": with nobody clicking, the running clock's opens and closes still run within a minute, and an event that crashed half way finishes on its own. The heartbeat lets the admin page tell "nothing is due" from "the ticker is dead". The ticker stays in the API process because it is one less service to deploy and watch. pg-boss is the next step for it (D-021).

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
- With more than 5 unseen rejections, the oldest wait: they come in the next read, once the newer ones are marked seen. There is no rejection history screen yet (D-023's journal page).
- The value shown is as of the latest open or close, while the day change % is from closes. During trading hours a holding's value is its open price and its day change is yesterday's.
- The median line has one point per open and close, and mine one per day. They share the axis but not the moments.
- Every read now does the catch-up's small query first, and a write when the player is behind.
- **Capacity under a burst.** A dashboard read is about 9 statements one after another, each its own pool checkout, on a 10-connection pool, so one API instance serves roughly 550–600 dashboard reads a second (measured at 50,000 players: 2,000 reads at once took 3.5 s for everyone, 5,000 took 9 s). Right after a close, when most readers also catch up, 2,000 reads took 12 s, but none failed (before the D-025 lock changes, 5 of them failed with a connection timeout and 879 catch-ups gave up). A burst much bigger than that per instance will hit the pool's 5 s wait for a connection. The next steps: fewer round trips per read (merge the portfolio, pending and rejection reads; cache for a second what is the same for every player, like the clock row and the week's median line), more API instances, or PgBouncer in front of Postgres.
