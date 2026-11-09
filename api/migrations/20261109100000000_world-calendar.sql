-- Up Migration

-- The market calendar (D-016) and the running world clock (D-017).

-- Every Monday-to-Friday on which a market is closed. Weekends are a rule in code and get no rows.
-- Filled by `npm run seed:world` from api/src/world/closures.ts, which is checked against the price data.
CREATE TABLE market_closures (
  market     TEXT NOT NULL CHECK (market IN ('TASE', 'US')),
  day        DATE NOT NULL CHECK (extract(isodow FROM day) <= 5),   -- weekdays only
  reason_he  TEXT NOT NULL,                                          -- shown in the app: 'פסח'
  reason_en  TEXT NOT NULL,                                          -- 'Passover'
  PRIMARY KEY (market, day)
);

-- The clock can run at real speed (D-017). While `running`, the world time is
--   now_at + (real now − real_at), skipping days on which neither market opens.
-- When it stops or jumps, now_at is set to the world time and real_at to the real time of that moment.
ALTER TABLE world_clock ADD COLUMN real_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE world_clock ADD COLUMN running BOOLEAN NOT NULL DEFAULT FALSE;
-- Where the clock stops: one minute before the first open that has no prices (set by the seed).
-- The clock never passes it. NULL = no prices loaded yet.
ALTER TABLE world_clock ADD COLUMN ends_at TIMESTAMPTZ;

-- Down Migration

ALTER TABLE world_clock DROP COLUMN ends_at;
ALTER TABLE world_clock DROP COLUMN running;
ALTER TABLE world_clock DROP COLUMN real_at;
DROP TABLE market_closures;
