# Portfolio League (ליגת תיקים)

A weekly stock-trading game. Each player gets a virtual ₪1,000,000, buys and sells TASE and US stocks, and competes on a weekly leaderboard. Built as a home assignment for House of Finance ([the brief](assignment/ASSIGNMENT.md)).

- **Live link:** TODO
- **How to get admin rights (to move the clock):** [below](#how-to-advance-the-clock)
- **Every decision, in full:** [docs/DECISIONS.md](docs/DECISIONS.md) (each `D-0xx` in this README points there)

---

## What I built, and why

| | What | Status |
|---|------|--------|
| The game | Sign up (email or Google), a dashboard, a trading screen with a full chart, orders by the rules, a shared world clock | Built |
| The engine | Order execution at each open and close, the 20% rule, the USD/ILS conversion, a double-entry ledger | Built, 486+ API tests |
| Leaderboard | The weekly table: your place, the podium, the top 20, "around me", past weeks; the dashboard's place and top 5 (D-032). The engine scores every player who is competing at every open and close, and writes the week's final board at its last event (D-034) | Built |
| Retention feature | TODO | TODO |
| Admin side | World clock buttons, engine health, players online, day-1 / day-7 return, action log | Built |
| Production | CI (tests on every PR, Docker image on every merge), retry-safe engine, measured load | Partly built, see [Production readiness](#production-readiness) |

**Why this shape.** The role is 60% development and 40% production, and the worst bug a trading game can have is one that creates or loses money. So most of the time went into the part players never see: an engine that can't create money, can't run an order twice, and keeps running when nobody is watching. The screens read stored numbers and never add money up themselves.

**The stack** is the team's: Expo (React Native) + TypeScript, and Firebase for login. Game data lives in Postgres behind a TypeScript API (Hono), not in Firestore:

```
App ──login──▶ Firebase Auth ──JWT──▶ App ──request + JWT──▶ API ──SQL──▶ Postgres
```

- **Firebase knows who you are; the API decides what you may do.** The API checks the token on every request. Players can only create pending orders; they can never write cash, holdings, prices, the clock or scores.
- **Why Postgres and not Firestore:** money needs transactions across several rows, constraints that refuse bad data, and `NUMERIC` instead of floats. And trusted game logic in Firebase means Cloud Functions, which needs the paid Blaze plan (the brief: no credit card).
- **Money is double-entry (D-019).** Every cash movement is a journal whose entries add up to exactly 0. The database refuses a transaction that doesn't balance, and the ledger is append-only. After every open and close, the engine checks each stored balance against the ledger and flags any mismatch on the admin page.
- **The game logic is pure TypeScript** (`api/src/game/`), with no database inside, so every rule is unit tested, including 300 random batches reconciled against the ledger.

## How I built the world, and why

**Real prices, downloaded once.** A one-off scraper (`scraper/`) took 3 years of daily open and close from Yahoo Finance (2023-11-06 to 2026-11-05) for USD/ILS and 40 large stocks, and `npm run seed:world` copies them into the game's tables (D-002, D-003).

- **40 securities, not 20** (D-011): 20 TASE (Teva, Elbit, Leumi, Nice, Tower...) and 20 US (NVIDIA, Apple, Microsoft, Berkshire...). The brief asks for 20; I kept all 40 I downloaded so each market has a real choice of sectors. Cutting to 20 is one list in [api/src/world/securities.ts](api/src/world/securities.ts).
- **Why real history and not simulated prices:** realistic charts, real correlations between stocks and the dollar, and every number can be traced to a real market day. There is no price model to defend.
- **The calendar comes from the data** (D-016). A weekday with no prices is a closed day, and each of the 187 closures is named by hand ("Passover", "Thanksgiving", "TASE closed on Fridays until 2026"). The two markets differ on 181 days, so each security shows its own market's status.
- **The clock** starts on Monday 27.11.2023 at 09:00 Israel time (D-013): 20 days into the history, so the first day already has past closes to show, and on a Monday so the first week is a full week. It ends when the history ends (05.11.2026), about 154 game weeks.
- **Orders use our stored open/close only.** The full chart shows Yahoo's daily candles, fetched live and cut at the world's "today" (D-012). If Yahoo goes down, only the chart breaks; money and scores never touch Yahoo.

**The price of real history:** the future is public. A player who knows the world's date can look up what happened next. See [Rules I think are bad or exploitable](#rules-i-think-are-bad-or-exploitable).

## How to advance the clock

Everyone lives on one world clock in Israel time. It moves in three ways (D-017, D-030):

1. **"To the close":** if a market is open, jump to its next close (TASE 17:30, Friday 13:50; US 16:00 New York time).
2. **"To the next open":** if both markets are closed, jump to the next open, skipping weekends and holidays.
3. **Running:** when nobody jumps, world time runs at real speed. A ticker inside the API runs every minute and executes every open and close the clock passes.

Every move first runs all the opens and closes on the way, in order, and only then moves the clock. A clock move never skips an event.

**Where:** the admin side (avatar menu → "מעבר לצד הניהול"), the world clock card: advance (press twice to confirm), start, stop. Each move is logged with who made it.

**Admin rights are given only with SQL.** No endpoint can change a role, so a player can't make themselves admin:

```sql
UPDATE users SET roles = '{admin,user}' WHERE email = 'you@example.com';
```

**For reviewers:** TODO (a ready-made admin account, or send me the email you signed up with and I'll run the line above).

## Rules I completed

The brief leaves gaps on purpose. These are the ones I filled.

| Rule | My decision | Why |
|------|-------------|-----|
| Start with ₪1,000,000 | The portfolio is created with the user, in the same SQL statement, on first login (D-008). Portfolios never reset; only the score is weekly | A user without a portfolio would be a special case on every screen. Resetting every week would erase what players built |
| Buy by ₪ amount, fractions allowed | Buys are a ₪ amount. **Sells are always units**; the app turns a typed ₪ amount into units (D-018). Units to 8 decimals, rounded down; money to the agora (D-019) | Units are what you own, so locking and selling them is exact: a pending sell can never ask for more than you hold |
| Order size | Minimum ₪100, except a sell of every unit you hold (D-014, D-028) | Fractions make ₪1 orders possible: noise and spam. Without the exception, a position worth ₪60 could never be closed |
| Fees | None | The brief doesn't mention any, and fees would only add noise to a weekly ranking |
| "The market is open" | Each security follows its own market's calendar, holidays included (D-016, D-022) | The two markets have different holidays; on 181 days only one of them trades |
| Sent while open → that day's close | Yes. An order sent while the engine is already running that close goes to the next open (D-029) | An order can't slip into a close that is already being executed |
| Sent while closed → next open | The next open of *that security's* market, skipping its holidays | The brief's rule, read per market |
| Can't cancel | The order is stored as pending; its cash (buy) or units (sell) are set aside when sent (D-019) | You can't spend the same shekel twice while an order waits |
| No short selling, no leverage | Checked when sent (free cash, free units) and again at execution (D-028) | Refuse what is certain immediately, instead of in a toast after the close |
| 20% "at the moment of purchase" | Checked when sent (counting your other pending buys of the same stock) **and again at the execution price**. Portfolio value includes reserved cash. A holding that grows past 20% by rising is allowed; we never sell for you, except a stop loss you set (D-020, D-028) | "The moment of purchase" is the execution, not the send: a stock at 19% when sent can be 21% at the close |
| Stop loss (not in the brief) | Optional on a buy: a price below the latest close. It is checked **only at the open and the close**, like every trade: the first open or close at or below it sells the units that buy got, at that price (a gap sells below the stop). It can't be cancelled or moved; selling by hand makes it expire. The ⓘ beside the switch says this before you turn it on (D-037) | The first risk tool real traders learn. One rule for every trade, and no intraday prices we don't have (D-012) |
| US stocks in dollars | Converted at the open rate at an open, the close rate at a close. A missing rate day uses the latest earlier close (D-029) | "The rate at the moment of execution", with the data we have |
| No price for a stock that day | The order is rejected (`NO_PRICE`) and its cash or units come back (D-029) | No price, no trade. The player sees why in a toast (D-023) |
| Early-close days (holiday eves, US half days) | Use the normal hours (D-016) | We have one open and one close per day; there is no 13:00 price to fill at |
| TASE before 2026 | Monday to Thursday until 02.01.2026, then Monday to Friday (D-013) | TASE traded Sunday to Thursday until 2026; Yahoo has no Sundays, and the game week is Monday to Friday |
| Portfolio value during the day | Each holding is valued at its latest open or close (D-024, D-031) | Prices only exist at opens and closes |
| The week | Monday's first open to Friday's last close. Return and max drawdown are measured at every open and close (D-024) | The only moments the value can change |
| Who is ranked | Everyone who holds a stock now, plus everyone an open or close touched this week (they held a stock at it, or an order of theirs was due at it). A player who only holds cash and did nothing this week isn't ranked. A player who sold everything this week stays, with the numbers they locked in (D-034) | An idle sign-up isn't competing. In a falling week, a crowd of untouched cash accounts (return 0, drawdown 0) would fill the podium |
| Players holding a stock that nothing touched yet this week | Return 0, drawdown 0 (D-024) | Their value didn't move |
| Players holding one market's stocks | One board for everyone. A player with only US stocks is on it from Monday's first event: their numbers wait for New York's open, but their place can move as other players' numbers change (D-032) | The brief has one weekly leaderboard, and until New York opens a US-only portfolio really hasn't moved (D-024) |
| Mid-week joiners | Ranked from the open or close where their first buy fills. Their week's return counts from their value before that trade (₪1,000,000 for a new player) (D-034) | No special case: it is the same weekly reset every player gets |
| Ties inside a percentile | Your rank is the share of the *other* ranked players you did at least as well as. Tied players share the higher percentile, so the best return and the smallest drop always get 100 (D-034) | The brief says 100 = the highest and 100 = the smallest drop. With the usual `percent_rank()`, a tie at the top would score below 100, and every Monday morning many US-only holders tie at 0 / 0 |
| Rounding | Each rank, and the score, to 2 decimals, half away from zero, computed exactly (integers, no floats). The score is taken from the two rounded ranks (D-034) | The API returns each rank and the score to 2 decimals, so a row can be checked with a calculator against those numbers, and the database and the tests agree to the last digit. The screens round them: the table shows the ranks and the score to 1 decimal, and the score card writes ≈ when its rounded numbers don't add up |
| Equal scores | No shared places: equal scores are broken by % gain, then the smaller drawdown, then the earlier sign-up (and the user id for two sign-ups in the same microsecond) (D-032, D-034) | Each place is one player, so "you are #12" means one thing. Only percentages decide, never ₪ amounts, so a bigger portfolio has no edge |
| How often the board updates | At every open and close, up to 4 times a day, in the same transaction that finishes the event. The week's final board is written at its last event (Friday's last close, or earlier on a holiday or at the end of the history) (D-034). An open leaderboard screen asks again every 15 to 30 seconds while the clock has passed an open or close that isn't scored yet (D-032) | Values only change at opens and closes. A crash re-runs the scoring together with the event, so the board never lags behind a finished event. The ticker runs a passed event up to a minute later, so the screen's own reload as the clock passes an open usually comes too early |
| Order rate | 5 orders per minute per player (D-021, D-028) | Protects the order queue from one player's script |
| Who moves the clock | Admins only. Otherwise it runs at real speed. It stops at the end of the price history (D-017) | One shared clock for everyone, and the game must not freeze while the admin is away |
| Names on the leaderboard | The display name from the sign-in, never the email (D-010) | Every player sees the leaderboard; emails are private |

## Rules I think are bad or exploitable

1. **Real history means a known future.** With real prices, anyone can look up what a stock did after the world's date. Fixes, from cheap to real: hide the year and shift dates; disguise the names; or, in production, run on live markets with real time, where nobody knows the close.
2. **A ₪100 ticket and the rest in cash wins stability.** Cash has a drawdown of 0. Players who never trade aren't ranked (D-034), but a single ₪100 buy puts a player on the board with a return and drawdown of almost 0. That nearly tops the stability rank (15% of the score), and in a falling week a return of almost 0 also beats most players. Fix: a minimum invested share to be ranked, or stability measured against the money invested.
3. **Rank beats size, so the best strategy is maximum risk.** The score uses percentiles, not returns: being first by 0.1% scores the same as first by 20%. The best play is 5 positions of 20% in the most volatile stocks. The 15% stability weight barely pushes back. Fix: give stability more weight, or score risk-adjusted return (a Sharpe-like ratio).
4. **Sell everything after a good start, and the week is locked.** A player up 5% on Tuesday can sell everything: the return stops moving and the drawdown can't grow until Friday. Fix: weigh the return by the time the money was invested.
5. **Joining late means fewer chances to drop.** A player whose first buy fills on Thursday has only one or two opens and closes of drawdown, so a small drop and a high stability rank. Fix: rank only players who held stocks from the week's first event, or scale by the days played.
6. **Many accounts, one winner.** Sign up 10 times with 10 different bets, and one of them tops the weekly table. Fix: one account per verified phone number for anything with a prize.
7. **20% only at purchase** lets a portfolio drift to 50% in one stock that rose. That's fine for realism (I kept it), but then "20%" is really an entry rule, not a diversification rule.

## What I gave up, and why

| Gave up | Why |
|---------|-----|
| Firestore and Cloud Functions | Trusted logic needs the paid Blaze plan; money needs SQL transactions and constraints |
| Redis or a job queue (BullMQ) | Postgres already gives ordering, locking and retries. One less service to run while I'm away (D-021). pg-boss is the next step for independent jobs (notifications, emails) |
| Intraday prices | Only daily open and close are stored, and the brief only fills orders at those two moments. Drawdown is measured at opens and closes, so a dip and recovery within a session is invisible |
| Cancelling orders | The brief forbids it |
| The full chart on phones | It needs a web view on native; on phones the trading screen shows the simple chart |
| Choosing a display name | It would need an abuse check; the name from Google is enough for now |
| English switch, email verification, onboarding | TODO: still on the list ([PROGRESS.md](assignment/PROGRESS.md)); the English switch is cut first if time runs out |

## The retention feature

TODO: which feature, why this one, how it works.

**How I'll know it works:** the measuring is already built. The app checks in once a minute while it's open; a check-in after 30 minutes away starts a new visit, and the server decides that, not the app (D-026). The admin page shows active players per day, players who came back several times today, and **day-1 and day-7 return** for the last 30 days of sign-ups (D-027). The feature works if those numbers go up for players who use it, compared with players who don't.

## Production readiness

The brief: thousands of players, many at once (market open, after a push); other developers pushing every day; and me on vacation next week.

### Thousands at once

- **Sending an order is cheap and never waits for other players.** It's one short transaction that locks only that player's portfolio row. Nothing executes at send time, so a rush at market open only adds pending rows (D-021).
- **Execution happens at clock events, in batches**: orders in batches of 500, then only the players that event affects (a TASE close never touches a US-only player), online players first, in batches of 5,000 (D-021).
- **Reads never wait for the engine.** A player who opens the app mid-event is brought up to date on the spot, and if their row is busy, the read shows the stored values instead of waiting (D-025).
- **Measured** on one API instance with 50,000 players: 2,000 dashboard reads at once all answered in 3.5 s, and in 12 s right after a close, with no failures. One instance serves about 550 to 600 dashboard reads a second (D-031).
- **Next steps when that's not enough:** fewer queries per read and a 1-second cache for what is the same for everyone; more API instances (they share the work safely); PgBouncer; and the engine in its own worker service.

### Other developers pushing every day

- **CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)): every pull request into `main` runs the API type check and the full test suite against a real Postgres. Every merge to `main` builds the API's Docker image and publishes it to GHCR, tagged with the commit.
- **The game logic is pure functions with tests** for every rule, including adversarial ones written after a review that found and fixed 23 issues.
- **The database protects itself:** constraints, foreign keys, a ledger that refuses unbalanced journals. A bug in someone's new endpoint can't create money.
- **Schema changes are migrations** that are never edited after they run, and each one updates [docs/SCHEMA.md](docs/SCHEMA.md).
- TODO: protect `main` (pull requests only, checks must pass); deploy only from CI.

### Me on vacation

- **The clock runs without me.** The ticker executes every open and close within a minute.
- **Crashes heal themselves.** Every step is safe to retry. After a crash or a deploy, the next tick resumes the event at the step where it stopped, and an order never runs twice (D-021, D-030).
- **One engine at a time** (a Postgres advisory lock), even with several API instances.
- **A lost database connection fails one query, not the API process** (D-029).
- **A ledger mismatch doesn't stop the game.** It's logged with the players' ids and shown in red on the admin page. Freezing the game for everyone while nobody can fix it would be worse (D-029).
- **The admin page shows what's wrong:** the ticker's heartbeat (red after 2 minutes without one), the engine's last run, events that are due but not done, the ledger check.
- TODO: alerts that wake someone up (uptime check, ticker heartbeat), a runbook, daily backups.

## Run it locally

Needs Node 22 and Docker.

```bash
npm install
docker compose up -d                # local Postgres
docker compose run --rm scraper     # download the prices (once)

cd api
npm install
npm run migrate:dev                 # create the tables
npm run seed:world                  # copy the 40 securities, prices, USD/ILS and the clock start
npm run seed:sample-board           # dev only: a made-up leaderboard before any real trades (D-033); -- --clear removes it
npm run dev                         # the API on :3000 (reads api/.env)
npm test                            # the API tests

cd ..
npx expo start --web                # the app
```

## More

| Doc | What's in it |
|-----|--------------|
| [docs/DECISIONS.md](docs/DECISIONS.md) | Every decision: what, why, known weaknesses |
| [docs/API.md](docs/API.md) | Every endpoint |
| [docs/SCHEMA.md](docs/SCHEMA.md) | Every table |
| [docs/tech-stack.md](docs/tech-stack.md) | Who handles what |
| [assignment/PROGRESS.md](assignment/PROGRESS.md) | What's done and what's next |
