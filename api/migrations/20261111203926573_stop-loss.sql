-- Up Migration

-- The stop loss (D-037). A buy may carry a stop price. When the buy fills, the stop becomes a stop_orders row
-- for the units that buy got. At every later open and close of its market, a stop whose price the event's price
-- reached (at or below it) becomes a sell order the runner runs at that same event, at that event's price.
-- Checked only at the open and the close: the game trades at those two prices only (rule 3, D-012).

-- ---------- stop_orders ----------

CREATE TABLE stop_orders (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid               TEXT NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  symbol            TEXT NOT NULL REFERENCES securities (symbol),
  buy_order_id      BIGINT NOT NULL UNIQUE REFERENCES orders (id) ON DELETE CASCADE,   -- the buy that set it
  -- The position the buy filled into. A later position in the same stock (after this one closed) is a new row,
  -- so it never inherits this stop.
  position_id       BIGINT NOT NULL REFERENCES positions (id) ON DELETE CASCADE,
  stop_price        NUMERIC(14, 4) NOT NULL CHECK (stop_price > 0),         -- in the security's currency
  units             NUMERIC(24, 8) NOT NULL CHECK (units > 0),              -- the units the buy got
  activated_at      TIMESTAMPTZ NOT NULL,                                   -- world time of the buy's fill
  activation_price  NUMERIC(14, 4) NOT NULL CHECK (activation_price > 0),   -- the buy's fill price
  -- active: checked at every later open and close. triggered: became sell_order_id. expired: its position
  -- closed before it fired (the player sold by hand), so there was nothing left to sell.
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'triggered', 'expired')),
  ended_at          TIMESTAMPTZ,                                            -- world time it fired or expired
  event_id          BIGINT REFERENCES market_events (id),                   -- the event it fired or expired at
  sell_order_id     BIGINT UNIQUE REFERENCES orders (id),                   -- the sell it became
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),                     -- real time
  CONSTRAINT stop_orders_ended_check CHECK ((status = 'active') = (ended_at IS NULL AND event_id IS NULL)),
  CONSTRAINT stop_orders_sell_check CHECK ((status = 'triggered') = (sell_order_id IS NOT NULL))
);
-- The runner's check at every event, and the monitoring page's "active now". Small: a row leaves it once it ends.
CREATE INDEX stop_orders_active_idx ON stop_orders (symbol, stop_price) WHERE status = 'active';
-- A position's active stops (the holding cards).
CREATE INDEX stop_orders_position_idx ON stop_orders (position_id) WHERE status = 'active';

-- ---------- orders ----------

ALTER TABLE orders
  -- The stop the player asked for, on a buy (in the security's currency). Null = no stop.
  ADD COLUMN stop_price  NUMERIC(14, 4),
  -- Who made the order: the player (POST /me/orders) or a stop that fired (the runner).
  ADD COLUMN origin      TEXT NOT NULL DEFAULT 'player' CHECK (origin IN ('player', 'stop')),
  -- The stop that became this sell.
  ADD COLUMN stop_id     BIGINT REFERENCES stop_orders (id),
  ADD CONSTRAINT orders_stop_price_check CHECK (stop_price IS NULL OR (side = 'buy' AND origin = 'player' AND stop_price > 0)),
  -- A stop's order is a sell that names its stop; a player's order names none.
  ADD CONSTRAINT orders_stop_sell_check CHECK ((origin = 'stop') = (stop_id IS NOT NULL) AND (origin = 'player' OR side = 'sell'));

-- A stop's sale is shown to the player in a toast too, so it can be marked seen like a rejection (D-023).
ALTER TABLE orders DROP CONSTRAINT orders_notified_check;
ALTER TABLE orders ADD CONSTRAINT orders_notified_check
  CHECK (notified_at IS NULL OR status = 'rejected' OR (origin = 'stop' AND status = 'executed'));

-- The stop-sale toasts a player hasn't seen yet. Small: a row leaves the index once seen.
CREATE INDEX orders_unseen_stop_sales_idx ON orders (uid) WHERE origin = 'stop' AND status = 'executed' AND notified_at IS NULL;

-- Down Migration

DROP INDEX orders_unseen_stop_sales_idx;
-- The old check allows a seen mark on rejections only. The stop sales stay as ordinary sells.
UPDATE orders SET notified_at = NULL WHERE origin = 'stop';
ALTER TABLE orders DROP CONSTRAINT orders_notified_check;
ALTER TABLE orders ADD CONSTRAINT orders_notified_check CHECK (notified_at IS NULL OR status = 'rejected');
ALTER TABLE orders
  DROP CONSTRAINT orders_stop_sell_check,
  DROP CONSTRAINT orders_stop_price_check,
  DROP COLUMN stop_id,
  DROP COLUMN origin,
  DROP COLUMN stop_price;

DROP TABLE stop_orders;
