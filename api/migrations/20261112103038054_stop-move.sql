-- Up Migration

-- Moving a stop loss (D-041). Once its buy has filled, the player can move a stop, up or down, while it is active.
-- stop_orders.stop_price is the stop as it is now; the buy's orders.stop_price stays the price that was sent.
-- Every move is a stop_moves row: the history, and what the 5-a-minute limit counts.

-- ---------- stop_orders ----------

-- World time of the last move; null = never moved. A moved stop no longer fires because its buy filled at or below
-- it (stopFires, game/stops.ts): it was set below the price the player saw, so only an event's price counts.
ALTER TABLE stop_orders ADD COLUMN moved_at TIMESTAMPTZ;

-- ---------- stop_moves ----------

CREATE TABLE stop_moves (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stop_id     BIGINT NOT NULL REFERENCES stop_orders (id) ON DELETE CASCADE,
  uid         TEXT NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  from_price  NUMERIC(14, 4) NOT NULL CHECK (from_price > 0),   -- in the security's currency
  to_price    NUMERIC(14, 4) NOT NULL CHECK (to_price > 0),
  world_at    TIMESTAMPTZ NOT NULL,                             -- the world time of the move
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),               -- real time
  -- The same price again is answered without a row (PATCH /me/stops/:id, changed: false).
  CONSTRAINT stop_moves_changed_check CHECK (to_price <> from_price)
);
-- The rate limit: this player's moves of the last real minute.
CREATE INDEX stop_moves_uid_created_idx ON stop_moves (uid, created_at);
-- The monitoring page's ranges (today, 7 and 30 days, by real time).
CREATE INDEX stop_moves_created_idx ON stop_moves (created_at);

-- Down Migration

DROP TABLE stop_moves;
ALTER TABLE stop_orders DROP COLUMN moved_at;
