# Decisions

Gaps in the brief, and the choices we made. Each entry: what we decided, why, and what would make us change it.

## D-001: Trusted game logic runs in our API

**Status:** Active. The "one transaction" part is replaced by batches (D-021).

**Decision:** Players can only create *pending* orders. When an admin advances the world clock, the API (`api/`, on Railway) runs the execution logic and writes trades, cash, holdings and snapshots to Postgres in **one transaction**. Only users with the `admin` role can call it.

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
- A person still has to advance the clock. A Railway cron job could do it on a schedule later.
- One API service and one database node on Railway Hobby: no built-in backups or uptime monitors (Phase 7 adds a `pg_dump` cron and an external uptime check).

## D-002: Local Postgres (Docker) for development

**Status:** Active. Changed 07.11.2026: it now also holds the app's local databases.

**Decision:** A Postgres container, run with `docker compose`, holds three databases on the developer's machine:
- `prices`: 3 years of daily open/close prices for USD/ILS (`ILS=X`), 20 large TASE stocks and 20 large US stocks (NYSE + NASDAQ). A one-off scraper container (`docker compose run --rm scraper`) fetches them from Yahoo Finance. The game uses 20 of these 40 stocks (brief: "20 stocks or funds").
- `portfolio`: the app's data when the API runs locally (`cd api && npm run dev`).
- `portfolio_test`: wiped and refilled by the API tests (`cd api && npm test`).

**Why:**
- We fetch the prices once and keep them, so we don't call Yahoo again every time we develop.
- SQL tables are the most structured way to store them. `daily_prices` has the key `(symbol, day)`, so there's one row per security per day, no duplicate days, and the types are checked.
- Developing against the same database engine as production (Postgres on Railway) catches SQL problems early.

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

**Status:** Temporary. Phase 2 decides intraday pricing.

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

## D-013: The world starts on Monday 6 November 2023, 09:00 Israel time

**Status:** Active. Changed 09.11.2026 (was Monday 5 January 2026). Easy to change before launch: `UPDATE world_clock ...`.

**Decision:** The world starts on the first day of the price history: 2023-11-06, 09:00 Israel time, one hour before TASE opens. Every one of the 40 securities and USD/ILS has data from that day. `npm run seed:world` sets the clock only if it was never set.

**Why:** It uses all 3 years of history (about 150 game weeks) instead of the last 43.

**Known weaknesses:**
- Until 2026, TASE traded Sunday to Thursday. Yahoo has no TASE Sundays, and TASE was closed on Fridays. So in the game, TASE trades **Monday to Thursday until 2 January 2026**, then Monday to Friday. The calendar (D-016) records this.
- The game ends when the history does (TASE 2026-11-04, US 2026-11-05) unless we scrape again.

## D-014: The smallest order is ₪100

**Status:** Active in the app's preview (08.11.2026). The game engine will enforce it too.

**Decision:** Orders under ₪100 are refused.

**Why:** Fractional units make ₪1 orders possible. They add rows and noise and change nothing in a ₪1,000,000 portfolio. A floor also slows down order spam.

## D-015: Chart settings are saved per player

**Status:** Active (08.11.2026).

**Decision:** The full chart's settings (type, timeframe, range, background, colors, indicators) are saved in `users.chart_settings` (JSONB) through `PATCH /me/chart-settings`. The API keeps only known keys with allowed values. Tools like the ruler and the position tool are not saved.

**Why:** The same reason as the theme (D-007): the chart looks the same on any device. A strict whitelist means the column can't fill with junk or be used to store anything else.

## D-016: A market calendar table holds every weekday a market is closed

**Status:** Active (09.11.2026). Table not built yet.

**Decision:** A `market_closures(market, day, reason)` table has one row for every **Monday to Friday** on which TASE or the US is closed. Saturdays and Sundays are a rule in code and get no rows. The rows are seeded from the price data (a weekday with no price row is a closed day), then checked by hand and given a reason ("Passover", "Thanksgiving", "TASE closed on Fridays until 2026").

**What the data shows (2023-11-06 to 2026-11-04):**
- TASE: 156 closed weekdays. 112 of them are Fridays before 2026, and 44 are holidays.
- US: 31 closed weekdays.
- On 28 days only TASE is open, on 154 only the US is open (mostly the Fridays before 2026), and on 3 weekdays both are closed.
- In 2026 alone, the markets differ on 22 weekdays (for example, 01.04 to 02.04 TASE is closed for Passover while the US is open, and 03.04 the US is closed for Good Friday while TASE is open).

**Why:** The two markets have different holidays, so "is the market open?" depends on the day as well as the hour. A table makes the calendar visible and easy to fix by hand. Weekends never change, so they don't need rows.

**Known weaknesses:** A day missing from Yahoo by mistake looks like a holiday until someone checks it. Early-close days (US half days, TASE holiday eves) use the normal hours, because we only have one open and one close per day.

## D-017: The world clock runs in Israel time and moves in three ways

**Status:** Active (09.11.2026). Not built yet.

**Decision:**
- World time is shown and calculated in **Israel time**. US hours (9:30 to 16:00 New York) are converted, usually to 16:30 to 23:00 Israel time. For the few weeks a year when only one country is on summer time, the conversion moves by an hour.
- **Move 1, "to the close":** if a market is open, jump to its next close (TASE 17:30, Friday 13:50; US 23:00 Israel time).
- **Move 2, "to the next open":** if no market is open, jump to the next open. Weekends and days when both markets are closed (D-016) are skipped.
- **Move 3, running:** when no admin jumps, world time runs at real speed from where it was left. The clock row stores the world time and the real time it was set, so `now = world_at + (real now − real_at)`. When the running clock reaches a day when both markets are closed, it skips straight to the next trading day.
- Every move runs **all events in between, in time order**. At each open and close, it executes the orders due then and saves a value snapshot for every player.
- **Only admins** can jump the clock, including on the live link. The README explains how a reviewer gets the admin role. A ticker in the API (every minute) handles events the running clock passes. The clock never goes backwards.
- **End of history:** the clock stops at the last day with prices (US 05.11.2026). Moves past it are refused, and the game freezes there.

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

**Status:** Active. Rewritten 09.11.2026. Not built yet. Diagram and a worked example: [Portfolio League Money Model](https://claude.ai/artifact/FHvdTjTcr7Nohn5SmwQyuG).

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
  - After every clock event, a check confirms that each stored balance equals its ledger account. A mismatch stops the runner and raises an alert.
- **Positions** replace `holdings`. A buy from 0 units starts a new `open` row, and at 0 units it becomes `closed` and stays as history. A partial unique index allows only one open row per player per stock. Units are not money, so they live on `positions`; the executed orders (`filled_units`) can rebuild them.
- **Orders** carry the fill: `fill_price`, `fx_rate`, `filled_units`, `filled_ils`, `realized_pnl_ils`, `position_id`. There is no executions table, because every order fills once, in full, or is rejected. `client_order_id` is unique per player, so a retried request can't create a second order.
- **Profit is measured at average cost.** A sale's gain = units sold × (execution price × rate − average cost per unit). A sale never changes the average; only a buy does.
- **Unrealized gain** = market value − cost basis. It is not a ledger entry, because nothing was paid or received. The runner updates it at every open and close (prices only change then) and stores it.
- All money and units are `NUMERIC`: ₪ to agorot, units to 8 decimals.

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

**Status:** Active (09.11.2026). Not built yet.

**Decision:**
- **When sent:** checked with the last known price. A breach is refused, and the preview shows it.
- **When executed:** checked again with the real execution price: (current holding value + buy amount) ÷ portfolio value, both at that moment's prices, must be ≤ 20%. Portfolio value counts all cash, including reserved cash. A breach rejects the order, releases its cash and gives the reason ("would be 21.3% of the portfolio").
- Several buys of the same stock at one event are checked one by one, in the order they were sent.
- We **never** sell on the player's behalf. A holding that grows past 20% because its price rose is allowed. The rule applies only at the moment of purchase.

**Why:** An order sent while the market is open fills at that day's close. A stock at 19% when the order is sent can be at 21% by the close. Only a check at the real execution price closes that gap.

## D-021: The orders table is the queue

**Status:** Active (09.11.2026). Not built yet. Replaces D-001's "one transaction per clock advance".

**Decision:**
- **Sending** is a short transaction that locks only that player's portfolio row, so players never wait for each other. The limit is **5 orders per minute** per player.
- **Sending vs. clock moves:** sending an order takes a shared lock on the `world_clock` row (`FOR SHARE`), and a clock move takes an exclusive one. An order sent at 17:29 can't slip in after the runner has already passed the 17:30 close.
- **Execution** happens at clock events, not when an order is sent. A rush of orders at market open only adds `pending` rows; nothing is executed in that rush.
- **The runner:** only one runs at a time (`pg_advisory_lock`). It takes pending orders due by the event (`executes_at`, then `id`) in batches of about 500 per transaction. Each order changes status as it runs, so after a crash a retry continues where it stopped and nothing runs twice. The clock moves to its new time only after every event in between is done.
- No Redis or BullMQ.

**Why:** Postgres already gives us ordering, locking and retries. A separate queue would be one more service to run and watch while we're away, with nothing gained at this size.

**What would make us change it:** if one event takes more than about a minute, or has more than about 100,000 orders, move the runner to its own worker service (still Postgres, with `FOR UPDATE SKIP LOCKED`).

## D-022: Each market's status comes from the calendar and is shown separately

**Status:** Active (09.11.2026). Not built yet.

**Decision:**
- `sessionOn`, `isMarketOpen`, `executionFor` and the clock moves all read the calendar (D-016). There is one answer to "is TASE open?", and the screens, the order engine and the clock all use it. Today `sessionOn` knows only weekdays, so it shows TASE open on holidays and on Fridays before 2026.
- The API returns each market's status: `open`, `pre_open`, `after_close`, `weekend` or `holiday`, plus the reason ("פסח", "Thanksgiving", "הבורסה בת״א סגורה בימי שישי עד 2026") and the next open time.
- **Dashboard:** the top bar shows two status chips, TASE and New York, each open or closed. When only one market trades that day, a line says so ("היום רק ניו יורק פתוחה · ת״א סגורה: פסח"). The world clock card shows "closed today" with the reason and the next open.
- **Trading screen:** each security shows its own market's status. When that market is closed, the ticket says when the order will run ("השוק סגור · יתבצע בפתיחה, יום ב׳ 10:00").
- The clock's "to the next open" move skips any day on which neither market opens.

**Why:** Players need to know before they send an order whether it fills at today's close or at a later open. On the 182 days when only one market trades, a single "market open" light would be wrong for half the stocks.

## D-023: A rejected order shows a toast

**Status:** Active (09.11.2026). Not built yet.

**Decision:** When an order is rejected, the player sees a toast with the reason the next time the app loads their data. A journal page that lists every rejected order comes later.

**Why:** A rejection happens at a clock event, usually while the player is away. Without a message they would only notice that their cash didn't change.
