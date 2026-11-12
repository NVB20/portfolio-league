-- Up Migration

-- The first-login walkthroughs (D-040): when the player finished or skipped the player walkthrough, and when an
-- admin finished or skipped the admin walkthrough. Stored on the server, not in the browser, so a new device or a
-- cleared browser doesn't show it again. NULL = not seen yet, so every existing user sees each one once.
-- Written only by POST /me/onboarding/seen, which keeps the first time (COALESCE). The admin one only for a user
-- with the admin role.

ALTER TABLE users
  ADD COLUMN onboarded_at       TIMESTAMPTZ,   -- the player walkthrough, real time; NULL = not seen yet
  ADD COLUMN admin_onboarded_at TIMESTAMPTZ;   -- the admin walkthrough, real time; NULL = not seen yet

-- Down Migration

ALTER TABLE users
  DROP COLUMN admin_onboarded_at,
  DROP COLUMN onboarded_at;
