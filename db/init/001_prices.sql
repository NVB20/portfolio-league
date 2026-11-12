-- Historical daily prices from Yahoo Finance (see docs/DECISIONS.md D-002).
-- Runs automatically the first time the Postgres container starts with an empty volume.
-- Changed this file? Run `docker compose down -v` so it runs again.

-- One row per thing we track: 20 TASE stocks, 20 US stocks, and the USD/ILS rate.
CREATE TABLE IF NOT EXISTS securities (
  symbol    TEXT PRIMARY KEY,               -- Yahoo symbol: 'TEVA.TA', 'NVDA', 'ILS=X'
  name      TEXT NOT NULL,
  market    TEXT NOT NULL CHECK (market IN ('TASE', 'US', 'FX')),
  -- Currency of the prices, as Yahoo reports it.
  -- 'ILA' = agorot (1/100 shekel). TASE stocks come in ILA, so divide by 100 for ₪.
  currency  TEXT NOT NULL
);

-- One row per security per trading day.
CREATE TABLE IF NOT EXISTS daily_prices (
  symbol     TEXT NOT NULL REFERENCES securities(symbol),
  day        DATE NOT NULL,                 -- the trading day, in the exchange's own time zone
  open       NUMERIC(12, 4) NOT NULL CHECK (open > 0),
  close      NUMERIC(12, 4) NOT NULL CHECK (close > 0),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The same day can't be stored twice for the same security.
  PRIMARY KEY (symbol, day)
);
