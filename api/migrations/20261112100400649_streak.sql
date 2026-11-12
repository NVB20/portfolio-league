-- Up Migration

-- The daily streak (D-039): real Israel calendar days in a row on which the player was in the app. Days, not
-- 24-hour timers: in on 11.11 at 00:05 and on 12.11 at 22:30 is two days in a row. Real time, never world time.
-- Written only by the server, under the users row lock the check-in already takes (FOR NO KEY UPDATE, D-026):
-- by POST /me/seen and by GET /me/dashboard, the first time each real day. The day is Postgres's own,
-- (now() AT TIME ZONE 'Asia/Jerusalem')::date, never the phone's clock.
-- A streak whose last day is before yesterday is over: the read shows 0, so nothing runs at midnight.

ALTER TABLE users
  ADD COLUMN streak_days      INTEGER  NOT NULL DEFAULT 0 CHECK (streak_days >= 0),   -- days in a row up to streak_last_day
  ADD COLUMN streak_best      INTEGER  NOT NULL DEFAULT 0,                             -- the longest run so far
  ADD COLUMN streak_last_day  DATE,                                                    -- the last day counted; NULL = never
  ADD COLUMN streak_week      DATE,                                                    -- the Sunday of the week below; NULL = never
  -- Bit d set = in the app on weekday d of that week (0 = Sunday ... 6 = Saturday), for the card's week dots.
  ADD COLUMN streak_week_days SMALLINT NOT NULL DEFAULT 0 CHECK (streak_week_days BETWEEN 0 AND 127),
  ADD CONSTRAINT users_streak_check CHECK (
    streak_best >= streak_days
    AND (streak_last_day IS NULL) = (streak_days = 0)
    AND (streak_week IS NULL) = (streak_week_days = 0)
    AND (streak_week IS NULL OR extract(dow FROM streak_week) = 0)
  );

-- Down Migration

ALTER TABLE users
  DROP CONSTRAINT users_streak_check,
  DROP COLUMN streak_week_days,
  DROP COLUMN streak_week,
  DROP COLUMN streak_last_day,
  DROP COLUMN streak_best,
  DROP COLUMN streak_days;
