-- Up Migration

-- The trading engine's money and event tables:
--   - a double-entry ledger: journals + ledger_entries that must sum to 0, append-only (D-019)
--   - positions, replacing holdings, with cost basis, realized gain and the latest mark (D-019)
--   - stored totals and weekly running totals on portfolios (D-019, D-024)
--   - order sizes (buy in ₪, sell in units), retry-safe client ids and fill columns on orders (D-018, D-019)
--   - market_events: the event log of every open and close the runner processes (D-021)
-- users.last_seen_at (online players first, D-021) comes with the presence migration, not this one.

-- holdings has no cost, so its rows can't become ledger-backed positions. Nothing has written it yet.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM holdings) THEN
    RAISE EXCEPTION 'holdings has rows; positions need a cost basis, so move them by hand first';
  END IF;
END $$;

-- ---------- positions ----------

-- Every position a player ever held. A buy from 0 units opens a row; at 0 units it is closed and stays as history.
CREATE TABLE positions (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid                 TEXT NOT NULL REFERENCES portfolios (uid) ON DELETE CASCADE,
  symbol              TEXT NOT NULL REFERENCES securities (symbol),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  units               NUMERIC(24, 8) NOT NULL CHECK (units >= 0),
  reserved_units      NUMERIC(24, 8) NOT NULL DEFAULT 0,                 -- locked by pending sells
  avg_cost_ils        NUMERIC(20, 8) NOT NULL DEFAULT 0 CHECK (avg_cost_ils >= 0),   -- ₪ per unit
  cost_basis_ils      NUMERIC(16, 2) NOT NULL DEFAULT 0 CHECK (cost_basis_ils >= 0), -- ₪ paid for the units held
  realized_pnl_ils    NUMERIC(16, 2) NOT NULL DEFAULT 0,                 -- from sales of this position
  last_price          NUMERIC(14, 4),                                    -- the mark, in the security's currency
  last_fx             NUMERIC(10, 4),                                    -- USD/ILS of the mark (US only)
  market_value_ils    NUMERIC(16, 2),
  unrealized_pnl_ils  NUMERIC(16, 2),                                    -- market value − cost basis
  marked_at           TIMESTAMPTZ,                                       -- world time of the mark
  opened_at           TIMESTAMPTZ,                                       -- world time
  closed_at           TIMESTAMPTZ,
  CHECK (reserved_units >= 0 AND reserved_units <= units),               -- no selling units twice, no short selling
  CHECK ((status = 'open' AND units > 0 AND closed_at IS NULL)
      OR (status = 'closed' AND units = 0 AND reserved_units = 0 AND closed_at IS NOT NULL))
);
-- One open position per player per stock.
CREATE UNIQUE INDEX positions_open_idx ON positions (uid, symbol) WHERE status = 'open';
CREATE INDEX positions_uid_idx ON positions (uid);

DROP TABLE holdings;
-- The old name, kept as a read-only-in-spirit view of what players hold now (admin pages and fixtures use it).
CREATE VIEW holdings AS SELECT uid, symbol, units FROM positions WHERE status = 'open';

-- ---------- portfolios: stored totals and weekly running totals ----------

ALTER TABLE portfolios
  ADD COLUMN reserved_cash     NUMERIC(16, 2) NOT NULL DEFAULT 0,          -- locked by pending buys
  ADD COLUMN available_cash    NUMERIC(16, 4) GENERATED ALWAYS AS (cash - reserved_cash) STORED,
  ADD COLUMN holdings_value    NUMERIC(16, 2) NOT NULL DEFAULT 0 CHECK (holdings_value >= 0),
  ADD COLUMN equity            NUMERIC(16, 4) GENERATED ALWAYS AS (cash + holdings_value) STORED,
  ADD COLUMN realized_pnl      NUMERIC(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN unrealized_pnl    NUMERIC(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN marked_at         TIMESTAMPTZ,                               -- world time of the last valuation
  ADD COLUMN last_event_at     TIMESTAMPTZ,                               -- the last event applied (retry guard, D-021)
  ADD COLUMN week_start        DATE,                                      -- Monday of the week the totals below belong to
  ADD COLUMN week_start_value  NUMERIC(16, 2),
  ADD COLUMN peak_value        NUMERIC(16, 2),
  ADD COLUMN max_drawdown_pct  NUMERIC(10, 4) NOT NULL DEFAULT 0 CHECK (max_drawdown_pct >= 0),
  ADD CONSTRAINT portfolios_reserved_cash_check CHECK (reserved_cash >= 0 AND reserved_cash <= cash);   -- no leverage

-- ---------- the ledger ----------

-- One row per money event. Its ledger entries must add up to exactly 0.
CREATE TABLE journals (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid         TEXT NOT NULL REFERENCES portfolios (uid) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('start', 'reserve', 'release', 'buy', 'sell', 'reversal')),
  order_id    BIGINT REFERENCES orders (id) ON DELETE CASCADE,
  world_at    TIMESTAMPTZ,                          -- world time (null for the start cash given on sign-up)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),   -- real time
  CHECK (kind IN ('start', 'reversal') OR order_id IS NOT NULL),
  UNIQUE (id, uid)                                  -- lets ledger_entries require the same player as its journal
);
CREATE INDEX journals_uid_idx ON journals (uid, id);
CREATE INDEX journals_order_idx ON journals (order_id) WHERE order_id IS NOT NULL;

-- The lines of each journal. + is what the player has (cash, stock at cost); − is where it came from
-- (capital, gains). A ₪100 gain is written as −100 on realized_pnl.
CREATE TABLE ledger_entries (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id  BIGINT NOT NULL,
  uid         TEXT NOT NULL,
  account     TEXT NOT NULL CHECK (account IN ('cash_free', 'cash_locked', 'stock_cost', 'realized_pnl', 'capital')),
  symbol      TEXT REFERENCES securities (symbol),  -- only for stock_cost
  amount      NUMERIC(16, 2) NOT NULL CHECK (amount <> 0),
  FOREIGN KEY (journal_id, uid) REFERENCES journals (id, uid) ON DELETE CASCADE,
  CHECK ((account = 'stock_cost') = (symbol IS NOT NULL))
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (uid, account, symbol);
CREATE INDEX ledger_entries_journal_idx ON ledger_entries (journal_id);

-- At commit: every new journal has 2+ entries that sum to 0, and entries added to a journal keep it at 0.
CREATE FUNCTION ledger_assert_balanced(jid BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  total  NUMERIC;
  lines  INTEGER;
BEGIN
  SELECT coalesce(sum(amount), 0), count(*) INTO total, lines FROM ledger_entries WHERE journal_id = jid;
  IF lines < 2 THEN
    RAISE EXCEPTION 'journal % has % ledger entries; it needs at least 2', jid, lines;
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'journal % does not balance: its entries sum to %', jid, total;
  END IF;
END $$;

CREATE FUNCTION journals_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_assert_balanced(NEW.id);
  RETURN NULL;
END $$;

CREATE FUNCTION ledger_entries_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_assert_balanced(NEW.journal_id);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journals_balanced AFTER INSERT ON journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journals_check_balanced();
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entries_check_balanced();

-- Append-only: no UPDATE, no DELETE. A mistake is fixed with a reversal journal. The one exception is a
-- cascade from deleting a whole player (pg_trigger_depth() > 1: the delete comes from a foreign key).
CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed (fix a mistake with a reversal journal)', TG_TABLE_NAME, TG_OP;
END $$;

CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON journals
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- Every existing portfolio gets its starting cash in the ledger: cash_free +cash, capital −cash.
WITH j AS (
  INSERT INTO journals (uid, kind) SELECT uid, 'start' FROM portfolios RETURNING id, uid
)
INSERT INTO ledger_entries (journal_id, uid, account, amount)
SELECT j.id, j.uid, a.account, a.amount
FROM j
JOIN portfolios p ON p.uid = j.uid
CROSS JOIN LATERAL (VALUES ('cash_free', p.cash), ('capital', -p.cash)) AS a (account, amount);

-- ---------- orders: sizes, retry-safe ids, fills ----------

ALTER TABLE orders
  ALTER COLUMN amount_ils DROP NOT NULL,
  ADD COLUMN units             NUMERIC(24, 8) CHECK (units > 0),   -- sells only (D-018)
  ADD COLUMN client_order_id   TEXT,                               -- from the app; a retried request can't make a 2nd order
  ADD COLUMN fill_price        NUMERIC(14, 4),                     -- in the security's currency
  ADD COLUMN fx_rate           NUMERIC(10, 4),                     -- USD/ILS used (US only)
  ADD COLUMN filled_units      NUMERIC(24, 8),
  ADD COLUMN filled_ils        NUMERIC(16, 2),
  ADD COLUMN realized_pnl_ils  NUMERIC(16, 2),                     -- sells only
  ADD COLUMN position_id       BIGINT REFERENCES positions (id),   -- the position it opened or changed
  ADD COLUMN executed_at       TIMESTAMPTZ,                        -- world time
  ADD CONSTRAINT orders_size_check CHECK (
    (side = 'buy' AND amount_ils IS NOT NULL AND units IS NULL)
    OR (side = 'sell' AND units IS NOT NULL AND amount_ils IS NULL)),
  ADD CONSTRAINT orders_fill_check CHECK (
    (status = 'executed') = (executed_at IS NOT NULL AND fill_price IS NOT NULL AND filled_units IS NOT NULL
                             AND filled_ils IS NOT NULL AND position_id IS NOT NULL)),
  ADD CONSTRAINT orders_reject_check CHECK ((status = 'rejected') = (reject_reason IS NOT NULL));
CREATE UNIQUE INDEX orders_client_order_idx ON orders (uid, client_order_id) WHERE client_order_id IS NOT NULL;

-- ---------- the event log ----------

-- One row per open or close the runner processes (D-021). The admin page reads the counts.
CREATE TABLE market_events (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market             TEXT NOT NULL CHECK (market IN ('TASE', 'US')),
  kind               TEXT NOT NULL CHECK (kind IN ('open', 'close')),
  day                DATE NOT NULL,                                -- Israel calendar date of the session
  at                 TIMESTAMPTZ NOT NULL,                         -- world time of the open or close
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'orders_done', 'done')),
  started_at         TIMESTAMPTZ,                                  -- real time
  finished_at        TIMESTAMPTZ,                                  -- real time
  orders_executed    INTEGER NOT NULL DEFAULT 0,
  orders_rejected    INTEGER NOT NULL DEFAULT 0,
  players_updated    INTEGER NOT NULL DEFAULT 0,
  duration_ms        INTEGER,
  ledger_balanced    BOOLEAN,                                      -- the check after the event (D-019)
  median_value       NUMERIC(16, 2),                               -- the median player line (D-024)
  median_return_pct  NUMERIC(10, 4),
  UNIQUE (market, kind, day)
);
CREATE INDEX market_events_at_idx ON market_events (at);
CREATE INDEX market_events_unfinished_idx ON market_events (at) WHERE status <> 'done';

-- Down Migration

DROP TABLE market_events;

DROP INDEX orders_client_order_idx;
ALTER TABLE orders
  DROP CONSTRAINT orders_reject_check,
  DROP CONSTRAINT orders_fill_check,
  DROP CONSTRAINT orders_size_check,
  DROP COLUMN executed_at,
  DROP COLUMN position_id,
  DROP COLUMN realized_pnl_ils,
  DROP COLUMN filled_ils,
  DROP COLUMN filled_units,
  DROP COLUMN fx_rate,
  DROP COLUMN fill_price,
  DROP COLUMN client_order_id,
  DROP COLUMN units;
DELETE FROM orders WHERE amount_ils IS NULL;
ALTER TABLE orders ALTER COLUMN amount_ils SET NOT NULL;

DROP TABLE ledger_entries;
DROP TABLE journals;
DROP FUNCTION ledger_append_only();
DROP FUNCTION ledger_entries_check_balanced();
DROP FUNCTION journals_check_balanced();
DROP FUNCTION ledger_assert_balanced(BIGINT);

ALTER TABLE portfolios
  DROP CONSTRAINT portfolios_reserved_cash_check,
  DROP COLUMN max_drawdown_pct,
  DROP COLUMN peak_value,
  DROP COLUMN week_start_value,
  DROP COLUMN week_start,
  DROP COLUMN last_event_at,
  DROP COLUMN marked_at,
  DROP COLUMN unrealized_pnl,
  DROP COLUMN realized_pnl,
  DROP COLUMN equity,
  DROP COLUMN holdings_value,
  DROP COLUMN available_cash,
  DROP COLUMN reserved_cash;

DROP VIEW holdings;
CREATE TABLE holdings (
  uid     TEXT NOT NULL REFERENCES portfolios (uid) ON DELETE CASCADE,
  symbol  TEXT NOT NULL REFERENCES securities (symbol),
  units   NUMERIC(24, 8) NOT NULL CHECK (units > 0),
  PRIMARY KEY (uid, symbol)
);
INSERT INTO holdings SELECT uid, symbol, units FROM positions WHERE status = 'open';
DROP TABLE positions;
