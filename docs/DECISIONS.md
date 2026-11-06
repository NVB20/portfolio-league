# Decisions

Gaps in the brief, and the choices we made. Each entry: what we decided, why, and what would make us change it.

## D-001: Trusted game logic runs in the admin's browser 

**Status:** Active. Planned to move to Cloud Functions later.

**Decision:** Players can only create *pending* orders. When an admin advances the world clock, the admin screen runs the execution logic in the browser and writes trades, cash, holdings and snapshots. Security Rules allow those writes for admins only.

**Why:**
- Cloud Functions need the Firebase Blaze plan (credit card). We're staying on the free Spark plan for now.
- Players still can't cheat: rules block them from writing cash, holdings, prices, the clock or scores.

**Known weaknesses:**
- Nothing runs unless an admin has the page open and clicks "advance clock".
- If the tab closes mid-run, some orders may execute and others not. Each order gets a `status`, so a retry skips orders that are already done.
- Slow for thousands of orders (Firestore allows max 500 writes per batch).

**How we'd move to Option A:** The execution logic is a pure TypeScript function with no Firebase inside:

```ts
executeOrders(pendingOrders, prices, usdIls, portfolios) → { trades, updatedPortfolios, rejected }
```

Today the admin screen calls it. To move, a Cloud Function calls the same function instead. That means changing only the wrapper, not the logic.

**When to switch:** Real players at scale, or the game needs to run on a schedule without a person.

## D-002: Local Postgres (Docker) holds historical prices for development

**Status:** Active.

**Decision:** A Postgres container, run with `docker compose`, stores 3 years of daily open/close prices for USD/ILS (`ILS=X`), 20 large TASE stocks and 20 large US stocks (NYSE + NASDAQ). A one-off scraper container (`docker compose run --rm scraper`) fetches them from Yahoo Finance. Both run only on the developer's machine. The game uses 20 of these 40 stocks (brief: "20 stocks or funds").

**Why:**
- We fetch the data once and keep it, so we don't call Yahoo again every time we develop.
- SQL tables are the most structured way to store it. `daily_prices` has the key `(symbol, day)`, so there's one row per security per day, no duplicate days, and the types are checked.

**Gotchas:**
- TASE prices from Yahoo are in **agorot** (`currency = 'ILA'`). Divide by 100 for ₪.
- The current day is never saved, because its "close" is only the latest live price.

**What it is not:** It is not part of the app. The Expo app never connects to it, so the "no custom backend" rule still holds. When the game needs the prices, we export them from Postgres into Firestore (or a JSON seed file).

**Known weaknesses:**
- Yahoo is unofficial, and FX "open/close" depends on Yahoo's day boundaries. The official Bank of Israel rate (שער יציג) only has one value per day.
- **Yahoo has no TASE Sunday data.** TASE traded Sunday to Thursday until January 2026, then moved to Monday to Friday. Before 2026, every Sunday is missing, so a TASE stock has about 627 days against about 753 for a US stock. From 2026 on, the data is complete.

## D-003: Game prices are real history, loaded once

**Status:** Active.

**Decision:** The 20 securities and USD/ILS use real daily open/close prices, downloaded once (see D-002 for how USD/ILS is kept) and loaded into Firestore from an admin screen.

**Why:** Realistic charts, and every number can be traced back to a real market day.

**Known weaknesses:** The game can only run as far as the downloaded history goes.

## D-004: Orders live in one top-level `orders` collection

**Status:** Active.

**Decision:** `orders/{orderId}` with a `uid` field, not `users/{uid}/orders`.

**Why:** When the admin advances the clock (D-001), one query finds every pending order. Security Rules let a player read and create only orders where `uid` is their own, and only with status `pending`.

## D-005: Holdings are stored inside one portfolio document

**Status:** Active.

**Decision:** `portfolios/{uid}` = `{ cash, holdings: { TICKER: units } }`. Units are floats (fractions allowed).

**Why:** A portfolio has at most 20 securities, so it stays small. The dashboard needs one read, and cash and holdings change together in one write, so they can never disagree. Only admins can write portfolios (D-001).

## D-006: The admin writes the weekly leaderboard

**Status:** Active.

**Decision:** When the admin advances the clock, scores are computed for everyone and saved to `leaderboards/{week}`. Players read only that document.

**Why:** Players never need to read each other's portfolios, so the rules keep portfolios private. One read per player instead of reading every portfolio.

## D-007: Dark/light theme is chosen by the user

**Status:** Active. Replaces DD-01 ("dark-only dashboard") in `design/dashboard/README.md`.

**Decision:** The avatar dropdown has a dark/light switch (next to logout). The whole app follows the chosen theme. The dashboard needs a light version.

**Where it's saved:** Each user's choice is saved in Firestore on their own user document (`users/{uid}.theme`: `'dark'` or `'light'`), so it follows them to any device. The color sets themselves live in `src/theme.ts`. Security Rules will let a user change only their own `theme` field, never `roles`.

**Why:** Phase 1 requires a dark/light theme. A user choice, rather than following the device setting, lets players pick what reads best for charts.
