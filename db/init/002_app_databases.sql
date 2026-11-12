-- The app's own databases, next to `prices` (see docs/DECISIONS.md D-002).
-- Runs automatically the first time the Postgres container starts with an empty volume.
-- The tables in them come from the API's migrations (api/migrations/), not from here.

-- The game: what the API reads and writes (`docker compose up`, or `cd api && npm run dev`).
CREATE DATABASE portfolio;

-- Wiped and refilled by the API tests (`cd api && npm test`).
CREATE DATABASE portfolio_test;
