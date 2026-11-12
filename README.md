# Portfolio League (ליגת תיקים)

A weekly stock-trading game. Every player gets a virtual ₪1,000,000, buys and sells TASE and US stocks, and competes on a weekly leaderboard. A home assignment for House of Finance ([the brief](assignment/ASSIGNMENT.md)).

**New here? Start with the slides: the whole project in a few minutes.**

[![Open the slides](https://img.shields.io/badge/Open_the_slides-FBBC04?style=for-the-badge&logo=googleslides&logoColor=black)](https://docs.google.com/presentation/d/1Nhv7syv3wnFSp8ics_yjgLhy1Dz1070k1_aTFB1j3O8/edit?usp=sharing)

- **Run it yourself:** `docker compose up --build`, then open http://localhost:8080 ([details](#run-it))
- **Admin rights, to move the clock:** [how](#how-to-advance-the-clock)
- **Every decision, in full:** [docs/DECISIONS.md](docs/DECISIONS.md)

---

## What I built

- **The game:** sign up (email or Google), a dashboard, a trading screen with a full chart, one shared world clock.
- **The engine:** fills orders at every open and close, by the brief's rules. 486+ tests.
- **The leaderboard:** the weekly table, scored at every open and close.
- **The admin side:** the clock, the engine's health, players online, day-1 and day-7 return.
- **Production:** tests on every pull request, a Docker image on every merge, an engine that is safe to retry.

**Why this shape:** the worst bug a trading game can have is one that creates or loses money. So most of the work went into an engine that can't create money, can't run an order twice, and keeps running when nobody is watching.

**The stack** is the team's: Expo (React Native), TypeScript and Firebase. Firebase knows who you are; the API decides what you may do. Game data lives in Postgres, because money needs transactions and exact numbers, and trusted logic in Firebase needs Cloud Functions on the paid plan.

```
App ──login──▶ Firebase ──token──▶ App ──request──▶ API ──SQL──▶ Postgres
```

## How I built the world

- **Real prices:** 3 years of daily open and close from Yahoo Finance, for USD/ILS and 40 stocks (20 TASE, 20 US). Downloaded once, stored in Postgres.
- **Why real history:** real charts and real links between stocks and the dollar, with no price model to defend.
- **Holidays come from the data:** a weekday with no prices is a closed day. Each market has its own calendar.
- **The clock** runs from Monday 27.11.2023 to 05.11.2026, about 154 game weeks.
- **The catch:** the future is public. A player can look up what a stock did next ([see below](#rules-i-think-are-bad-or-exploitable)).

## How to advance the clock

Everyone shares one world clock, in Israel time. An admin moves it from the admin side (avatar menu → "מעבר לצד הניהול" → the world clock card):

- **To the close:** jump to the next close of an open market.
- **To the next open:** when both markets are closed, jump to the next open.
- **Start / stop:** while running, the clock moves at real speed.

Every open and close on the way runs first, in order. A move never skips one.

**Admin rights are given only with SQL**, so no player can make themselves admin. After you sign up:

```bash
docker compose exec db psql -U hof -d portfolio -c "UPDATE users SET roles = '{admin,user}' WHERE email = 'you@example.com'"
```

## Rules I completed

| Rule | My decision | Why |
|------|-------------|-----|
| Buy and sell in ₪ | Buys are a ₪ amount. Sells are units: the app turns a ₪ amount into units | You can never sell more than you hold |
| Order size | At least ₪100, unless you sell everything | Stops ₪1 spam, and a tiny position can still be closed |
| When the market is open | Each stock follows its own market's calendar and holidays | The two markets close on different days |
| Sent while the close is running | Goes to the next open | It can't slip into a close that is already running |
| Can't cancel | The cash or units are set aside when the order is sent | You can't spend the same shekel twice |
| 20% per stock | Checked when sent and again at the execution price. A stock may grow past 20% later | "The moment of purchase" is the execution |
| Dollar rate | The open rate at an open, the close rate at a close | The rate at the moment of execution |
| No price that day | The order is rejected and the money comes back | No price, no trade |
| Early-close days | Normal hours | There is one close price per day |
| TASE before 2026 | Monday to Thursday | It traded Sunday to Thursday, and Yahoo has no Sundays |
| The week | Monday's first open to Friday's last close, measured at every open and close | Prices only exist at those moments |
| Who is ranked | Anyone who held a stock or had an order this week | Idle cash accounts would fill the podium in a falling week |
| Joining mid-week | Ranked from your first filled buy | The same weekly start as everyone else |
| Ties in a percentile | Tied players share the higher one | The best return always gets 100 |
| Equal scores | Broken by % gain, then the smaller drop, then the earlier sign-up | Every place is one player |
| Board updates | At every open and close | Values only change then |
| Order rate | 5 per minute per player | Protects the engine from scripts |
| Stop loss (extra) | Optional on a buy, checked only at the open and the close | The first risk tool traders learn |
| Names on the board | The sign-in name, never the email | Emails are private |
| Who moves the clock | Admins. Otherwise it runs at real speed | The game never freezes while the admin is away |

## Rules I think are bad or exploitable

1. **The future is public.** Real history can be looked up. *Fix:* hide the year and the names, or play on live markets.
2. **₪100 in a stock and the rest in cash** means almost no drop, so a top stability rank. *Fix:* a minimum invested share to be ranked.
3. **Percentiles reward maximum risk.** First by 0.1% scores the same as first by 20%. *Fix:* a risk-adjusted score.
4. **Sell everything after a good Tuesday** and the week is locked in. *Fix:* weigh the return by the time the money was invested.
5. **Many accounts, one winner.** Ten accounts with ten bets, and one tops the table. *Fix:* one account per verified phone number.

## Production readiness

- **Thousands at once:** sending an order is one short write, and nothing executes at send time. Orders run in batches at each open and close. On one API instance with 50,000 players, 2,000 dashboard reads at once were all answered in 3.5 s.

## Run it

Needs only Docker. No `.env` file, no keys.

```bash
docker compose up --build
```

Open **http://localhost:8080** and sign up. The first run takes a few minutes: it downloads the prices and plays a sample month with 40 players, so every screen has something to show. Later runs start in seconds.

- `docker compose down` stops it and keeps the data.
- `docker compose down -v` wipes everything.
- Port taken? `API_PORT=3001 WEB_PORT=8081 docker compose up --build`

<details>
<summary><b>For development</b></summary>

Needs Node 22 and Docker. Create `docker-compose.override.yml` (not in git) so Postgres is on `127.0.0.1:5432`:

```yaml
services:
  db:
    ports: ["127.0.0.1:5432:5432"]
```

```bash
cp .env.example .env                # the app's config
cp api/.env.example api/.env        # the API's config

npm install
docker compose up -d db             # only Postgres
docker compose run --rm prices      # download the prices (once)

cd api
npm install
npm run migrate:dev                 # create the tables
npm run seed:world                  # the 40 stocks, prices and the clock
npm run seed:sample-game            # optional: 40 players trade the first month
npm run dev                         # the API on :3000
npm test                            # the API tests

cd ..
npx expo start --web                # the app
```

</details>

## More

- [docs/DECISIONS.md](docs/DECISIONS.md): every decision, with the full reasoning
- [docs/API.md](docs/API.md): every endpoint
- [docs/SCHEMA.md](docs/SCHEMA.md): every table
- [docs/tech-stack.md](docs/tech-stack.md): who handles what
- [assignment/PROGRESS.md](assignment/PROGRESS.md): what's done and what's next
