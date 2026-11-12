// SQL for the `users` table. The uid and email always come from the verified token, never the request body.

import type { Pool } from 'pg';
import type { OnboardingFlow } from './contract.js';

export type Theme = 'dark' | 'light';
export type Role = 'admin' | 'user';

// What the app gets back about the logged-in user. onboardedAt / adminOnboardedAt: when the player / admin
// walkthrough was finished or skipped (D-040), an ISO instant in real time; null = not seen yet, so the app shows it.
export type Me = {
  email: string;
  roles: Role[];
  theme: Theme;
  onboardedAt: string | null;
  adminOnboardedAt: string | null;
};

// The columns every query below returns, as pg gives them (TIMESTAMPTZ arrives as a Date).
type MeRow = {
  email: string;
  roles: Role[];
  theme: Theme;
  onboarded_at: Date | null;
  admin_onboarded_at: Date | null;
};

function toMe(r: MeRow): Me {
  return {
    email: r.email,
    roles: r.roles,
    theme: r.theme,
    onboardedAt: r.onboarded_at?.toISOString() ?? null,
    adminOnboardedAt: r.admin_onboarded_at?.toISOString() ?? null,
  };
}

// First login: creates the row as a normal user, and the player's portfolio with the starting cash (D-008),
// recorded in the ledger as a 'start' journal: cash_free +cash, capital −cash (D-019).
// Later logins: keeps the rows and refreshes the email (and the name, when the token has one).
// ON CONFLICT makes this safe to call twice, or from two tabs at the same moment: the journal is written
// only when the portfolio row was really inserted.
// `roles` is never written here, so the column default ('{user}') is the only way a row gets roles.
// One statement = one transaction, so a user never exists without a portfolio and its starting cash.
export async function upsertUser(db: Pool, uid: string, email: string, name: string | null = null): Promise<Me> {
  const { rows } = await db.query<MeRow>(
    `WITH u AS (
       INSERT INTO users (uid, email, display_name) VALUES ($1, $2, $3)
       ON CONFLICT (uid) DO UPDATE
         SET email = EXCLUDED.email,
             display_name = COALESCE(EXCLUDED.display_name, users.display_name)
       RETURNING uid, email, roles, theme, onboarded_at, admin_onboarded_at
     ), p AS (
       INSERT INTO portfolios (uid) SELECT uid FROM u ON CONFLICT (uid) DO NOTHING RETURNING uid, cash
     ), j AS (
       INSERT INTO journals (uid, kind) SELECT uid, 'start' FROM p RETURNING id, uid
     ), e AS (
       INSERT INTO ledger_entries (journal_id, uid, account, amount)
       SELECT j.id, j.uid, a.account, a.amount
       FROM j JOIN p ON p.uid = j.uid
       CROSS JOIN LATERAL (VALUES ('cash_free', p.cash), ('capital', -p.cash)) AS a (account, amount)
     )
     SELECT email, roles, theme, onboarded_at, admin_onboarded_at FROM u`,
    [uid, email, name],
  );
  return toMe(rows[0]);
}

// Changes only the theme column. Returns null if the user has no row yet.
export async function setTheme(db: Pool, uid: string, theme: Theme): Promise<Me | null> {
  const { rows } = await db.query<MeRow>(
    `UPDATE users SET theme = $2 WHERE uid = $1
     RETURNING email, roles, theme, onboarded_at, admin_onboarded_at`,
    [uid, theme],
  );
  return rows[0] ? toMe(rows[0]) : null;
}

export type OnboardingResult = { me: Me } | { error: 'no_user' | 'not_admin' };

// The app finished or skipped a walkthrough (D-040). Sets the flow's column the first time; later calls keep the
// first time (COALESCE), so a repeat is harmless. The admin check is in the same UPDATE's WHERE: a user without the
// admin role matches no row, so nothing is written. Only then a second read tells "no row" from "not an admin".
export async function markOnboarded(db: Pool, uid: string, flow: OnboardingFlow): Promise<OnboardingResult> {
  const { rows } = await db.query<MeRow>(
    `UPDATE users
     SET onboarded_at       = CASE WHEN $2::text = 'player' THEN COALESCE(onboarded_at, now()) ELSE onboarded_at END,
         admin_onboarded_at = CASE WHEN $2::text = 'admin' THEN COALESCE(admin_onboarded_at, now()) ELSE admin_onboarded_at END
     WHERE uid = $1 AND ($2::text = 'player' OR 'admin' = ANY(roles))
     RETURNING email, roles, theme, onboarded_at, admin_onboarded_at`,
    [uid, flow],
  );
  if (rows[0]) return { me: toMe(rows[0]) };
  const exists = await db.query(`SELECT 1 FROM users WHERE uid = $1`, [uid]);
  return { error: exists.rowCount ? 'not_admin' : 'no_user' };
}
