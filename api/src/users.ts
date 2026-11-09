// SQL for the `users` table. The uid and email always come from the verified token, never the request body.

import type { Pool } from 'pg';

export type Theme = 'dark' | 'light';
export type Role = 'admin' | 'user';

// What the app gets back about the logged-in user.
export type Me = { email: string; roles: Role[]; theme: Theme };

// First login: creates the row as a normal user, and the player's portfolio with the starting cash (D-008),
// recorded in the ledger as a 'start' journal: cash_free +cash, capital −cash (D-019).
// Later logins: keeps the rows and refreshes the email (and the name, when the token has one).
// ON CONFLICT makes this safe to call twice, or from two tabs at the same moment: the journal is written
// only when the portfolio row was really inserted.
// `roles` is never written here, so the column default ('{user}') is the only way a row gets roles.
// One statement = one transaction, so a user never exists without a portfolio and its starting cash.
export async function upsertUser(db: Pool, uid: string, email: string, name: string | null = null): Promise<Me> {
  const { rows } = await db.query<Me>(
    `WITH u AS (
       INSERT INTO users (uid, email, display_name) VALUES ($1, $2, $3)
       ON CONFLICT (uid) DO UPDATE
         SET email = EXCLUDED.email,
             display_name = COALESCE(EXCLUDED.display_name, users.display_name)
       RETURNING uid, email, roles, theme
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
     SELECT email, roles, theme FROM u`,
    [uid, email, name],
  );
  return rows[0];
}

// Changes only the theme column. Returns null if the user has no row yet.
export async function setTheme(db: Pool, uid: string, theme: Theme): Promise<Me | null> {
  const { rows } = await db.query<Me>(
    `UPDATE users SET theme = $2 WHERE uid = $1 RETURNING email, roles, theme`,
    [uid, theme],
  );
  return rows[0] ?? null;
}
