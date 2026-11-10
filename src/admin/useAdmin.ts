// Data for the admin page: GET /admin/overview when the page opens and then every minute, and
// GET /admin/players again whenever the search changes (after a short pause, so typing doesn't send a
// request per letter).
// The API checks the admin role on both; this file only fetches.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import type { AdminActivity, AdminOverview, AdminPlayers } from '../../api/src/contract';

const SEARCH_PAUSE_MS = 300;
const REFRESH_MS = 60_000;

type State<T> = { data: T | null; error: string | null; isLoading: boolean };

export function useAdminOverview() {
  const [state, setState] = useState<State<AdminOverview>>({ data: null, error: null, isLoading: true });
  const alive = useRef(true);   // false after the page closes, so a late answer doesn't set state

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const data = await apiFetch<AdminOverview>('/admin/overview');
      if (alive.current) setState({ data, error: null, isLoading: false });
    } catch (e) {
      console.error('Could not load the admin overview', e);
      if (alive.current) setState((s) => ({ ...s, error: 'לא הצלחנו לטעון את לוח הניהול', isLoading: false }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    reload();
    // Keep "online now" live while the page is open. The last good numbers stay on screen meanwhile.
    const timer = setInterval(reload, REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [reload]);

  return { ...state, reload };
}

// The last 30 days of activity and the day-1 / day-7 return. Changes slowly, so it loads once.
export function useAdminActivity() {
  const [state, setState] = useState<State<AdminActivity>>({ data: null, error: null, isLoading: true });
  useEffect(() => {
    let alive = true;
    apiFetch<AdminActivity>('/admin/activity')
      .then((data) => alive && setState({ data, error: null, isLoading: false }))
      .catch((e) => {
        console.error('Could not load the activity', e);
        if (alive) setState({ data: null, error: 'לא הצלחנו לטעון את המגמה', isLoading: false });
      });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

export function useAdminPlayers(query: string) {
  const [state, setState] = useState<State<AdminPlayers>>({ data: null, error: null, isLoading: true });

  useEffect(() => {
    let current = true;   // a newer search replaces this one; its late answer is ignored
    setState((s) => ({ ...s, isLoading: true, error: null }));
    const q = query.trim();
    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch<AdminPlayers>(`/admin/players${q ? `?q=${encodeURIComponent(q)}` : ''}`);
        if (current) setState({ data, error: null, isLoading: false });
      } catch (e) {
        console.error('Could not load the players', e);
        if (current) setState((s) => ({ ...s, error: 'לא הצלחנו לטעון את השחקנים', isLoading: false }));
      }
    }, q ? SEARCH_PAUSE_MS : 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);

  return state;
}
