-- Up Migration

-- The game world and each player's game state. Every table starts EMPTY:
-- prices are loaded later from the local price DB (D-002, D-003), and orders, snapshots and
-- standings are written by the game logic (Phases 2 to 4). The dashboard reads all of them.
-- Money and units are NUMERIC, never float (tech-stack.md). NUMERIC keeps fractions like 0.234 exactly.

-- The display name shown on the leaderboard. Filled from the Firebase token's `name` claim
-- (Google sign-in has one, email sign-up doesn't). Never the email: other players see this.
ALTER TABLE users ADD COLUMN display_name TEXT;

-- The 20 securities in the game.
CREATE TABLE securities (
  symbol    TEXT PRIMARY KEY,                                   -- game ticker: 'TEVA', 'NVDA'
  name_he   TEXT NOT NULL,                                      -- shown in the app: 'טבע', 'אנבידיה'
  market    TEXT NOT NULL CHECK (market IN ('TASE', 'US')),     -- decides the trading hours
  exchange  TEXT NOT NULL CHECK (exchange IN ('TASE', 'NASDAQ', 'NYSE')),
  currency  TEXT NOT NULL CHECK (currency IN ('ILS', 'USD'))    -- TASE prices are stored in ₪, not agorot
);

-- One row per security per trading day, in the security's currency.
CREATE TABLE prices (
  symbol  TEXT NOT NULL REFERENCES securities (symbol),
  day     DATE NOT NULL,                                        -- the trading day, exchange time zone
  open    NUMERIC(14, 4) NOT NULL CHECK (open > 0),
  close   NUMERIC(14, 4) NOT NULL CHECK (close > 0),
  PRIMARY KEY (symbol, day)
);

-- The USD/ILS rate per day (₪ per $1).
CREATE TABLE usd_ils (
  day    DATE PRIMARY KEY,
  open   NUMERIC(10, 4) NOT NULL CHECK (open > 0),
  close  NUMERIC(10, 4) NOT NULL CHECK (close > 0)
);

-- The one shared game clock. `id` can only be TRUE, so the table holds at most one row.
-- No row = the admin hasn't started the world yet.
CREATE TABLE world_clock (
  id      BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  now_at  TIMESTAMPTZ NOT NULL
);

-- One per player, created with the user row on first login (D-008). Starting cash is a rule of the brief.
CREATE TABLE portfolios (
  uid   TEXT PRIMARY KEY REFERENCES users (uid) ON DELETE CASCADE,
  cash  NUMERIC(16, 4) NOT NULL DEFAULT 1000000 CHECK (cash >= 0)   -- >= 0: no leverage
);
-- Players who logged in before this migration get their portfolio now.
INSERT INTO portfolios (uid) SELECT uid FROM users;

-- What a player owns. A row is deleted when its units reach 0, so units > 0: no short selling.
CREATE TABLE holdings (
  uid     TEXT NOT NULL REFERENCES portfolios (uid) ON DELETE CASCADE,
  symbol  TEXT NOT NULL REFERENCES securities (symbol),
  units   NUMERIC(24, 8) NOT NULL CHECK (units > 0),
  PRIMARY KEY (uid, symbol)
);

-- Every order ever sent. One table for all players (D-004), so one query finds all pending orders.
CREATE TABLE orders (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid            TEXT NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  symbol         TEXT NOT NULL REFERENCES securities (symbol),
  side           TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  amount_ils     NUMERIC(16, 2) NOT NULL CHECK (amount_ils > 0),     -- orders are sized in ₪
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'rejected')),
  placed_at      TIMESTAMPTZ NOT NULL,                               -- world time when sent
  executes_at    TIMESTAMPTZ NOT NULL,                               -- world time it will run (close or next open)
  price_type     TEXT NOT NULL CHECK (price_type IN ('open', 'close')),
  reject_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()                  -- real time, for debugging
);
CREATE INDEX orders_pending_idx ON orders (executes_at) WHERE status = 'pending';
CREATE INDEX orders_uid_idx ON orders (uid, placed_at DESC);

-- Portfolio value at points in world time. The chart, weekly return and max drawdown come from these.
CREATE TABLE portfolio_snapshots (
  uid        TEXT NOT NULL REFERENCES portfolios (uid) ON DELETE CASCADE,
  at         TIMESTAMPTZ NOT NULL,
  value_ils  NUMERIC(16, 2) NOT NULL CHECK (value_ils >= 0),
  PRIMARY KEY (uid, at)
);
CREATE INDEX portfolio_snapshots_at_idx ON portfolio_snapshots (at);

-- The weekly competition as of the end of each game day (D-006).
-- The latest day of the week is the current table; earlier days give "daily score" and "rank change".
CREATE TABLE standings (
  day               DATE NOT NULL,                                -- a Mon..Fri world-clock day
  uid               TEXT NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  return_pct        NUMERIC(10, 4) NOT NULL,                      -- week return so far, e.g. 2.35 = +2.35%
  max_drawdown_pct  NUMERIC(10, 4) NOT NULL CHECK (max_drawdown_pct >= 0),
  return_rank       NUMERIC(6, 2) NOT NULL CHECK (return_rank BETWEEN 0 AND 100),
  stability_rank    NUMERIC(6, 2) NOT NULL CHECK (stability_rank BETWEEN 0 AND 100),
  score             NUMERIC(6, 2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  rank              INTEGER NOT NULL CHECK (rank > 0),
  PRIMARY KEY (day, uid)
);
CREATE INDEX standings_day_rank_idx ON standings (day, rank);

-- Down Migration

DROP TABLE standings;
DROP TABLE portfolio_snapshots;
DROP TABLE orders;
DROP TABLE holdings;
DROP TABLE portfolios;
DROP TABLE world_clock;
DROP TABLE usd_ils;
DROP TABLE prices;
DROP TABLE securities;
ALTER TABLE users DROP COLUMN display_name;
