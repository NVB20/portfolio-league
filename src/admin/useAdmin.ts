// Data for the admin page: GET /admin/overview when the page opens and then every minute, and
// GET /admin/players again whenever the search changes (after a short pause, so typing doesn't send a
// request per letter).
// The API checks the admin role on both; this file only fetches.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../api';
import type {
  AdminActivity,
  AdminOverview,
  AdminPlayers,
  ClockActionError,
  ClockAdvanceBody,
  ClockAdvanceResult,
  ClockStartResult,
  ClockStopResult,
} from '../../api/src/contract';

const SEARCH_PAUSE_MS = 300;
const REFRESH_MS = 60_000;
// A jump runs every open and close on the way, for every affected player. Give it longer than a normal read.
const CLOCK_TIMEOUT_MS = 120_000;

export type ClockMove = 'advance' | 'start' | 'stop';
export type ClockOutcome =
  | { move: 'advance'; result: ClockAdvanceResult }
  | { move: 'start'; result: ClockStartResult }
  | { move: 'stop'; result: ClockStopResult };

// POST /admin/clock/{advance,start,stop}. One move at a time; `onDone` reloads the page's numbers after
// any answer, good or bad, because the clock may have moved even when the answer got lost.
// Advance sends `from`: the world time the page showed. If an open or close ran since then (a retried click
// after a lost answer, or the ticker), the API answers 409 CLOCK_MOVED and nothing jumps twice.
export function useClockAction(onDone: () => void) {
  const [busy, setBusy] = useState<ClockMove | null>(null);
  const [outcome, setOutcome] = useState<ClockOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (move: ClockMove, body?: ClockAdvanceBody) => {
      setBusy(move);
      setError(null);
      setOutcome(null);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CLOCK_TIMEOUT_MS);
      try {
        const result = await apiFetch<ClockAdvanceResult & ClockStartResult & ClockStopResult>(`/admin/clock/${move}`, {
          method: 'POST',
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        setOutcome({ move, result } as ClockOutcome);
      } catch (e) {
        console.error(`Clock ${move} failed`, e);
        const reason = e instanceof ApiError ? (e.body as Partial<ClockActionError> | null)?.reason : undefined;
        setError(reason ?? 'הפעולה לא הצליחה. רעננו את העמוד ובדקו את השעון לפני שמנסים שוב.');
      } finally {
        clearTimeout(timer);
        setBusy(null);
        onDone();
      }
    },
    [onDone],
  );

  return { busy, outcome, error, run };
}

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
