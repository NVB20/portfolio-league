-- Up Migration

-- The tables the leaderboard reads (Phase 4a, D-032). The scoring mechanism (Phase 4b, its own session) fills
-- them; the API only reads them. This migration fixes their shape and the indexes the reads need:
--   - standings: one player per place per day (no shared places, D-032), and a (uid, day) index for
--     "my rows this week" (the rank change since yesterday, the daily scores)
--   - weekly_scores: the final board of each closed week, one row per ranked player, written once by 4b
-- Every read is an index lookup: top N and "around me" by (day, rank), the player count by max(rank).

-- No two players can hold the same place on the same day (D-032). Say so clearly if old rows break that.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM standings GROUP BY day, rank HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'standings has two players on the same place of a day; fix those rows first (in a test database: TRUNCATE standings)';
  END IF;
END $$;

-- ---------- standings ----------

-- Replaces the plain (day, rank) index: the same order, now unique. DEFERRABLE (initially immediate) means it is
-- checked at the end of each statement, not row by row, so one UPDATE that swaps two players' places works.
DROP INDEX standings_day_rank_idx;
ALTER TABLE standings ADD CONSTRAINT standings_day_rank_key UNIQUE (day, rank) DEFERRABLE;

-- A player's rows this week. The (day, uid) primary key can't serve "uid = $1 AND day BETWEEN ...":
-- Postgres 17 has no skip scan, so it would walk every row of those days.
CREATE INDEX standings_uid_day_idx ON standings (uid, day);

-- ---------- weekly_scores ----------

-- The final board of each closed week (D-032): a copy of the week's last standings day, written once by the
-- scoring mechanism at the week's last event and never updated. Past weeks on the leaderboard read it.
CREATE TABLE weekly_scores (
  week_start       DATE NOT NULL CHECK (extract(isodow FROM week_start) = 1),   -- the week's Monday (Israel date)
  uid              TEXT NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  return_pct       NUMERIC(10, 4) NOT NULL,                                      -- the week's return, 2.35 = +2.35%
  max_drawdown_pct NUMERIC(10, 4) NOT NULL CHECK (max_drawdown_pct >= 0),
  return_rank      NUMERIC(6, 2) NOT NULL CHECK (return_rank BETWEEN 0 AND 100),
  stability_rank   NUMERIC(6, 2) NOT NULL CHECK (stability_rank BETWEEN 0 AND 100),
  score            NUMERIC(6, 2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  rank             INTEGER NOT NULL CHECK (rank > 0),                            -- the final place, 1..N
  PRIMARY KEY (week_start, uid),
  -- One player per place, and the index for the week's table and its player count (max(rank)).
  CONSTRAINT weekly_scores_week_rank_key UNIQUE (week_start, rank)
);

-- A player's past weeks, newest first.
CREATE INDEX weekly_scores_uid_week_idx ON weekly_scores (uid, week_start);

-- Down Migration

DROP TABLE weekly_scores;

DROP INDEX standings_uid_day_idx;
ALTER TABLE standings DROP CONSTRAINT standings_day_rank_key;
CREATE INDEX standings_day_rank_idx ON standings (day, rank);
