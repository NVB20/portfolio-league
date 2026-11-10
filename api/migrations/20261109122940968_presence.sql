-- Up Migration

-- Who is using the app, for the admin page (D-026). Written only by POST /me/seen, which the app calls
-- when it opens and about once a minute while it stays open. Real time, never world time.

-- The last time the app checked in. Online = seen in the last 2 minutes. NULL = never checked in.
ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ;

-- "How many are online now" counts recent rows only, so it reads a small slice of this index.
CREATE INDEX users_last_seen_idx ON users (last_seen_at);

-- One row per visit. A check-in after more than 30 minutes away (or the very first one) starts a new visit.
-- The server decides, so a client can't inflate the count by claiming it opened the app.
CREATE TABLE app_opens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid TEXT NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Today's visits per player: a range on `at`, grouped by uid, read from the index alone.
CREATE INDEX app_opens_at_uid_idx ON app_opens (at, uid);

-- Down Migration

DROP TABLE app_opens;
DROP INDEX users_last_seen_idx;
ALTER TABLE users DROP COLUMN last_seen_at;
