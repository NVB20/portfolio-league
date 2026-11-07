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

See [docs/tech-stack.md](docs/tech-stack.md): Expo (React Native) + TypeScript + Firebase (Auth, Firestore, Security Rules, Hosting).

- **No separate backend.** The app talks to Firestore directly.
- **Free Spark plan, so no Cloud Functions.** Trusted game logic (order execution, scoring) runs in the admin's browser (D-001).
- **Game logic is pure TypeScript** with no Firebase imports, so it can be tested and later moved to Cloud Functions.
- **Security Rules are the permission layer.** Every collection gets rules before it ships. Players can never write cash, holdings, prices, the clock or scores.
- **Hebrew first, RTL.** English must also work. Money is shown in ₪.

## Code layout

| Path | What lives there |
|------|------------------|
| `src/app/` | Expo Router routes only. Every file is a screen; `_layout.tsx` sets up navigation |
| `src/screens/` | The actual screen components the routes render |
| `src/auth/` | `AuthProvider` (current user + roles), sign-in errors, creating `users/{uid}` |
| `src/components/` | Shared UI |
| `src/types/` | Shared TypeScript types |
| `src/firebase.ts` | Firebase app, Auth and Firestore setup |
| `src/theme.ts` | Color tokens |
| `firestore.rules` | Security Rules |
| `docker-compose.yml`, `db/`, `scraper/` | Local-only Postgres with 3 years of real prices from Yahoo (D-002). The app never connects to it |
| `docs/` | Tech stack, decisions, design |
| `assignment/` | The brief, progress, plans |

## Commands

```bash
npx expo start --web          # run the app
npx tsc --noEmit              # type check
npx expo install <package>    # add a package (never npm install)
docker compose up -d          # start the local price DB
docker compose run --rm scraper   # fetch prices into it
```

Expo changes a lot between versions. Follow [AGENTS.md](AGENTS.md) and check the docs for the installed SDK before using an Expo API.

## Gotchas

- TASE prices from Yahoo are in agorot (`ILA`). Divide by 100 for ₪.
- Yahoo has no TASE Sunday data before 2026 (TASE moved to Mon to Fri in January 2026).
- `scraper/` has its own `package.json` and is excluded from the app's `tsconfig.json`.

## Reporting changes

At the end of every reply that changed code, show a table of the changed files, with one row per file and a one-line summary of what changed in it. Each file name is a clickable markdown link with a path relative to the repo root (not in backticks):

| File | What changed |
|------|--------------|
| [src/example.ts](src/example.ts) | One-line summary |

## Git

- Work in a branch per feature or phase (for example `phase-2-world`), not per screen.
- Never commit without the user's explicit yes.