// The admin users page (D-044): GET /admin/users lists every user a page at a time, PATCH /admin/users/:uid gives or
// takes away the admin role. Admins only (requireAdmin runs before both). Real time; the world clock plays no part.
//
// The list reads only `users`: the visits are the stored users.visits that the check-in keeps (D-026), never counted
// from app_opens here. No index serves the orders (see the migration): one page is one pass over `users` for its exact
// total and one top-N sort, which is fine for a page only admins open (measured in D-044).
//
// A role change is one transaction that locks the caller's row and the target's, in uid order, and then checks again
// that the caller is still an admin. Two admins taking each other's role at the same moment therefore run one after
// the other, and the second finds it is no longer an admin: there is always an admin left. Every change writes one
// admin_actions row in the same transaction (D-027); a request that changes nothing writes nothing.

import type { Pool } from 'pg';
import type { AdminRoleError, AdminUser, AdminUsers, AdminUsersSort } from './contract.js';

export const USERS_PAGE_SIZE = 50;
const MAX_SEARCH = 100;     // as the players search: any email fits, the ILIKE stays cheap
const MAX_PAGE = 9_999_999; // the offset (page × 50) stays far inside an INTEGER
const MAX_UID = 128;        // Firebase uids are at most 128 characters

const SORTS: AdminUsersSort[] = ['visits', 'lastSeen', 'joined'];

// Whitelisted ORDER BY per sort: never built from the request's text.
const ORDER_BY: Record<AdminUsersSort, string> = {
  visits: 'visits DESC, uid',
  lastSeen: 'last_seen_at DESC NULLS LAST, uid',
  joined: 'created_at DESC, uid',
};

export type AdminUsersQuery = { q: string | null; sort: AdminUsersSort; adminsOnly: boolean; page: number };

// ?q= (name or email, up to 100 characters), ?sort=visits|lastSeen|joined (default joined: newest first),
// ?role=admin (admins only; nothing else is allowed), ?page= (from 1).
export function parseAdminUsersQuery(raw: {
  q?: string;
  sort?: string;
  role?: string;
  page?: string;
}): { ok: true; query: AdminUsersQuery } | { ok: false; error: string } {
  const q = (raw.q ?? '').trim();
  if (q.length > MAX_SEARCH) return { ok: false, error: `q must be at most ${MAX_SEARCH} characters` };
  const sort = (raw.sort ?? 'joined') as AdminUsersSort;
  if (!SORTS.includes(sort)) return { ok: false, error: 'sort must be "visits", "lastSeen" or "joined"' };
  if (raw.role !== undefined && raw.role !== 'admin') return { ok: false, error: 'role must be "admin" when given' };
  const pageText = raw.page ?? '1';
  const page = /^[1-9]\d{0,6}$/.test(pageText) ? Number(pageText) : NaN;
  if (!(page <= MAX_PAGE)) return { ok: false, error: `page must be a whole number from 1 to ${MAX_PAGE}` };
  return { ok: true, query: { q: q === '' ? null : q, sort, adminsOnly: raw.role === 'admin', page } };
}

// A uid from the path: non-empty and at most 128 characters. It only ever reaches SQL as a parameter.
export function isUid(uid: string): boolean {
  return uid.length > 0 && uid.length <= MAX_UID;
}

// PATCH body: { "admin": true | false }. Any other field is ignored, so roles can't be written as a list.
export function parseRoleBody(body: unknown): { ok: true; admin: boolean } | { ok: false; error: string } {
  const admin = (body as { admin?: unknown } | null)?.admin;
  if (typeof admin !== 'boolean') return { ok: false, error: 'admin must be true or false' };
  return { ok: true, admin };
}

// ---------- GET /admin/users ----------

type UserRow = {
  uid: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  visits: number;
  last_seen_at: Date | null;
  created_at: Date;
};

const USER_COLUMNS = `uid, email, display_name, 'admin' = ANY(roles) AS is_admin, visits, last_seen_at, created_at`;

function toUser(r: UserRow): AdminUser {
  return {
    uid: r.uid,
    email: r.email,
    name: r.display_name,
    isAdmin: r.is_admin,
    visits: r.visits,
    lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    joinedAt: r.created_at.toISOString(),
  };
}

// Two statements, one after the other on the pool (one connection at a time): the total, then the page.
// A user who signs up between them can shift a row; the next load shows it.
export async function getAdminUsers(db: Pool, query: AdminUsersQuery): Promise<AdminUsers> {
  // ILIKE treats % and _ as wildcards; escape them (and the escape character) so they match themselves.
  const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : null;
  const where = `($1::text IS NULL OR display_name ILIKE $1 OR email ILIKE $1) AND (NOT $2::boolean OR 'admin' = ANY(roles))`;
  const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE ${where}`, [
    pattern,
    query.adminsOnly,
  ]);
  const { rows } = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE ${where}
     ORDER BY ${ORDER_BY[query.sort]}
     LIMIT $3 OFFSET $4`,
    [pattern, query.adminsOnly, USERS_PAGE_SIZE, (query.page - 1) * USERS_PAGE_SIZE],
  );
  return { users: rows.map(toUser), total: total.rows[0].n, page: query.page, pageSize: USERS_PAGE_SIZE };
}

// ---------- PATCH /admin/users/:uid ----------

export type RoleOutcome =
  | { status: 200; body: { user: AdminUser; changed: boolean } }
  | { status: 403; body: { error: string } }
  | { status: 404 | 409; body: AdminRoleError };

export async function setAdminRole(db: Pool, callerUid: string, targetUid: string, admin: boolean): Promise<RoleOutcome> {
  if (callerUid === targetUid && !admin) {
    return {
      status: 409,
      body: { error: 'an admin cannot remove their own admin role', code: 'SELF_DEMOTE', reason: 'אי אפשר להסיר את הרשאת הניהול של עצמך.' },
    };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Both rows in uid order, so two changes that touch the same two users can't deadlock. FOR NO KEY UPDATE, as
    // the check-in takes (D-026): only `roles` changes, never the key, so the runner's FOR KEY SHARE never waits.
    // After a wait, Postgres hands back the row as the other transaction left it, so the check below sees a role
    // that was taken away a moment ago.
    const { rows } = await client.query<{ uid: string; is_admin: boolean }>(
      `SELECT uid, 'admin' = ANY(roles) AS is_admin FROM users WHERE uid = ANY($1::text[]) ORDER BY uid FOR NO KEY UPDATE`,
      [[callerUid, targetUid]],
    );
    const caller = rows.find((r) => r.uid === callerUid);
    const target = rows.find((r) => r.uid === targetUid);
    if (!caller?.is_admin) {
      await client.query('ROLLBACK');
      return { status: 403, body: { error: 'admins only' } };
    }
    if (!target) {
      await client.query('ROLLBACK');
      return { status: 404, body: { error: 'user not found', code: 'USER_NOT_FOUND', reason: 'המשתמש לא נמצא.' } };
    }

    if (target.is_admin === admin) {
      const same = await client.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE uid = $1`, [targetUid]);
      await client.query('COMMIT');
      return { status: 200, body: { user: toUser(same.rows[0]), changed: false } };
    }

    // Grant puts 'admin' first, as POST /me/admin does (D-043). Revoke keeps at least 'user': the CHECK forbids an
    // empty list, and a row made '{admin}' by hand would otherwise have none left.
    const { rows: updated } = await client.query<UserRow>(
      `UPDATE users
       SET roles = CASE WHEN $2 THEN ARRAY['admin'] || roles
                        WHEN cardinality(array_remove(roles, 'admin')) = 0 THEN ARRAY['user']
                        ELSE array_remove(roles, 'admin') END
       WHERE uid = $1
       RETURNING ${USER_COLUMNS}`,
      [targetUid, admin],
    );
    await client.query(
      `INSERT INTO admin_actions (uid, action, detail) VALUES ($1, $2, jsonb_build_object('target', $3::text, 'email', $4::text))`,
      [callerUid, admin ? 'role_grant' : 'role_revoke', targetUid, updated[0].email],
    );
    await client.query('COMMIT');
    return { status: 200, body: { user: toUser(updated[0]), changed: true } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
