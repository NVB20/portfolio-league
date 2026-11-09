# API

The app never talks to Postgres. Every read and write goes through our API (`api/`, Hono on Railway).
The app calls it with `apiFetch` ([src/api.ts](../src/api.ts)), which adds the player's Firebase token.

- **Base URL:** `EXPO_PUBLIC_API_URL` (local: `http://localhost:3000`)
- **Auth:** every `/me` route needs `Authorization: Bearer <Firebase ID token>`. The API checks the token itself ([api/src/auth.ts](../api/src/auth.ts)). The user is always the one in the token, never one named in the request.
- **Body limit:** 16 KB. **Errors:** `{ "error": "..." }`, never a stack trace.
- **Types:** the JSON shapes live in [api/src/contract.ts](../api/src/contract.ts), shared by the API and the app.

## What saves data

Only these write to the database. Everything else is read-only.

| Who | Writes | Tables / columns | Can a player change it? |
|-----|--------|------------------|-------------------------|
| `POST /me` | creates the user and the portfolio on first login, refreshes email and name after | `users` (uid, email, display_name), `portfolios` (₪1,000,000 cash) | Only their own row, only those fields. Never `roles`, never cash |
| `PATCH /me/theme` | the dark/light choice | `users.theme` | Yes, only that column |
| `PATCH /me/chart-settings` | the full chart's settings | `users.chart_settings` (JSONB, known keys only) | Yes, only that column |
| `npm run seed:world` (script, not an endpoint) | the 40 securities, their daily open/close, the USD/ILS rate, the clock's start | `securities`, `prices`, `usd_ils`, `world_clock` | No. Run by a developer with the database URL |
| SQL by hand | player roles (`admin`) | `users.roles` | No. Never through the API |

**Coming with the game engine** (not built yet):

| Route | Will write |
|-------|-----------|
| `POST /me/orders` | a `pending` row in `orders`. It can't be changed or cancelled after |
| `POST /admin/clock/advance` (admin only) | `world_clock`, then in one transaction: executed/rejected `orders`, `portfolios.cash`, `holdings`, `portfolio_snapshots`, `standings` |

Players can never write cash, holdings, prices, the clock, scores or roles (D-001).

## Routes

### `GET /health`
No auth. `{ "ok": true }` when the API is up and can reach Postgres. For Railway's health check.

### `POST /me`
Called by the app right after login. Creates the user (role `user`) and the portfolio the first time.
Returns `{ email, roles, theme }`.

### `GET /me/dashboard`
Everything the dashboard shows, in one request: clock, portfolio value and chart, holdings, the next pending orders, USD/ILS, standing, leaderboard top 5. Read-only. 404 before `POST /me`.

### `PATCH /me/theme`
Body `{ "theme": "dark" | "light" }`. Other fields are ignored. Returns `{ email, roles, theme }`.

### `GET /me/trade`
Everything the trading screen shows, in one request. Read-only. Returns `TradeView`:

- `clock`: world time and whether TASE / US are open (null before the world starts)
- `cash`, `totalValue`
- `usdIls`: the latest known rate
- `securities[]`: the 40 securities, each with the latest close **already known in world time** (D-009), the day change, the last 11 closes (the 10-day chart), your holding and weight, and `execution`: when an order sent now would run (today's close if its market is open, otherwise the next open)
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
