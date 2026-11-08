# Decisions

Gaps in the brief, and the choices we made. Each entry: what we decided, why, and what would make us change it.

## D-001: Trusted game logic runs in our API

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

**Status:** Active (planned for Phase 5).

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

**Open:** Let players choose a name (and check it for abuse).
