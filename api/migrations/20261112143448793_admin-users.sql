-- Up Migration

-- The admin users page (D-044): every user with their visits, and admins can give or take the admin role.

-- Visits since the user signed up (D-026), kept by POST /me/seen: the check-in that starts a visit adds 1 in the
-- same transaction that writes its app_opens row, so the two always agree. Stored rather than counted, so the users
-- page can sort by it while reading only `users`, not every visit ever made (like the stored balances, D-019).
-- No index: the check-in rewrites every index on `users` once a minute per player online (last_seen_at is indexed,
-- so those updates are never HOT), and the page reads every row for its exact total anyway (D-044).
ALTER TABLE users ADD COLUMN visits INTEGER NOT NULL DEFAULT 0 CHECK (visits >= 0);

-- The visits made before this column existed.
UPDATE users u SET visits = o.n
FROM (SELECT uid, count(*)::int AS n FROM app_opens GROUP BY uid) o
WHERE o.uid = u.uid;

-- Role changes join the admin action log, written in the same transaction as the change (D-027).
-- detail = { "target": the user's uid, "email": their email }.
ALTER TABLE admin_actions DROP CONSTRAINT admin_actions_action_check;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_action_check
  CHECK (action IN ('clock_to_close', 'clock_to_open', 'clock_start', 'clock_stop', 'role_grant', 'role_revoke'));

-- Down Migration

DELETE FROM admin_actions WHERE action IN ('role_grant', 'role_revoke');
ALTER TABLE admin_actions DROP CONSTRAINT admin_actions_action_check;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_action_check
  CHECK (action IN ('clock_to_close', 'clock_to_open', 'clock_start', 'clock_stop'));
ALTER TABLE users DROP COLUMN visits;
