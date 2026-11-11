// Data for the admin pages. /admin-dashboard: GET /admin/overview when the page opens and then every minute,
// and GET /admin/players again whenever the search changes (after a short pause, so typing doesn't send a
// request per letter). /admin-monitoring (D-036): GET /admin/monitoring once, and GET /admin/db every 30 s while
// the page is on top.
// The API checks the admin role on all of them; this file only fetches.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from 'expo-router';
import { ApiError, apiFetch } from '../api';
import type {
  AdminActivity,
  AdminDbHealth,
  AdminMonitoring,
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
// The database card is a live status light, so it asks more often than the overview. One cheap request.
const DB_REFRESH_MS = 30_000;
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

// How players use the app, and the orders and confirm popup behind it (D-036). Daily totals that change slowly,
// so it loads once when the page opens. `reload` is for the retry button.
export function useAdminMonitoring() {
  const [state, setState] = useState<State<AdminMonitoring>>({ data: null, error: null, isLoading: true });
  const alive = useRef(true);   // false after the page closes, so a late answer doesn't set state

  // The request alone. The first load needs no "loading" set (the state starts in it); the retry sets it first.
  const load = useCallback(
    () =>
      apiFetch<AdminMonitoring>('/admin/monitoring')
        .then((data) => {
          if (alive.current) setState({ data, error: null, isLoading: false });
        })
        .catch((e) => {
          console.error('Could not load the monitoring numbers', e);
          if (alive.current) setState((s) => ({ ...s, error: 'לא הצלחנו לטעון את נתוני הניטור', isLoading: false }));
        }),
    [],
  );

  const reload = useCallback(() => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    void load();
  }, [load]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  return { ...state, reload };
}

// The database's health, every 30 s while the page is open, on top and visible. A hidden tab or an app in the
// background stops asking (react-native-web reports a hidden tab as 'background'), and coming back asks at once.
// So does leaving the page: on the web the stack keeps a page mounted, hidden, under the one a tab opened, so
// without the focus check a page left through the top bar would go on asking, one more poller per visit.
// A failed check clears the numbers rather than showing the last good ones as if they were live. Most failures
// mean the database or server can't be reached: the admin check itself needs the database, so when Postgres is
// down this request fails too, and that failure is the signal. A 401 or 403 (`denied`) is different: the server
// refused this caller (the admin role was removed, or the session ended), so the database did answer.
export function useAdminDb() {
  const [state, setState] = useState<State<AdminDbHealth> & { denied: boolean }>({
    data: null, error: null, denied: false, isLoading: true,
  });
  const focused = useIsFocused();

  useEffect(() => {
    if (!focused) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const check = async () => {
      setState((s) => ({ ...s, isLoading: true }));
      try {
        const data = await apiFetch<AdminDbHealth>('/admin/db');
        if (alive) setState({ data, error: null, denied: false, isLoading: false });
      } catch (e) {
        console.error('Could not check the database', e);
        const denied = e instanceof ApiError && (e.status === 401 || e.status === 403);
        if (alive) setState({ data: null, error: dbErrorText(e), denied, isLoading: false });
      }
    };
    const start = () => {
      if (timer) return;
      check();
      timer = setInterval(check, DB_REFRESH_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (s) => (s === 'active' ? start() : stop()));
    return () => {
      alive = false;
      stop();
      sub.remove();
    };
  }, [focused]);

  return state;
}

// Why the database check failed, in one short line for the card: the server's own answer when there was one.
function dbErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    const reason = (e.body as { error?: unknown } | null)?.error;
    return `השרת ענה ${e.status}${typeof reason === 'string' ? ` · ${reason}` : ''}`;
  }
  if (e instanceof Error && e.name === 'AbortError') return 'השרת לא ענה תוך 10 שניות';
  return `הבקשה לא הגיעה לשרת${e instanceof Error ? ` · ${e.message}` : ''}`;
}
