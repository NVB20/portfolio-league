-- Up Migration

-- The admin action log (D-021: "later, with the admin page"). One row per admin action, written in the
-- SAME transaction as the action itself, so a row exists exactly when the action happened.
-- Append-only: nothing updates or deletes a row (except a user being deleted, by cascade).
-- Read by GET /admin/overview ("יומן פעולות ניהול").
CREATE TABLE admin_actions (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid       TEXT NOT NULL REFERENCES users (uid) ON DELETE CASCADE,   -- the admin who did it
  action    TEXT NOT NULL CHECK (action IN ('clock_to_close', 'clock_to_open', 'clock_start', 'clock_stop')),
  world_from TIMESTAMPTZ,                                              -- world time before the action
  world_to   TIMESTAMPTZ,                                              -- world time after it
  detail    JSONB NOT NULL DEFAULT '{}'::jsonb,                        -- e.g. {"events": 2, "ordersExecuted": 14}
  at        TIMESTAMPTZ NOT NULL DEFAULT now()                         -- real time
);

-- The newest actions first, for the admin page.
CREATE INDEX admin_actions_at_idx ON admin_actions (at DESC);

-- Down Migration

DROP TABLE admin_actions;
