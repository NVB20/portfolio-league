-- Up Migration

-- Usage monitoring for the admin page (D-036). Written only by POST /me/seen: the app's once-a-minute check-in
-- (D-026) carries what happened since the last one, and the server adds it to one row per player per day.
-- Daily totals, not an event log: the tables grow with players x pages per day, never with clicks.
-- Real time and real Israel dates, like presence: it measures people, not the game.
-- The page names are checked in code (api/src/usage.ts), not with a CHECK here, so a new page needs no migration.

-- Time and views per player per page per real Israel day (D-036). Written only by POST /me/seen.
CREATE TABLE usage_pages_daily (
  day DATE NOT NULL,
  page TEXT NOT NULL,
  uid TEXT NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  views INT NOT NULL DEFAULT 0 CHECK (views >= 0),
  ms BIGINT NOT NULL DEFAULT 0 CHECK (ms >= 0),
  PRIMARY KEY (day, page, uid)
);

-- The trade screen's confirm popup per player per day: opened, and closed without sending.
CREATE TABLE usage_confirms_daily (
  day DATE NOT NULL,
  uid TEXT NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  opened INT NOT NULL DEFAULT 0 CHECK (opened >= 0),
  backed INT NOT NULL DEFAULT 0 CHECK (backed >= 0),
  PRIMARY KEY (day, uid)
);

-- "Orders sent in the last 30 days" reads a range of this index instead of the whole table.
CREATE INDEX orders_created_idx ON orders (created_at);

-- Down Migration

DROP INDEX orders_created_idx;
DROP TABLE usage_confirms_daily;
DROP TABLE usage_pages_daily;
