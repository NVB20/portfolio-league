-- Up Migration

-- D-037: a closed position has no active stop loss. A rule of the database, so it holds whatever closes the position:
-- a hand sale, another of its stops, a fix by hand in SQL, or code written later. Two triggers keep it:
--   - when a position closes (status open → closed), every stop still active on it expires, at the position's
--     closed_at, with the open or close that closed it as its event
--   - a stop written as active on a position that is already closed is stored expired instead

-- The open or close of a stock's market at an instant (a position's closed_at is the event's time): its id, or NULL
-- when nothing ran then (a fix by hand). One market has at most one event at any instant. The parameters are named
-- p_*: in a SQL function a column of the same name (market_events.at) would win over the parameter.
CREATE FUNCTION stop_event_at(p_symbol TEXT, p_at TIMESTAMPTZ) RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT e.id FROM market_events e JOIN securities s ON s.market = e.market
  WHERE s.symbol = p_symbol AND e.at = p_at
  ORDER BY e.id LIMIT 1
$$;

CREATE FUNCTION expire_stops_of_closed_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE stop_orders
  SET status = 'expired', ended_at = NEW.closed_at, event_id = stop_event_at(NEW.symbol, NEW.closed_at)
  WHERE position_id = NEW.id AND status = 'active';
  RETURN NULL;
END $$;

CREATE TRIGGER positions_close_stops
  AFTER UPDATE OF status ON positions
  FOR EACH ROW WHEN (OLD.status = 'open' AND NEW.status = 'closed')
  EXECUTE FUNCTION expire_stops_of_closed_position();

-- The position row is locked FOR SHARE (with no filter on its status: a row the snapshot filtered out would never be
-- locked). That lock conflicts with the UPDATE that closes the position, so the two triggers can't miss each other
-- when two transactions write at once: a stop written while the position is being closed waits for the close and then
-- sees it, and a close that starts after the stop's write waits for it, and its trigger then sees the stop.
CREATE FUNCTION stop_orders_not_on_closed_position() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pos_status TEXT;
  pos_closed TIMESTAMPTZ;
BEGIN
  SELECT p.status, p.closed_at INTO pos_status, pos_closed FROM positions p WHERE p.id = NEW.position_id FOR SHARE;
  IF pos_status = 'closed' THEN
    NEW.status := 'expired';
    NEW.ended_at := pos_closed;
    NEW.event_id := stop_event_at(NEW.symbol, pos_closed);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER stop_orders_closed_position
  BEFORE INSERT OR UPDATE OF status, position_id ON stop_orders
  FOR EACH ROW WHEN (NEW.status = 'active')
  EXECUTE FUNCTION stop_orders_not_on_closed_position();

-- Rows written before the triggers (a fix by hand, or a path the old runner step missed) follow the rule too.
UPDATE stop_orders so
SET status = 'expired', ended_at = p.closed_at, event_id = stop_event_at(so.symbol, p.closed_at)
FROM positions p
WHERE p.id = so.position_id AND p.status = 'closed' AND so.status = 'active';

-- Down Migration

DROP TRIGGER stop_orders_closed_position ON stop_orders;
DROP FUNCTION stop_orders_not_on_closed_position();
DROP TRIGGER positions_close_stops ON positions;
DROP FUNCTION expire_stops_of_closed_position();
DROP FUNCTION stop_event_at(TEXT, TIMESTAMPTZ);
