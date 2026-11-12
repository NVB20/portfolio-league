# Portfolio League

A home assignment for "House of Finance" (הבית הפיננסי). It is a weekly stock-trading game: each player gets a virtual ₪1,000,000, buys and sells TASE and US stocks, and competes on a weekly leaderboard.

- **Brief:** [assignment/ASSIGNMENT.md](assignment/ASSIGNMENT.md) (Hebrew, verbatim). Never edit it.
- **Rules in English:** [assignment/pre-made-game-rules.md](assignment/pre-made-game-rules.md)
- **Progress and what is next:** [assignment/PROGRESS.md](assignment/PROGRESS.md). Update it when a task is done.
- **Due:** Thursday 12.11.2026, 23:59

The brief asks for three things:
1. **The game:** sign up, trade by the rules, see the leaderboard, on a live link.
2. **One retention feature** that brings players back every day, with a reason and a way to measure it.
3. **Production readiness:** thousands of players arriving at once, other developers pushing daily, and you away on vacation.

The rules are incomplete on purpose. Every gap we fill is written down in [docs/DECISIONS.md](docs/DECISIONS.md) and ends up in the README's rules table.

## Stack

See [docs/tech-stack.md](docs/tech-stack.md): Expo (React Native) + TypeScript, Firebase (Auth, Hosting), and a TypeScript API (Hono) with Postgres. The API ships as a Docker image (GHCR, built by CI).

- **Firebase knows who the user is; the API and Postgres decide what they may do.** Firebase handles login and the JWT. The API checks that token on every request.
- **The app never talks to Postgres directly.** Every read and write goes through the API (`src/api.ts` → `api/`).
- **The API is the permission layer.** Every endpoint checks the token and the user's roles. Players can never write cash, holdings, prices, the clock, scores or roles. Roles are changed only with SQL.
- **Trusted game logic (order execution, scoring) runs in the API** (D-001), in batched transactions that are safe to retry (D-021).
- **Money is double-entry (D-019).** Every cash event is a journal whose ledger entries sum to 0. Balances are stored columns, updated in the same transaction. Screens never add money up.
- **Game logic is pure TypeScript** with no database or framework imports, so it can be unit tested.
- **Schema changes are migrations** in `api/migrations/`. Never edit a migration that has already run; add a new one. Every new migration also updates [docs/SCHEMA.md](docs/SCHEMA.md) (tables, fields, indexes, relationships) in the same commit.
- **Money is `NUMERIC` in Postgres**, never float.
- **Hebrew first, RTL.** English must also work. Money is shown in ₪.

## Code layout

| Path | What lives there |
|------|------------------|
| `src/app/` | Expo Router routes only. Every file is a screen; `_layout.tsx` sets up navigation |
| `src/screens/` | The actual screen components the routes render |
| `src/auth/` | `AuthProvider` (current user + roles), sign-in errors, `POST /me` after login |
| `src/components/` | Shared UI (`dashboard/`, `trade/`, `journal/`, `leaderboard/`, `admin/`, `howToPlay/`, `onboarding/`). `BigChart.web.tsx` is the web-only full chart |
| `src/dashboard/`, `src/trade/`, `src/journal/`, `src/leaderboard/`, `src/admin/`, `src/howToPlay/`, `src/onboarding/` | Data hooks, copy and pure helpers per screen (`trade/orderCheck.ts`: the order rules for the preview; `journal/journal.ts` and `leaderboard/board.ts`: each table's columns, sentences and paging; `admin/monitoring.ts`: the monitoring page's numbers and copy; `howToPlay/content.ts`: the rules page's copy, `/how-to-play`; `onboarding/steps.ts`: the two first-login walkthroughs, D-040) |
| `src/usage/` | The usage tracker (D-036): time and views per page and the confirm-popup funnel, sent with the once-a-minute check-in (`src/auth/usePresence.ts`) |
| `src/types/` | Shared TypeScript types |
| `src/firebase.ts` | Firebase app and Auth setup (no database) |
| `src/api.ts` | `apiFetch`: calls the API with the user's Firebase token |
| `src/theme.ts` | Color tokens |
| `api/` | The API: its own `package.json`. `src/` (routes, token check, SQL; `game/` pure logic; `world/` the 40 securities), `migrations/` (SQL), `scripts/` (`seed-world.ts`; `seed-sample-board.ts`, a dev-only made-up leaderboard; `seed-sample-game.ts`, a dev-only month of 40 players trading through the real engine, its plan in `src/sampleGame.ts`), `test/` (vitest). Every endpoint: [docs/API.md](docs/API.md) |
| `docker-compose.yml`, `db/`, `scraper/`, `web/` | The whole game in Docker (D-042): Postgres with real prices from Yahoo and the app's databases (D-002), the API, and the web app (`web/`: the Expo web export behind nginx). `api/scripts/compose-seed.ts` is the `seed` job. `docker-compose.override.yml` (not in git) publishes Postgres for local development |
| `docs/` | Tech stack, decisions, database schema, design |
| `assignment/` | The brief, progress, plans |

## Commands

```bash
npx expo start --web          # run the app
npx tsc --noEmit              # type check
npx expo install <package>    # add a package (never npm install)
docker compose up --build     # the whole game: db, prices, migrate, seed, API :3000, web :8080 (D-042)
docker compose up -d db       # only the local Postgres (docker-compose.override.yml publishes 127.0.0.1:5432)
docker compose run --rm prices    # fetch prices into it, pinned to the calendar's window (once)

cd api
npm run dev                   # run the API locally (reads api/.env)
npm test                      # API tests against the local portfolio_test database
npm run typecheck             # type check the API
npm run migrate:dev           # apply new migrations to the local database
npm run seed:world            # copy the 40 securities, prices, USD/ILS and the clock start into the game DB
npm run seed:sample-board     # dev only: fill the leaderboard with sample players (--clear removes them, D-033)
npm run seed:sample-game      # dev only: restart the world, 40 players trade its first month + visits and usage (D-038)
npm run migrate:create <name> # new SQL migration file
```

The API (`api/`) is a separate Node package: use `npm install` there, not `npx expo install`.

Expo changes a lot between versions. Follow [AGENTS.md](AGENTS.md) and check the docs for the installed SDK before using an Expo API.

## Gotchas

- TASE prices from Yahoo are in agorot (`ILA`). Divide by 100 for ₪.
- Yahoo has no TASE Sunday data before 2026 (TASE moved to Mon to Fri in January 2026).
- `scraper/` and `api/` have their own `package.json` and are excluded from the app's `tsconfig.json`.
- `pg` returns `NUMERIC` columns as strings. Convert them on purpose.
- `EXPO_PUBLIC_*` variables are built into the app and visible to anyone. Never put a secret in one.

## Reporting changes

At the end of every reply that changed code, show a table of the changed files, with one row per file and a one-line summary of what changed in it. Each file name is a clickable markdown link with a path relative to the repo root (not in backticks):

| File | What changed |
|------|--------------|
| [src/example.ts](src/example.ts) | One-line summary |

## Git

- Work in a branch per feature or phase (for example `phase-2-world`), not per screen.
- Never commit without the user's explicit yes.