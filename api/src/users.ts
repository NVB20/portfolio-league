// SQL for the `users` table. The uid and email always come from the verified token, never the request body.

import type { Pool } from 'pg';

export type Theme = 'dark' | 'light';
export type Role = 'admin' | 'user';

// What the app gets back about the logged-in user.
export type Me = { email: string; roles: Role[]; theme: Theme };

// First login: creates the row as a normal user. Later logins: keeps the row and refreshes the email.
// ON CONFLICT makes this safe to call twice, or from two tabs at the same moment.
// `roles` is never written here, so the column default ('{user}') is the only way a row gets roles.
export async function upsertUser(db: Pool, uid: string, email: string): Promise<Me> {
  const { rows } = await db.query<Me>(
    `INSERT INTO users (uid, email) VALUES ($1, $2)
     ON CONFLICT (uid) DO UPDATE SET email = EXCLUDED.email
     RETURNING email, roles, theme`,
    [uid, email],
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
