// Loads GET /me/dashboard once when the screen opens. `reload()` fetches it again
// (after the error state's "try again", and later after sending an order or advancing the clock).

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import type { Dashboard } from '../../api/src/contract';

type State = { data: Dashboard | null; error: string | null; isLoading: boolean };

export function useDashboard() {
  const [state, setState] = useState<State>({ data: null, error: null, isLoading: true });
  const alive = useRef(true);   // false after the screen closes, so a late answer doesn't set state

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const data = await apiFetch<Dashboard>('/me/dashboard');
      if (alive.current) setState({ data, error: null, isLoading: false });
    } catch (e) {
      console.error('Could not load the dashboard', e);
      // Keep the last good data on screen if we had some; only show the error state when we have nothing.
      if (alive.current) setState((s) => ({ ...s, error: 'לא הצלחנו לטעון את התיק', isLoading: false }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  return { ...state, reload };
}
