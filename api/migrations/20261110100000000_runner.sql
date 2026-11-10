-- Up Migration

-- What order sending and the runner need on top of the engine tables (D-021, D-023):
--   - world_clock: the ticker's heartbeat, and how far the runner has started (orders sent later run after it)
--   - orders: a stable reject code, the event that ran the order, and when the player saw its rejection
--   - indexes for the rate limit, an event's orders, unseen rejections and an event's affected players

-- Executed and rejected orders must name the event that ran them (below). Before the runner, only test
-- fixtures wrote such rows, and they have no event to point at.
DO $$
DECLARE
  n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM orders WHERE status <> 'pending';
  IF n > 0 THEN
    RAISE EXCEPTION 'orders has % executed or rejected rows and no market_events row to link them to; fix them by hand first (in a test database: TRUNCATE users CASCADE)', n;
  END IF;
END $$;

-- ---------- world_clock ----------

ALTER TABLE world_clock
  -- Real time of the ticker's last tick. It ticks every minute even when nothing is due, so the admin page
  -- can show red when it stops.
  ADD COLUMN last_tick_at    TIMESTAMPTZ,
  -- World time of the latest event the runner has STARTED: every event at or before it has started or
  -- finished. "Now" is never before it, so an order sent during an admin jump runs after the event that is
  -- already running, not inside it.
  ADD COLUMN events_through  TIMESTAMPTZ;

-- ---------- orders ----------

ALTER TABLE orders
  -- Why the runner rejected it, for the app's English text (reject_reason is the Hebrew). Send-time refusals
  -- are answered with an error and never stored, so only the engine's four codes appear here.
  ADD COLUMN reject_code  TEXT CHECK (reject_code IN ('NO_PRICE', 'INSUFFICIENT_CASH', 'OVER_LIMIT', 'INSUFFICIENT_UNITS')),
  -- The event that executed or rejected it; null while pending. The runner finds an event's orders by it
  -- (affected players, the ledger check).
  ADD COLUMN event_id     BIGINT REFERENCES market_events (id),
  -- Real time the player saw the rejection toast (D-023). Null = not seen yet.
  ADD COLUMN notified_at  TIMESTAMPTZ,
  ADD CONSTRAINT orders_reject_code_status_check CHECK (reject_code IS NULL OR status = 'rejected'),
  ADD CONSTRAINT orders_event_check CHECK ((status = 'pending') = (event_id IS NULL)),
  ADD CONSTRAINT orders_notified_check CHECK (notified_at IS NULL OR status = 'rejected');

-- The rate limit: this player's orders in the last real minute.
CREATE INDEX orders_uid_created_idx ON orders (uid, created_at DESC);
-- The orders an event executed or rejected.
CREATE INDEX orders_event_idx ON orders (event_id) WHERE event_id IS NOT NULL;
-- The rejection toasts a player hasn't seen yet. Small: a row leaves the index once seen.
CREATE INDEX orders_unseen_rejections_idx ON orders (uid) WHERE status = 'rejected' AND notified_at IS NULL;

-- ---------- positions ----------

-- An event's affected players: everyone with an open position in one of that market's stocks, paged by uid.
CREATE INDEX positions_open_symbol_idx ON positions (symbol, uid) WHERE status = 'open';

-- Down Migration

DROP INDEX positions_open_symbol_idx;

DROP INDEX orders_unseen_rejections_idx;
DROP INDEX orders_event_idx;
DROP INDEX orders_uid_created_idx;
ALTER TABLE orders
  DROP CONSTRAINT orders_notified_check,
  DROP CONSTRAINT orders_event_check,
  DROP CONSTRAINT orders_reject_code_status_check,
  DROP COLUMN notified_at,
  DROP COLUMN event_id,
  DROP COLUMN reject_code;

ALTER TABLE world_clock
  DROP COLUMN events_through,
  DROP COLUMN last_tick_at;
