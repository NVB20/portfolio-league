// Data for the users page (/admin-users, D-044). GET /admin/users again whenever the search, the order, the filter
// or the page changes (a typed search after a short pause, so typing doesn't send a request per letter), and
// PATCH /admin/users/:uid for a role change. The API checks the admin role on both; this file only fetches.

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../api';
import type { AdminRoleError, AdminRoleResult, AdminUser, AdminUsers, AdminUsersSort } from '../../api/src/contract';

const SEARCH_PAUSE_MS = 300;

export type UsersQuery = { q: string; sort: AdminUsersSort; adminsOnly: boolean; page: number };

// The query string, built by hand: URLSearchParams is incomplete on some React Native engines.
function usersPath({ q, sort, adminsOnly, page }: UsersQuery): string {
  const parts = [`sort=${sort}`];
  const term = q.trim();
  if (term) parts.push(`q=${encodeURIComponent(term)}`);
  if (adminsOnly) parts.push('role=admin');
  if (page > 1) parts.push(`page=${page}`);
  return `/admin/users?${parts.join('&')}`;
}

// loadedAt: when `data` arrived (ms), the "now" the table's "last seen" is measured from, so a render reads no clock.
type State = { data: AdminUsers | null; loadedAt: number; error: string | null; isLoading: boolean };

export function useAdminUsers(query: UsersQuery) {
  const [state, setState] = useState<State>({ data: null, loadedAt: 0, error: null, isLoading: true });
  const [attempt, setAttempt] = useState(0);   // bumped by `reload`, to ask again with the same query
  const path = usersPath(query);
  const typed = query.q.trim() !== '';

  useEffect(() => {
    let current = true;   // a newer query replaces this one; its late answer is ignored
    setState((s) => ({ ...s, isLoading: true, error: null }));
    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch<AdminUsers>(path);
        if (current) setState({ data, loadedAt: Date.now(), error: null, isLoading: false });
      } catch (e) {
        console.error('Could not load the users', e);
        if (current) setState((s) => ({ ...s, error: 'לא הצלחנו לטעון את המשתמשים', isLoading: false }));
      }
    }, typed ? SEARCH_PAUSE_MS : 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [path, typed, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // After a role change: the row shows the user as the API returned them, without loading the page again.
  const replace = useCallback((user: AdminUser) => {
    setState((s) => (s.data ? { ...s, data: { ...s.data, users: s.data.users.map((u) => (u.uid === user.uid ? user : u)) } } : s));
  }, []);

  return { ...state, reload, replace };
}

// PATCH /admin/users/:uid. One change at a time. `change` resolves true when the API made it (or there was nothing
// to change), false with `error` set when it refused or failed; the popup stays open to show why.
export function useRoleChange(onChanged: (user: AdminUser) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = useCallback(
    async (uid: string, admin: boolean): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const result = await apiFetch<AdminRoleResult>(`/admin/users/${encodeURIComponent(uid)}`, {
          method: 'PATCH',
          body: JSON.stringify({ admin }),
        });
        onChanged(result.user);
        return true;
      } catch (e) {
        console.error('Could not change the role', e);
        setError(roleErrorText(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const clearError = useCallback(() => setError(null), []);
  return { busy, error, change, clearError };
}

// The API's own Hebrew reason when it gave one (SELF_DEMOTE, USER_NOT_FOUND); a 403 means this admin lost the role.
function roleErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    const reason = (e.body as Partial<AdminRoleError> | null)?.reason;
    if (reason) return reason;
    if (e.status === 403) return 'כבר אין לך הרשאת ניהול. רעננו את העמוד.';
  }
  return 'השינוי לא נשמר. בדקו את החיבור ונסו שוב.';
}
