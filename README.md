# Portfolio League (ליגת תיקים)

A weekly stock-trading game: a virtual ₪1,000,000, TASE and US stocks, a weekly leaderboard. A home assignment for House of Finance ([the brief](assignment/ASSIGNMENT.md)).

**The whole project is in the slides.** This page is the short version the brief asks for.

[![Open the slides](https://img.shields.io/badge/Open_the_slides-FBBC04?style=for-the-badge&logo=googleslides&logoColor=black)](https://docs.google.com/presentation/d/1Nhv7syv3wnFSp8ics_yjgLhy1Dz1070k1_aTFB1j3O8/edit?usp=sharing)

## What I built, and why

The game (sign up, dashboard, trading with a full chart, weekly leaderboard), an engine that fills orders at every open and close (486+ tests), and an admin side (clock, engine health, players online, return rates, users). Most of the work went into the engine: the worst bug in a trading game creates or loses money, so it can't create money, can't run an order twice, and runs with nobody watching.

**Stack:** the team's Expo, TypeScript and Firebase Auth. Game data lives in Postgres behind an API, because money needs transactions and exact numbers, and trusted logic in Firebase needs paid Cloud Functions.

## The world

3 years of real daily open and close prices from Yahoo for 40 stocks (20 TASE, 20 US) and USD/ILS, stored in Postgres. Real history gives real charts with no price model to defend. A weekday with no prices is a holiday. The clock runs from 27.11.2023 to 05.11.2026 (about 154 weeks). The catch: the future is public (below).

## Moving the clock

Avatar menu → "מעבר לצד הניהול" → password `123456` (shown on the screen on purpose) makes you an admin. The world clock card then has **to the close**, **to the next open**, and **start / stop** (real speed). Every open and close on the way runs, in order.

## Rules I completed

| Rule | My decision | Why |
|------|-------------|-----|
| Buy and sell in ₪ | Buy a ₪ amount; sell units (the app turns ₪ into units) | You can't sell more than you hold |
| Order size | At least ₪100, unless you sell everything | No ₪1 spam, and a tiny position can still close |
| Market hours | Tel Aviv Mon–Thu 10:00–17:30, Fri 10:00–13:50; US 9:30–16:00 New York time. Each stock follows its own market's calendar | The two markets close on different days |
| Sent during a running close | Goes to the next open | It can't slip into a close already running |
| Can't cancel | Cash or units are set aside when sent | You can't spend the same shekel twice |
| 20% per stock | Checked when sent and at the fill price; may grow past 20% later | "The moment of purchase" is the fill |
| Dollar rate | Open rate at an open, close rate at a close | The rate at the fill |
| No price that day | Rejected, money back | No price, no trade |
| Early-close days | Normal hours | One close price per day |
| TASE before 2026 | Monday to Thursday | Yahoo has no Sundays before 2026 |
| The week | Monday's first open to Friday's last close, scored at every open and close | Prices exist only then |
| Who is ranked | Anyone who held a stock or had an order this week | Idle cash would top a falling week |
| Joining mid-week | Ranked from your first filled buy | The same start as everyone else |
| Tied percentiles | Share the higher one | The best return always gets 100 |
| Equal scores | % gain, then smaller drop, then earlier sign-up | One player per place |
| Order rate | 5 per minute per player | Protects the engine from scripts |
| Stop loss (extra) | Optional on a buy, checked at open and close | The first risk tool traders learn |
| Names on the board | The sign-in name, never the email | Emails are private |
| Who moves the clock | Admins; otherwise it runs at real speed | It never freezes while the admin is away |

## Rules I'd change

1. **The future is public.** Hide the year and names, or play live markets.
2. **₪100 invested, the rest in cash** gets a top stability rank. Require a minimum invested share.
3. **Percentiles reward max risk:** first by 0.1% scores like first by 20%. Use a risk-adjusted score.
4. **Selling out after a good Tuesday** locks the week. Weigh return by time invested.
5. **Many accounts, one winner.** One account per verified phone.

## Production

- **Load:** sending an order is one short write; orders run in batches at each open and close. One API instance answered 2,000 simultaneous dashboard reads (50,000 players) in 3.5 s.
- **Daily pushes:** tests on every pull request, a Trivy-scanned Docker image on every merge.
- **While I'm away:** n8n checks the API and web app every 5 minutes and posts to Discord when one goes down or comes back, plus a daily players and orders report.

## Run it

```bash
docker compose up --build    # then open http://localhost:8080
```

Only Docker, no keys. The first run takes a few minutes (prices and a sample month with 40 players). `docker compose down -v` wipes it. Development setup: [CLAUDE.md](CLAUDE.md#commands).

**Docs:** [decisions](docs/DECISIONS.md) · [API](docs/API.md) · [schema](docs/SCHEMA.md) · [stack](docs/tech-stack.md) · [progress](assignment/PROGRESS.md)
